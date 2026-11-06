import { test } from "node:test";
import assert from "node:assert/strict";
import handler from "../api/releases.js";

function fakeRes() {
  const res = { headers: {}, code: 0, body: null };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = (c) => { res.code = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
const release = (tag, size, pre = false) => ({ tag_name: tag, prerelease: pre, html_url: `https://g/${tag}`, published_at: "2026-11-06T00:00:00Z",
  assets: [{ name: tag.startsWith("standalone") ? "LocationSpooferStandalone.exe" : "LocationSpooferBrowser.exe", size, browser_download_url: `https://g/${tag}.exe` }] });

test("GET /api/releases answers the latest stable versions, cached at the edge", async () => {
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push(opts.headers.Authorization || "none"); return new Response(JSON.stringify([
    release("standalone-v0.2.30-dev", 1, true), release("standalone-v0.2.29", 15500000), release("browser-v1.3.29", 81000000)])); };
  delete process.env.GITHUB_TOKEN;
  const res = fakeRes();
  await handler({}, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.standalone.version, "0.2.29");
  assert.equal(res.body.browser.size, 81000000);
  assert.match(res.headers["cache-control"], /s-maxage=300/);
  assert.deepEqual(calls, ["none"]);
});

test("a rejected token falls back to an anonymous request", async () => {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(opts.headers.Authorization ? "token" : "anon");
    return opts.headers.Authorization ? new Response("bad credentials", { status: 401 }) : new Response(JSON.stringify([release("standalone-v0.2.29", 1)]));
  };
  process.env.GITHUB_TOKEN = "stale";
  const res = fakeRes();
  await handler({}, res);
  delete process.env.GITHUB_TOKEN;
  assert.equal(res.code, 200);
  assert.deepEqual(calls, ["token", "anon"]);
});

test("GitHub errors become a 502 that is not cached", async () => {
  globalThis.fetch = async () => new Response("rate limited", { status: 403 });
  const res = fakeRes();
  await handler({}, res);
  assert.equal(res.code, 502);
  assert.equal(res.headers["cache-control"], "no-store");
});
