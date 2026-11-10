// Records the raw footage for the website's showreel (website/public/media/showreel.*): the real app,
// driven by a pointer, captured one video frame at a time. `edit.cjs` then cuts it together.
//
//   node website/scripts/showreel/record.cjs        (needs Python with the browser edition's packages,
//                                                    Playwright, and an internet connection)
//
// How the frames are made: the page's clock (Playwright's fake clock) and the server's clock
// (app-server.py) are both stopped. For each frame they move on by exactly 1/30 s, every running CSS
// animation and transition is set to that time, and the screen is captured at 3x scale. So the
// footage has no dropped frames however slow the capture is, and the editor can zoom in to a button
// and still have sharp text. The pointer is not drawn here: its position and whether it is pressed are
// saved with each frame, and the editor draws it at a constant size whatever the zoom.
//
// Output (RAW, default <tmp>/showreel-raw): one folder per take, with f00000.jpg… and take.json
// (viewport, scale, and per frame the pointer and anything a take chose to note down).
// ONLY=route,playback films just those takes. Each take carries on from the one before (the playback
// drives the route built in the first, the teleport starts from where it ended), so film them all for
// the footage the edit uses.
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

const PORT = +process.env.PORT || 8766;
const BASE = `http://127.0.0.1:${PORT}`;
const RAW = process.env.RAW || path.join(os.tmpdir(), "showreel-raw");
const FPS = 30;
const DSF = +process.env.DSF || 3;
const VIEW = { width: 1280, height: 800 };
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const want = (name) => !ONLY || ONLY.has(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Places
// Trafalgar Square, Piccadilly Circus, Oxford Circus: the list ends up in the reverse order, a clean drive
// up Regent Street the other way
const LONDON = { a: [51.5079, -0.128], b: [51.5101, -0.134], c: [51.5154, -0.1418], view: [51.51165, -0.1349] };
const EIFFEL = [48.85837, 2.29448];

// ---------------------------------------------------------------- the app's server
async function startServer() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "showreel-data-"));
  const py = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
  const child = spawn(py, [path.join(__dirname, "app-server.py"), "--port", String(PORT)], {
    env: { ...process.env, SPOOFER_DATA_DIR: data }, stdio: ["ignore", "inherit", "inherit"],
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/status`)).ok) return child; } catch (_) { /* not up yet */ }
    await sleep(200);
  }
  child.kill();
  throw new Error("The app's server did not start");
}
const serverClock = (action, dt = 0) =>
  fetch(`${BASE}/__showreel/clock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, dt }) });

// ---------------------------------------------------------------- the page
// Runs before the app: keeps CSS animations and transitions on the page's (fake) clock. Each one is
// paused when it first appears and from then on set to the time it has been running.
const ANIMATION_CLOCK = `(() => {
  const started = new WeakMap();
  const live = new Set();
  window.__showreel = {
    step() {
      const now = performance.now();
      for (const a of document.getAnimations()) {
        if (started.has(a) || a.playState === "finished") continue;
        started.set(a, now - (a.currentTime || 0));
        a.pause();
        live.add(a);
      }
      for (const a of live) {
        if (a.playState === "idle" || a.playState === "finished") { live.delete(a); continue; }
        const t = now - started.get(a);
        const end = a.effect ? a.effect.getComputedTiming().endTime : 0;
        if (t >= end) { a.finish(); live.delete(a); } else a.currentTime = t;
      }
    },
    // every map layer has the tiles it needs for the current view
    mapReady() {
      let ok = true;
      map.eachLayer((l) => {
        const gl = l._glLayer && l._glLayer.getMaplibreMap && l._glLayer.getMaplibreMap();
        if (gl) ok = ok && gl.loaded() && gl.areTilesLoaded();
        else if (typeof l.isLoading === "function") ok = ok && !l.isLoading();
      });
      return ok;
    },
  };
})();`;

class Recorder {
  constructor(page, cdp) {
    Object.assign(this, { page, cdp, n: 0, take: null, pointer: { x: VIEW.width - 140, y: 140, down: false } });
  }

