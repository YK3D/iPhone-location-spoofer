// Screenshots for the README (docs/screenshots). Every shot uses the default look: the Graphite
// theme and the dark OpenFreeMap map. Change THEME / MAP_THEME / MAP_PROVIDER below to capture
// another look on purpose.
//
//   1. Start the browser edition from source with an empty data folder, so the first build of each
//      route is not cached (the progress shot needs a real build):
//        cd browser && SPOOFER_DATA_DIR=$(mktemp -d) python -m spoofer --port 8765 --no-browser --no-update
//   2. node docs/screenshots/capture.js            (needs Playwright: npm i playwright; npx playwright install chromium)
//   3. python docs/screenshots/to_webp.py          (needs Pillow: full-window shots become WebP)
//
// Routes come from the public OpenStreetMap router, so an internet connection is needed and the
// alternatives found can change a little as the map data changes.
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const THEME = "graphite";
const MAP_THEME = "dark";
const MAP_PROVIDER = "openfreemap";
const URL = process.env.URL || "http://127.0.0.1:8765/";
const OUT = process.env.OUT || __dirname;
const VIEW = { width: 1440, height: 900 };
const wait = (page, ms) => page.waitForTimeout(ms);

async function look(page) {
  await page.evaluate(([theme, mapTheme, provider]) => {
    const s = settings();
    s.theme = theme;
    s.map_theme = mapTheme;
    s.map_provider = provider;
    s.tutorial_done = true;
    applyAppearance();
  }, [THEME, MAP_THEME, MAP_PROVIDER]);
}

// The vector map draws after its tiles and fonts arrive: wait until it has finished.
async function mapIdle(page) {
  await page.waitForFunction(() => {
    const l = MAP_PROVIDERS.openfreemap.layer;
    if (!map.hasLayer(l)) return true;
    const gl = l._glLayer && l._glLayer.getMaplibreMap();
    return !!gl && gl.loaded() && gl.areTilesLoaded();
  }, null, { timeout: 30000, polling: 250 }).catch(() => {});
  await wait(page, 300);
}

