// Short clips of the real app for the website (website/public/media) and the README animation
// (docs/screenshots/demo.webp). Same default look as the README screenshots: Graphite theme, dark
// OpenFreeMap map, and the app's own simulated iPhone.
//
//   1. Start the browser edition from source with an empty data folder:
//        cd browser && SPOOFER_DATA_DIR=$(mktemp -d) python -m spoofer --port 8765 --no-browser --no-update
//   2. node website/scripts/record-clips.cjs     (needs Playwright and ffmpeg with libvpx, libx264, libwebp)
//
// Frames come from the Chrome DevTools screencast (sharper than Playwright's own video), each saved with
// its timestamp, then ffmpeg encodes them at their real timing. The pointer is drawn by the page: an
// arrow that moves with a speed ramp (fast in the middle, easing into each target) and shrinks a little
// when it presses, springing back with a slight bounce. Routes come from the public OpenStreetMap
// router, so an internet connection is needed.
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const URL = process.env.URL || "http://127.0.0.1:8765/";
const OUT = process.env.OUT || path.join(__dirname, "..", "public", "media");
const README_ANIM = path.join(__dirname, "..", "..", "docs", "screenshots", "demo.webp");
const VIEW = { width: 1280, height: 800 };
const wait = (page, ms) => page.waitForTimeout(ms);
// ONLY=themes,teleport records just those clips (the others are skipped, with their set-up)
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const want = (name) => !ONLY || ONLY.has(name);

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
  }, null, { timeout: 30000, polling: 200 }).catch(() => {});
  await wait(page, 200);
}

// ---------- the pointer ----------
const CURSOR_CSS = `
#rec-cursor { position: fixed; z-index: 2147483647; left: 0; top: 0; width: 22px; height: 22px; margin: -11px 0 0 -11px;
  border-radius: 50%; pointer-events: none; background: rgba(255,255,255,.94);
  box-shadow: 0 0 0 1.5px rgba(0,0,0,.55), 0 3px 10px rgba(0,0,0,.38);
  transition: transform .09s cubic-bezier(.4,0,.6,1); }
#rec-cursor.down { transform: scale(.74); }
#rec-cursor.up { transform: scale(1); transition: transform .42s cubic-bezier(.3,1.75,.55,1); }
#rec-ring { position: fixed; z-index: 2147483646; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%;
  border: 2px solid rgba(255,255,255,.75); pointer-events: none; opacity: 0; transform: scale(.4); }
#rec-ring.go { animation: rec-ring .45s ease-out; }
@keyframes rec-ring { from { opacity: .9; transform: scale(.35); } to { opacity: 0; transform: scale(1.2); } }`;

async function addCursor(page) {
  await page.addStyleTag({ content: CURSOR_CSS });
  await page.evaluate(() => {
    const c = document.createElement("div");
    c.id = "rec-cursor";
    const ring = document.createElement("div");
    ring.id = "rec-ring";
    document.body.append(ring, c);
    addEventListener("mousemove", (e) => { c.style.left = `${e.clientX}px`; c.style.top = `${e.clientY}px`; }, true);
    addEventListener("mousedown", (e) => {
      c.classList.remove("up"); c.classList.add("down");
      ring.style.left = `${e.clientX}px`; ring.style.top = `${e.clientY}px`;
      ring.classList.remove("go"); void ring.offsetWidth; ring.classList.add("go");
    }, true);
    addEventListener("mouseup", () => { c.classList.remove("down"); c.classList.add("up"); }, true);
  });
}