  // one video frame: both clocks move on 1/30 s, animations follow, the map gets its tiles, capture
  async frame({ capture = true } = {}) {
    const dt = Math.round((this.n + 1) * 1000 / FPS) - Math.round(this.n * 1000 / FPS);
    this.n++;
    await serverClock("step", dt / 1000);
    await this.page.clock.runFor(dt);
    await this.page.evaluate(() => __showreel.step());
    for (let i = 0; i < 80 && !(await this.page.evaluate(() => __showreel.mapReady())); i++) await sleep(50);
    if (!capture || !this.take) return;
    const { data } = await this.cdp.send("Page.captureScreenshot", {
      format: "jpeg", quality: 92, optimizeForSpeed: true, clip: { x: 0, y: 0, width: VIEW.width, height: VIEW.height, scale: DSF } });
    const t = this.take;
    fs.writeFileSync(path.join(t.dir, `f${String(t.frames.length).padStart(5, "0")}.jpg`), Buffer.from(data, "base64"));
    const f = { x: +this.pointer.x.toFixed(1), y: +this.pointer.y.toFixed(1), down: this.pointer.down };
    if (t.probe) f.p = await this.page.evaluate(t.probe);
    t.frames.push(f);
  }
  async hold(ms) { for (let i = 0, k = Math.round(ms * FPS / 1000); i < k; i++) await this.frame(); }
  // time passes without being filmed (setting up between takes)
  async skip(ms) { for (let i = 0, k = Math.round(ms * FPS / 1000); i < k; i++) await this.frame({ capture: false }); }
  async until(fn, arg, { max = 60000, capture = true } = {}) {
    const end = Date.now() + max;
    while (!(await this.page.evaluate(fn, arg))) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${fn}`);
      await this.frame({ capture });
    }
  }

  async record(name, body, { probe = null } = {}) {
    if (!want(name)) return;
    const dir = path.join(RAW, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    this.take = { name, dir, frames: [], marks: [], probe };
    const t0 = Date.now();
    await body();
    const t = this.take;
    this.take = null;
    fs.writeFileSync(path.join(dir, "take.json"), JSON.stringify({ name, fps: FPS, scale: DSF, view: VIEW, frames: t.frames, marks: t.marks }));
    console.log(`${name}: ${t.frames.length} frames (${(t.frames.length / FPS).toFixed(1)} s), recorded in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  // note something down at the current frame (a name, and usually where an element is)
  async mark(name, selector = null) {
    if (!this.take) return;
    const m = { f: Math.max(0, this.take.frames.length - 1), name };
    if (selector) m.rect = await rect(this.page, selector);
    this.take.marks.push(m);
  }

  // ---- the pointer: a speed ramp (quintic ease in-out) along a slight arc, one position per frame
  async moveTo(to, { min = 260, max = 620 } = {}) {
    const from = { x: this.pointer.x, y: this.pointer.y };
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const ms = Math.max(min, Math.min(max, 180 + dist * 0.42));
    const steps = Math.max(2, Math.round(ms * FPS / 1000));
    const bend = Math.min(50, dist * 0.1) * (to.x > from.x ? -1 : 1);
    const nx = -(to.y - from.y) / (dist || 1), ny = (to.x - from.x) / (dist || 1);
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      const e = f < 0.5 ? 16 * f ** 5 : 1 - (-2 * f + 2) ** 5 / 2;
      const arc = Math.sin(Math.PI * e) * bend;
      this.pointer.x = from.x + (to.x - from.x) * e + nx * arc;
      this.pointer.y = from.y + (to.y - from.y) * e + ny * arc;
      await this.page.mouse.move(this.pointer.x, this.pointer.y);
      await this.frame();
    }
  }
  async down() { this.pointer.down = true; await this.page.mouse.down(); await this.frame(); }
  async up() { this.pointer.down = false; await this.page.mouse.up(); await this.frame(); }
  async click(to, opts) {
    await this.moveTo(to, opts);
    await this.frame();
    await this.down();
    await this.frame();
    await this.up();
  }
  // drag with the button held, slowly enough for the list to make room as it goes
  async drag(from, to, ms = 700) {
    await this.moveTo(from);
    await this.frame();
    await this.down();
    await this.hold(80);
    const steps = Math.round(ms * FPS / 1000);
    for (let i = 1; i <= steps; i++) {
      const f = i / steps, e = f < 0.5 ? 4 * f ** 3 : 1 - (-2 * f + 2) ** 3 / 2;
      this.pointer.x = from.x + (to.x - from.x) * e;
      this.pointer.y = from.y + (to.y - from.y) * e;
      await this.page.mouse.move(this.pointer.x, this.pointer.y);
      await this.frame();
    }
    await this.hold(120);
    await this.up();
  }
  async type(text, framesPerKey = 2) {
    for (const ch of text) {
      await this.page.keyboard.type(ch);
      for (let i = 0; i < framesPerKey; i++) await this.frame();
    }
  }
}

