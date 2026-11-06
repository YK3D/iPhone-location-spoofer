// Short clips of the real app for the website (website/public/media). Same default look as the
// README screenshots: Graphite theme, dark OpenFreeMap map, mock device driver.
//
//   1. Start the browser edition from source with an empty data folder:
//        cd browser && SPOOFER_DATA_DIR=$(mktemp -d) python -m spoofer --port 8765 --no-browser --no-update
//   2. node website/scripts/record-clips.cjs     (needs Playwright and ffmpeg)
//
// Frames come from the Chrome DevTools screencast (sharper than Playwright's own video), each saved
// with its timestamp, then ffmpeg turns them into WebM (VP9) and MP4 (H.264) at their real timing.
// Routes come from the public OpenStreetMap router, so an internet connection is needed.
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const URL = process.env.URL || "http://127.0.0.1:8765/";
const OUT = process.env.OUT || path.join(__dirname, "..", "public", "media");
const VIEW = { width: 1280, height: 800 };
const OUT_W = 1280;
const wait = (page, ms) => page.waitForTimeout(ms);

async function setup(page) {
  await page.goto(URL);
  await wait(page, 1500);
  await page.evaluate(() => { if ($("tutorial").open) finishTutorial(); });
  await page.evaluate(() => {
    const s = settings();
    s.theme = "graphite"; s.map_theme = "dark"; s.map_provider = "openfreemap"; s.tutorial_done = true;
    applyAppearance();
  });
  if (await page.isVisible("#btn-connect")) {
    await page.evaluate(() => { $("driver").value = "mock"; $("driver").dispatchEvent(new Event("change")); });
    await page.click("#btn-connect");
    await wait(page, 900);
  }
  await page.evaluate(() => { $("sec-device").open = false; });
  await wait(page, 4000); // let the "Connected" toast go
}

async function mapIdle(page) {
  await page.waitForFunction(() => {
    const l = MAP_PROVIDERS.openfreemap.layer;
    if (!map.hasLayer(l)) return true;
    const gl = l._glLayer && l._glLayer.getMaplibreMap();
    return !!gl && gl.loaded() && gl.areTilesLoaded();
  }, null, { timeout: 30000, polling: 250 }).catch(() => {});
  await wait(page, 300);
}

