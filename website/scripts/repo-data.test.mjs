import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, rewriteHref } from "./repo-data.mjs";
import { pickReleases } from "../src/lib/release-pick.js";

test("links between the documents become site pages", () => {
  assert.equal(rewriteHref("PRIVACY.md"), "/privacy");
  assert.equal(rewriteHref("./TERMS.md#use"), "/terms#use");
  assert.equal(rewriteHref("LICENSE"), "/licence");
  assert.equal(rewriteHref("THIRD_PARTY_NOTICES.md"), "/third-party-notices");
});

test("other repository paths go to GitHub, absolute links stay", () => {
  assert.equal(rewriteHref("browser/LICENSE"), "https://github.com/YK3D/iPhone-location-spoofer/blob/main/browser/LICENSE");
  assert.equal(rewriteHref("https://openfreemap.org"), "https://openfreemap.org");
  assert.equal(rewriteHref("#troubleshooting"), "#troubleshooting");
});

test("rendered markdown has heading ids, external links open in a new tab, tables scroll", () => {
  const html = renderMarkdown("## What it does\n\nSee [Privacy](PRIVACY.md) and [OSM](https://osm.org).\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
  assert.match(html, /<h2 id="what-it-does">/);
  assert.match(html, /<a href="\/privacy">Privacy<\/a>/);
  assert.match(html, /<a href="https:\/\/osm.org" target="_blank" rel="noreferrer">/);
  assert.match(html, /<div class="table-wrap"><table>/);
});

test("the latest stable release of each edition is picked, pre-releases skipped", () => {
  const asset = (name, size) => ({ name, size, browser_download_url: `https://x/${name}` });
  const list = [
    { tag_name: "standalone-v0.2.20-dev", prerelease: true, assets: [asset("LocationSpooferStandalone.exe", 1)] },
    { tag_name: "standalone-v0.2.19", prerelease: false, html_url: "p", published_at: "t", assets: [asset("LocationSpooferStandalone.exe", 15000000), asset("LocationSpooferStandalone.exe.sha256", 95)] },
    { tag_name: "browser-v1.3.19", prerelease: false, assets: [asset("LocationSpooferBrowser.exe", 81000000)] },
  ];
  const r = pickReleases(list);
  assert.equal(r.standalone.version, "0.2.19");
  assert.equal(r.standalone.size, 15000000);
  assert.equal(r.standalone.shaUrl, "https://x/LocationSpooferStandalone.exe.sha256");
  assert.equal(r.browser.version, "1.3.19");
  assert.equal(pickReleases("nope"), null);
});