let pointer = { x: VIEW.width - 160, y: 120 };
// A gentle speed ramp (sine-blended cubic ease in-out) over a duration that grows with the distance,
// along a slight arc, in small steps so the dot glides rather than hops.
async function moveTo(page, to, { min = 320, max = 700 } = {}) {
  const from = { ...pointer };
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const ms = Math.max(min, Math.min(max, 240 + dist * 0.45));
  const steps = Math.max(10, Math.round(ms / 16));
  const bend = Math.min(60, dist * 0.12) * (to.x > from.x ? -1 : 1);
  const nx = -(to.y - from.y) / (dist || 1), ny = (to.x - from.x) / (dist || 1);
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    const cubic = f < 0.5 ? 4 * f ** 3 : 1 - (-2 * f + 2) ** 3 / 2;
    const e = 0.5 * cubic + 0.5 * (0.5 - 0.5 * Math.cos(Math.PI * f));
    const arc = Math.sin(Math.PI * e) * bend;
    await page.mouse.move(from.x + (to.x - from.x) * e + nx * arc, from.y + (to.y - from.y) * e + ny * arc);
    await wait(page, 16);
  }
  pointer = { ...to };
}
async function click(page, to, opts) {
  await moveTo(page, to, opts);
  await wait(page, 70);
  await page.mouse.down();
  await wait(page, 90);
  await page.mouse.up();
  await wait(page, 120);
}
async function center(page, selector) {
  const b = await page.locator(selector).first().boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function mapPoint(page, lat, lon) {
  return page.evaluate(([la, lo]) => {
    const p = map.latLngToContainerPoint([la, lo]);
    const r = map.getContainer().getBoundingClientRect();
    return { x: r.x + p.x, y: r.y + p.y };
  }, [lat, lon]);
}

// ---------- recording ----------
async function record(page, name, body, { readme = false } = {}) {
  if (!want(name)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `clip-${name}-`));
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  const speeds = []; // [time, playback speed from then on]; body calls speed(v) to fast-forward a wait
  const speed = (v) => speeds.push([Date.now() / 1000, v]);
  const speedAt = (t) => { let v = 1; for (const [at, x] of speeds) if (t >= at) v = x; return v; };
  cdp.on("Page.screencastFrame", async (f) => {
    const file = path.join(dir, `f${String(frames.length).padStart(5, "0")}.jpg`);
    fs.writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ file, t: f.metadata.timestamp, wall: Date.now() / 1000 });
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: VIEW.width, maxHeight: VIEW.height, everyNthFrame: 1 });
  const started = Date.now() / 1000;
  await body(speed);
  const ended = Date.now() / 1000;
  await cdp.send("Page.stopScreencast");
  await wait(page, 200);
  // ffconcat with each frame shown until the next one arrives (the screencast only sends changes)
  const lines = ["ffconcat version 1.0"];
  frames.forEach((fr, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].t : Math.max(ended, fr.t + 0.04);
    lines.push(`file '${fr.file}'`, `duration ${Math.max(0.001, (next - fr.t) / speedAt(fr.wall)).toFixed(4)}`);
  });
  lines.push(`file '${frames[frames.length - 1].file}'`);
  const list = path.join(dir, "list.txt");
  fs.writeFileSync(list, lines.join("\n"));
  const ff = (...args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, ...args]);
  const vf = "scale=1280:-2:flags=lanczos,fps=30,format=yuv420p";
  ff("-vf", vf, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "36", "-row-mt", "1", "-an", path.join(OUT, `${name}.webm`));
  ff("-vf", vf, "-c:v", "libx264", "-preset", "slow", "-crf", "27", "-movflags", "+faststart", "-an", path.join(OUT, `${name}.mp4`));
  ff("-vf", "scale=1280:-2", "-frames:v", "1", "-ss", String(Math.max(0, ended - started - 0.1)), "-c:v", "libwebp", "-quality", "80", path.join(OUT, `${name}-poster.webp`));
  if (readme) {
    // the README's animation: smaller and at 15 fps so GitHub shows it quickly
    ff("-vf", "fps=15,scale=900:-2:flags=lanczos", "-c:v", "libwebp_anim", "-loop", "0", "-quality", "70", "-compression_level", "6", README_ANIM);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`${name}: ${frames.length} frames, ${(ended - started).toFixed(1)} s`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await setup(page);
  await addCursor(page);
  await page.mouse.move(pointer.x, pointer.y);

  // 1. Teleport: pick a point near the Eiffel Tower, then jump there
  await page.evaluate(() => { map.setView([48.8584, 2.2945], 15); });
  await mapIdle(page);
  await record(page, "teleport", async () => {
    await wait(page, 250);
    await click(page, await mapPoint(page, 48.8606, 2.292));
    await wait(page, 350);
    await click(page, await center(page, "#btn-teleport"));
    await wait(page, 1500);
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
  await record(page, "route-build", async (speed) => {
    await wait(page, 200);
    await click(page, await mapPoint(page, 51.5074, -0.1278));
    await wait(page, 200);
    await click(page, await mapPoint(page, 51.5194, -0.0618));
    await wait(page, 250);
    await click(page, await center(page, "#btn-build"));
    await wait(page, 250);
    speed(3); // the build's wait for the routing server plays at 3x
    await page.waitForFunction(() => !state.building && state.built, null, { timeout: 120000 });
    speed(1);
    await moveTo(page, { x: VIEW.width - 160, y: 140 });
    await mapIdle(page);
    await wait(page, 1100);
  }, { readme: true });

  // 3. Playback: a short drive past Westminster with the live speed and heading
  if (want("playback")) {
  await page.evaluate(() => {
    state.waypoints = [];
    $("default-mode").value = "car"; $("default-speed").value = "50"; $("alt-count").value = "0";
    for (const id of ["default-mode", "default-speed", "alt-count"]) $(id).dispatchEvent(new Event("change"));
    map.setView([51.5035, -0.1215], 16);
    addWaypoint(51.5007, -0.1246, { name: "Westminster" });
    addWaypoint(51.5081, -0.1281, { name: "Trafalgar Square" });
    $("multiplier").value = "10"; $("multiplier").dispatchEvent(new Event("change"));
  });
  await page.click("#btn-build");
  await page.waitForFunction(() => !state.building && state.loaded === "route", null, { timeout: 120000 });
  await wait(page, 2800);
  await mapIdle(page);
  await record(page, "playback", async () => {
    await wait(page, 150);
    await click(page, await center(page, "#btn-play"));
    await moveTo(page, { x: VIEW.width - 160, y: 140 });
    await wait(page, 5200);
  });
  await page.click("#btn-stop").catch(() => {});
  }

  // 4. Maps and themes: the map menu (OpenStreetMap in the dark map theme, then the light theme, then
  // satellite), then colour themes in Settings. The theme switch is shown on OpenStreetMap, where it is
  // instant; the vector map reloads its style for it.
  await page.click('.tabs button[data-tab="teleport"]'); // a stray map click then only picks a point
  await page.evaluate(() => { map.setView([51.5055, -0.1], 15); });
  await mapIdle(page);
  if (want("themes")) {
    // load each map once, so during the recording its tiles come from the browser cache at once
    for (const [theme, provider] of [["dark", "osm"], ["light", "satellite"], ["dark", "openfreemap"]]) {
      await page.evaluate(([t, p]) => { settings().map_theme = t; settings().map_provider = p; applyAppearance(); }, [theme, provider]);
      await mapIdle(page);
      await wait(page, 1800);
    }
  }
  await record(page, "themes", async (speed) => {
    speed(1.3); // a tour of many settings: keep it brisk
    await wait(page, 100);
    await click(page, await center(page, ".map-switch-btn"));
    await wait(page, 260); // the menu's pop-in has finished, so the buttons are where they look
    await click(page, await center(page, '.map-card:has-text("OpenStreetMap")'));
    await wait(page, 700);
    await click(page, await center(page, '.map-theme-seg button:has-text("Light")'));
    await wait(page, 700);
    await click(page, await center(page, '.map-card:has-text("Satellite")'));
    await wait(page, 750);
    await page.keyboard.press("Escape");
    await click(page, await center(page, "#btn-settings"));
    await wait(page, 300);
    await click(page, await center(page, ".theme-more > summary"));
    await wait(page, 260);
    for (const t of ["nord", "sand", "ocean", "dracula", "midnight"]) {
      await click(page, await center(page, `.theme-card[data-theme="${t}"]`), { min: 200, max: 360 });
      await wait(page, 320);
    }
    await click(page, await center(page, '.theme-card[data-theme="graphite"]'), { min: 200, max: 400 });
    await wait(page, 450);
  });

  console.log(errors.length ? `page errors: ${JSON.stringify(errors)}` : "no page errors");
  await browser.close();
})();