// Smoothly glide the mouse, so the pointer looks like a person moving it.
async function glide(page, from, to, ms = 600) {
  const steps = Math.max(8, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) {
    const f = i / steps, e = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
    await page.mouse.move(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
    await wait(page, 16);
  }
}

async function mapPoint(page, lat, lon) {
  return page.evaluate(([la, lo]) => {
    const p = map.latLngToContainerPoint([la, lo]);
    const r = map.getContainer().getBoundingClientRect();
    return { x: r.x + p.x, y: r.y + p.y };
  }, [lat, lon]);
}

// A visible pointer: headless Chrome draws no cursor in the screencast.
async function addCursor(page) {
  await page.addStyleTag({ content: `#rec-cursor{position:fixed;z-index:2147483647;left:0;top:0;width:18px;height:18px;
    pointer-events:none;border-radius:50%;background:rgba(255,255,255,.92);box-shadow:0 0 0 1.5px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.35);
    transform:translate(-50%,-50%);transition:width .12s,height .12s}#rec-cursor.down{width:13px;height:13px}` });
  await page.evaluate(() => {
    const c = document.createElement("div"); c.id = "rec-cursor"; document.body.appendChild(c);
    addEventListener("mousemove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", () => c.classList.add("down"), true);
    addEventListener("mouseup", () => c.classList.remove("down"), true);
  });
}

async function record(page, name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `clip-${name}-`));
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on("Page.screencastFrame", async (f) => {
    const file = path.join(dir, `f${String(frames.length).padStart(5, "0")}.jpg`);
    fs.writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ file, t: f.metadata.timestamp });
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: VIEW.width, maxHeight: VIEW.height, everyNthFrame: 1 });
  const started = Date.now() / 1000;
  await body();
  const ended = Date.now() / 1000;
  await cdp.send("Page.stopScreencast");
  await wait(page, 200);
  // ffconcat with each frame shown until the next one arrives (the screencast only sends changes)
  const lines = ["ffconcat version 1.0"];
  frames.forEach((fr, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].t : Math.max(ended, fr.t + 0.04);
    lines.push(`file '${fr.file}'`, `duration ${Math.max(0.001, next - fr.t).toFixed(4)}`);
  });
  lines.push(`file '${frames[frames.length - 1].file}'`);
  const list = path.join(dir, "list.txt");
  fs.writeFileSync(list, lines.join("\n"));
  const vf = `scale=${OUT_W}:-2:flags=lanczos,fps=30,format=yuv420p`;
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", vf,
    "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "36", "-row-mt", "1", "-an", path.join(OUT, `${name}.webm`)]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", vf,
    "-c:v", "libx264", "-preset", "slow", "-crf", "27", "-movflags", "+faststart", "-an", path.join(OUT, `${name}.mp4`)]);
  // poster: the last frame
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", frames[frames.length - 1].file, "-vf", `scale=${OUT_W}:-2`,
    "-q:v", "4", path.join(OUT, `${name}.jpg`)]);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`${name}: ${frames.length} frames, ${(ended - started).toFixed(1)} s`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await setup(page);
  await addCursor(page);
  const rest = { x: VIEW.width - 160, y: 120 };
  await page.mouse.move(rest.x, rest.y);

  // 1. Teleport: pick a point near the Eiffel Tower, then jump there
  await page.evaluate(() => { map.setView([48.8584, 2.2945], 15); });
  await mapIdle(page);
  await record(page, "teleport", async () => {
    await wait(page, 500);
    const p = await mapPoint(page, 48.8606, 2.2920);
    await glide(page, rest, p, 900);
    await page.mouse.click(p.x, p.y);
    await wait(page, 700);
    const btn = await page.locator("#btn-teleport").boundingBox();
    const b = { x: btn.x + btn.width / 2, y: btn.y + btn.height / 2 };
    await glide(page, p, b, 800);
    await page.mouse.click(b.x, b.y);
    await wait(page, 2200);
  });

  // 2. Route: two checkpoints, build with progress, alternatives labelled on the map
  await page.click('.tabs button[data-tab="route"]');
  await page.evaluate(() => {
    state.waypoints = [];
    $("default-mode").value = "car"; $("default-speed").value = "40"; $("alt-count").value = "3";
    for (const id of ["default-mode", "default-speed", "alt-count"]) $(id).dispatchEvent(new Event("change"));
    $("sec-route-settings").open = false;
    $("sec-route-import").open = false;
    map.setView([51.512, -0.095], 14);
  });
  await mapIdle(page);
  await record(page, "route-build", async () => {
    await wait(page, 400);
    const a = await mapPoint(page, 51.5074, -0.1278);
    await glide(page, rest, a, 900);
    await page.mouse.click(a.x, a.y);
    await wait(page, 500);
    const b = await mapPoint(page, 51.5194, -0.0618);
    await glide(page, a, b, 900);
    await page.mouse.click(b.x, b.y);
    await wait(page, 600);
    const btn = await page.locator("#btn-build").boundingBox();
    const c = { x: btn.x + btn.width / 2, y: btn.y + btn.height / 2 };
    await glide(page, b, c, 900);
    await page.mouse.click(c.x, c.y);
    await page.waitForFunction(() => !state.building && state.built, null, { timeout: 120000 });
    await wait(page, 600);
    await glide(page, c, rest, 700);
    await mapIdle(page);
    await wait(page, 1600);
  });

  // 3. Playback: a short drive past the London Eye with the live speed and heading
  await page.evaluate(() => {
    state.waypoints = [];
    $("default-mode").value = "car"; $("default-speed").value = "50"; $("alt-count").value = "0";
    for (const id of ["default-mode", "default-speed", "alt-count"]) $(id).dispatchEvent(new Event("change"));
    map.setView([51.5035, -0.1215], 16);
    addWaypoint(51.5007, -0.1246, { name: "Westminster" });
    addWaypoint(51.5081, -0.1281, { name: "Trafalgar Square" });
    $("multiplier").value = "5"; $("multiplier").dispatchEvent(new Event("change"));
  });
  await page.click("#btn-build");
  await page.waitForFunction(() => !state.building && state.loaded === "route", null, { timeout: 120000 });
  await wait(page, 2800);
  await mapIdle(page);
  await record(page, "playback", async () => {
    await wait(page, 300);
    const btn = await page.locator("#btn-play").boundingBox();
    const p = { x: btn.x + btn.width / 2, y: btn.y + btn.height / 2 };
    await glide(page, rest, p, 900);
    await page.mouse.click(p.x, p.y);
    await wait(page, 500);
    await glide(page, p, rest, 700);
    await wait(page, 8000);
  });
  await page.click("#btn-stop").catch(() => {});

  // 4. Themes: a few of the 17 colour themes
  await record(page, "themes", async () => {
    for (const t of ["graphite", "midnight", "nord", "sand", "ocean", "dracula", "graphite"]) {
      await page.evaluate((theme) => { settings().theme = theme; applyAppearance(); }, t);
      await wait(page, 900);
    }
  });

  console.log(errors.length ? `page errors: ${JSON.stringify(errors)}` : "no page errors");
  await browser.close();
})();