async function markerPoint(page, index) {
  return page.evaluate((i) => {
    const r = wpMarkers.get(state.waypoints[i].id).getElement().getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, index);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(URL);
  await wait(page, 1500);
  await page.evaluate(() => { if ($("tutorial").open) finishTutorial(); });
  await look(page);
  if (await page.isVisible("#btn-connect")) {
    await page.evaluate(() => { $("driver").value = "mock"; $("driver").dispatchEvent(new Event("change")); });
    await page.click("#btn-connect");
    await wait(page, 900);
  }
  await page.evaluate(() => { $("sec-device").open = false; });
  const shot = (name, opts = {}) => page.screenshot({ path: path.join(OUT, name), ...opts });

  // 1. Teleport: a picked point and the spoofed position on the map
  await page.evaluate(async () => {
    map.setView([48.8584, 2.2945], 15);
    setPicked(48.8584, 2.2945, false);
    await teleport();
    setPicked(48.8616, 2.2893, false);
  });
  await wait(page, 1600);
  await page.mouse.move(VIEW.width - 120, 80);
  await mapIdle(page);
  await shot("teleport.png");

  // 2. A car route with three alternatives, labelled on the map; the build progress on the way
  await page.click('.tabs button[data-tab="route"]');
  await page.evaluate(() => {
    state.waypoints = [];
    $("default-mode").value = "car"; $("default-speed").value = "40"; $("alt-count").value = "3";
    for (const id of ["default-mode", "default-speed", "alt-count"]) $(id).dispatchEvent(new Event("change"));
    $("sec-route-settings").open = false;
    $("sec-route-import").open = false;
    map.setView([51.512, -0.095], 14);
    addWaypoint(51.5074, -0.1278, { name: "Trafalgar Square" });
    addWaypoint(51.5194, -0.0618, { name: "Whitechapel" });
  });
  await wait(page, 500);
  await page.click("#btn-build");
  await page.mouse.move(VIEW.width - 120, 80);
  await wait(page, 1400);
  await page.locator("#sec-checkpoints").screenshot({ path: path.join(OUT, "build-progress.png") });
  await page.waitForFunction(() => !state.building && state.built, null, { timeout: 120000 });
  await wait(page, 2800); // the button settles back to "Build route"
  await page.evaluate(() => $("sec-route-result").scrollIntoView({ block: "start" }));
  await mapIdle(page);
  await shot("route-alternatives.png");

  // 3. Right-click menu on a checkpoint
  const p0 = await markerPoint(page, 1);
  await page.mouse.click(p0.x, p0.y, { button: "right" });
  await wait(page, 300);
  const menu = await page.locator("#ctx-menu").boundingBox();
  const clip = { x: Math.max(0, p0.x - 150), y: Math.max(0, p0.y - 110), width: 520, height: 300 };
  clip.width = Math.min(clip.width, VIEW.width - clip.x);
  clip.height = Math.max(clip.height, menu.y + menu.height + 20 - clip.y);
  await shot("context-menu.png", { clip });
  await page.keyboard.press("Escape");

  // 4. Reordering: a checkpoint lifted halfway up the list
  await page.evaluate(() => {
    state.waypoints = [];
    $("default-mode").value = "straight"; $("alt-count").value = "0";
    for (const id of ["default-mode", "alt-count"]) $(id).dispatchEvent(new Event("change"));
    addWaypoint(51.5007, -0.1246, { name: "Westminster" });
    addWaypoint(51.5055, -0.0754, { name: "Tower Bridge" });
    addWaypoint(51.5138, -0.0984, { name: "St Paul's" });
    $("sec-checkpoints").scrollIntoView({ block: "start" });
  });
  await wait(page, 500);
  const grip = await page.locator("#waypoints li.wp:nth-child(3) .wp-grip").boundingBox();
  const top = await page.locator("#waypoints li.wp:nth-child(2)").boundingBox();
  const gx = grip.x + grip.width / 2, gy = grip.y + grip.height / 2;
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) { await page.mouse.move(gx, gy + (top.y + 20 - gy) * (i / 20)); await wait(page, 16); }
  await wait(page, 320);
  await page.locator("#sec-checkpoints").screenshot({ path: path.join(OUT, "drag-reorder.png") });
  for (let i = 19; i >= 0; i--) { await page.mouse.move(gx, gy + (top.y + 20 - gy) * (i / 20)); await wait(page, 12); }
  await page.mouse.up();
  await wait(page, 500);

  // 5. Playback: waiting at a "hold until Continue" checkpoint, with the live HUD
  await page.evaluate(() => {
    state.waypoints = [];
    $("default-mode").value = "car"; $("default-speed").value = "50";
    $("default-mode").dispatchEvent(new Event("change"));
    map.setView([51.503, -0.12], 15);
    addWaypoint(51.5007, -0.1246, { name: "Westminster" });
    addWaypoint(51.5033, -0.1195, { name: "London Eye", hold: true });
    addWaypoint(51.5081, -0.1281, { name: "Trafalgar Square" });
    $("multiplier").value = "10"; $("multiplier").dispatchEvent(new Event("change"));
  });
  await page.click("#btn-build");
  await page.waitForFunction(() => !state.building && state.loaded === "route", null, { timeout: 120000 });
  await wait(page, 2800);
  await page.click("#btn-play");
  await page.waitForFunction(() => state.status && state.status.player.state === "held", null, { timeout: 120000 });
  await wait(page, 1200);
  await page.mouse.move(VIEW.width - 120, 80);
  await mapIdle(page);
  await shot("playback-hud.png");
  await page.click("#btn-stop");
  await page.evaluate(() => { $("multiplier").value = "1"; $("multiplier").dispatchEvent(new Event("change")); });

  // 6. Settings
  await page.click("#btn-settings");
  await wait(page, 400);
  await mapIdle(page);
  await shot("settings.png");

  console.log(errors.length ? `page errors: ${JSON.stringify(errors)}` : "no page errors");
  await browser.close();
})();