async function rect(page, selector) {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} is not on screen`);
  return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) };
}
async function center(page, selector) {
  const b = await rect(page, selector);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}
async function mapPoint(page, [lat, lon]) {
  return page.evaluate(([la, lo]) => {
    const p = map.latLngToContainerPoint([la, lo]);
    const r = map.getContainer().getBoundingClientRect();
    return { x: r.x + p.x, y: r.y + p.y };
  }, [lat, lon]);
}
// the spoofed position on screen, saved with every frame of the takes that follow it
const DEVICE_PROBE = () => {
  const el = typeof deviceMarker !== "undefined" && deviceMarker && deviceMarker.getElement();
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { dx: +(r.x + r.width / 2).toFixed(1), dy: +(r.y + r.height / 2).toFixed(1) };
};

// ---------------------------------------------------------------- the takes
(async () => {
  fs.mkdirSync(RAW, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: DSF });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.clock.install();
    await page.addInitScript(ANIMATION_CLOCK);
    await page.goto(`${BASE}/`);
    await page.waitForTimeout(1500);
    await page.evaluate(() => { if ($("tutorial").open) finishTutorial(); });
    await page.evaluate(() => {
      const s = settings();
      s.theme = "graphite"; s.map_theme = "dark"; s.map_provider = "openfreemap"; s.tutorial_done = true;
      applyAppearance();
    });
    await page.evaluate(() => { $("driver").value = "mock"; $("driver").dispatchEvent(new Event("change")); });
    await page.click("#btn-connect");
    await page.waitForTimeout(900);
    await page.evaluate(() => { $("sec-device").open = false; });

    // Load every map view the takes use once, so their tiles come from the cache while filming
    const visit = async (fn, arg) => { await page.evaluate(fn, arg).then(() => {}); await page.waitForTimeout(400); await page.waitForFunction(() => __showreel.mapReady(), null, { timeout: 30000, polling: 200 }).catch(() => {}); await page.waitForTimeout(600); };
    for (const z of [15, 16]) await visit(([c, z]) => { map.setView(c, z, { animate: false }); }, [LONDON.view, z]);
    for (const z of [15, 18]) await visit(([c, z]) => { map.setView(c, z, { animate: false }); }, [EIFFEL, z]);
    for (const [theme, provider] of [["dark", "satellite"], ["dark", "osm"], ["light", "openfreemap"], ["dark", "openfreemap"]]) {
      await visit(([t, p]) => { settings().map_theme = t; settings().map_provider = p; applyAppearance(); }, [theme, provider]);
      await page.waitForTimeout(1200);
    }
    await page.waitForTimeout(3000); // the "Connected" toast has gone

    // From here on, time only moves a frame at a time
    // (the clock's own idea of "now" can run a little ahead of the page's Date.now())
    const now = await page.evaluate(() => Date.now());
    for (let off = 500; ; off *= 2) {
      try { await page.clock.pauseAt(now + off); break; } catch (e) { if (off > 120000) throw e; }
    }
    await serverClock("pause");
    const cdp = await context.newCDPSession(page);
    const rec = new Recorder(page, cdp);
    await page.mouse.move(rec.pointer.x, rec.pointer.y);

    // 1. Route: three checkpoints on the map, two of them dragged to new places in the list, then
    //    Build route (car, no alternatives) and the finished route
    await page.click('.tabs button[data-tab="route"]');
    await page.evaluate((v) => {
      state.waypoints = [];
      $("default-mode").value = "car"; $("default-speed").value = "40"; $("alt-count").value = "0"; $("closed").checked = false;
      for (const id of ["default-mode", "default-speed", "alt-count"]) $(id).dispatchEvent(new Event("change"));
      $("sec-route-settings").open = false; $("sec-route-import").open = false;
      renderWaypoints();
      map.setView(v, 16, { animate: false });
    }, LONDON.view);
    await rec.skip(1200);
    await rec.record("route", async () => {
      await rec.hold(300);
      for (const k of ["a", "b", "c"]) {
        await rec.click(await mapPoint(page, LONDON[k]), { min: 300, max: 520 });
        await rec.mark(`checkpoint-${k}`);
        await rec.hold(k === "c" ? 900 : 160);
      }
      // the list is now taller than the side menu: bring the Checkpoints section to the top
      await rec.mark("scroll");
      const top = await page.evaluate(() => $("sec-checkpoints").offsetTop - 8);
      const from = await page.evaluate(() => $("sidebar").scrollTop);
      for (let i = 1; i <= 9; i++) {
        const f = i / 9, e = 1 - (1 - f) ** 3;
        await page.evaluate((y) => { $("sidebar").scrollTop = y; }, from + (top - from) * e);
        await rec.frame();
      }
      await rec.hold(150);
      await rec.mark("list", "#sec-checkpoints");
      // the third checkpoint to the top, then the new third one up to second place (both upwards: a
      // row dragged down can't get past the last row, which is shorter than the others)
      const grip = (i) => center(page, `#waypoints li.wp:nth-child(${i}) .wp-grip`);
      const row = (i) => rect(page, `#waypoints li.wp:nth-child(${i})`);
      const r1 = await row(1);
      await rec.drag(await grip(3), { x: (await grip(3)).x, y: r1.y + 10 }, 650);
      await rec.hold(300);
      const r2 = await row(2);
      const g3 = await grip(3);
      await rec.drag(g3, { x: g3.x, y: r2.y + 10 }, 600);
      await rec.hold(350);
      await rec.mark("list-done", "#sec-checkpoints");
      await rec.mark("build", "#btn-build");
      await rec.click(await center(page, "#btn-build"), { min: 320 });
      await rec.mark("build-start", "#build-row");
      await rec.until(() => !state.building && !!state.built);
      await rec.mark("built", "#build-row");
      await rec.hold(700);
      await rec.moveTo({ x: VIEW.width - 150, y: 150 }, { min: 500, max: 700 });
      await rec.hold(900);
    });

    // 2. Playback at 10x: Play, then the iPhone drives the route with the live speed and heading
    await page.evaluate(() => {
      $("multiplier").value = "10"; $("multiplier").dispatchEvent(new Event("change"));
      const w = state.waypoints[0];
      map.setView([w.lat, w.lon], 16, { animate: false });
    });
    await rec.skip(1500);
    await rec.record("playback", async () => {
      await rec.hold(200);
      await rec.mark("player", "#player");
      await rec.click(await center(page, "#btn-play"), { min: 380 });
      await rec.mark("playing");
      await rec.hold(1200);
      await rec.moveTo({ x: VIEW.width - 120, y: 110 }, { min: 700, max: 900 });
      await rec.mark("hud", "#hud");
      await rec.hold(6500);
      await rec.mark("hud-end", "#hud");
    }, { probe: DEVICE_PROBE });
    await page.evaluate(() => $("btn-stop").click());
    await rec.skip(800);

    // 3. Teleport: search for the Eiffel Tower, pick it, jump there
    await rec.record("teleport", async () => {
      await rec.hold(150);
      await rec.click(await center(page, '.tabs button[data-tab="teleport"]'));
      await rec.hold(250);
      await rec.mark("find", "#sec-find");
      await rec.click(await center(page, "#search"), { min: 300 });
      await rec.hold(120);
      await rec.type("Eiffel Tower", 2);
      await rec.hold(200);
      await page.keyboard.press("Enter");
      await rec.until(() => !!document.querySelector("#search-results li:not(.muted)"));
      await rec.hold(350);
      await rec.mark("results", "#search-results");
      await rec.click(await center(page, "#search-results li:first-child"), { min: 300 });
      await rec.mark("picked");
      await rec.hold(500);
      await rec.mark("teleport", "#btn-teleport");
      await rec.click(await center(page, "#btn-teleport"), { min: 360 });
      await rec.until(() => { const p = state.status && state.status.player.position; return p && Math.abs(p.lat - 48.858) < 0.01; });
      await rec.mark("jumped", "#sec-picked");
      await rec.hold(1300);
    }, { probe: DEVICE_PROBE });

    // 4. Joystick: drive around the Champ de Mars with the pad
    await page.evaluate((c) => {
      map.setView(c, 18, { animate: false });
      // the iPhone sits left of centre, next to the pad (but inside the area the map keeps it in)
      map.panBy([210, -40], { animate: false });
    }, EIFFEL);
    await rec.skip(800);
    await rec.record("joystick", async () => {
      await rec.hold(150);
      await rec.click(await center(page, '.tabs button[data-tab="joystick"]'));
      await rec.hold(250);
      await rec.mark("pad", "#sec-joy");
      await rec.click(await center(page, '#joy-presets button:has-text("Highway 110")'), { min: 300 });
      await rec.hold(200);
      for (const [b, ms] of [[0, 1500], [45, 1300], [90, 1100]]) {
        await rec.moveTo(await center(page, `#dpad button[data-b="${b}"]`), { min: 220, max: 360 });
        await rec.frame();
        await rec.down();
        await rec.mark(`hold-${b}`);
        await rec.hold(ms);
        await rec.up();
      }
      await rec.hold(500);
    }, { probe: DEVICE_PROBE });
    await page.evaluate(() => $("joy-stop").click());
    await rec.skip(600);

    // 5. Maps and colours: the map menu (satellite, then the light vector map), then colour themes
    await page.evaluate((c) => { map.setView(c, 15, { animate: false }); }, EIFFEL);
    await rec.skip(600);
    await rec.record("themes", async () => {
      await rec.hold(150);
      await rec.click(await center(page, ".map-switch-btn"), { min: 300 });
      await rec.hold(260);
      await rec.mark("maps", ".map-switch-btn");
      await rec.click(await center(page, '.map-card:has-text("Satellite")'), { min: 260 });
      await rec.mark("satellite");
      await rec.hold(700);
      await rec.click(await center(page, ".map-card >> nth=0"), { min: 260 });
      await rec.hold(250);
      await rec.click(await center(page, '.map-theme-seg button:has-text("Light")'), { min: 220 });
      await rec.mark("light");
      await rec.hold(700);
      await rec.click(await center(page, '.map-theme-seg button:has-text("Dark")'), { min: 220 });
      await rec.hold(300);
      await page.keyboard.press("Escape");
      await rec.hold(150);
      await rec.click(await center(page, "#btn-settings"), { min: 380 });
      await rec.hold(300);
      await rec.click(await center(page, ".theme-more > summary"), { min: 260 });
      await rec.hold(260);
      await rec.mark("themes", ".theme-card");
      for (const t of ["nord", "sand", "ocean", "dracula", "midnight"]) {
        await rec.click(await center(page, `.theme-card[data-theme="${t}"]`), { min: 180, max: 300 });
        await rec.mark(`theme-${t}`);
        await rec.hold(300);
      }
      await rec.click(await center(page, '.theme-card[data-theme="graphite"]'), { min: 200, max: 360 });
      await rec.hold(300);
      await page.keyboard.press("Escape");
      await rec.hold(400);
      await rec.moveTo({ x: VIEW.width - 150, y: 150 });
      await rec.hold(600);
    });
  } finally {
    console.log(errors.length ? `page errors: ${JSON.stringify(errors)}` : "no page errors");
    await browser.close();
    // the server's clock must run again for it to shut down
    await serverClock("resume").catch(() => {});
    server.kill();
    setTimeout(() => server.kill("SIGKILL"), 3000).unref();
  }
})().catch((e) => { console.error(e); process.exit(1); });
