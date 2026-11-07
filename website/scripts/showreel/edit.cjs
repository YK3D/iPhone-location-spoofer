// Cuts the raw footage from record.cjs into the website's showreel: website/public/media/showreel.webm,
// showreel.mp4 and showreel-poster.webp (1600x1000, 30 fps, no sound: the site plays it muted).
//
//   node website/scripts/showreel/edit.cjs           (needs Playwright and ffmpeg with libvpx-vp9, libx264, libwebp)
//
// The edit is the list of shots in shots.cjs. A shot is a stretch of one take with camera
// keyframes (where the camera looks and how far it is zoomed in, in the app's own 1280x800 page
// coordinates), a title card, or the closing logo. Each output frame is drawn by editor.html in
// headless Chromium: the take's frame (captured at 3x) placed under the camera, drawn several times
// across the shutter when the camera moves fast so the move blurs, then the pointer, then any text.
//
// FROM=12 TO=20 renders only that part; SHEET=1 writes a contact sheet of every 10th frame instead
// of the videos (for checking an edit quickly); ONLY=route,playback leaves the other takes out. The frames are rendered at 1920x1200 into a nearly
// lossless master; the site gets 1600x1000 encodes (KEEP_MASTER=file keeps the master, MASTER=file
// encodes an existing one again without rendering).
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, execFileSync } = require("child_process");
const { chromium } = require("playwright");

const RAW = process.env.RAW || path.join(os.tmpdir(), "showreel-raw");
const SITE = path.join(__dirname, "..", "..");
const OUT = process.env.OUT || path.join(SITE, "public", "media");
const W = 1920, H = 1200, FPS = 30;
const VIEW = { width: 1280, height: 800 };
const OS = W / VIEW.width; // output pixels per page pixel at zoom 1

// ---------------------------------------------------------------- takes
const takes = {};
function take(name) {
  if (takes[name]) return takes[name];
  const dir = path.join(RAW, name);
  const t = JSON.parse(fs.readFileSync(path.join(dir, "take.json"), "utf8"));
  t.dir = dir;
  t.mark = (m) => {
    const found = t.marks.find((x) => x.name === m);
    if (!found) throw new Error(`take ${name} has no mark "${m}"`);
    return found;
  };
  // frames where the pointer is pressed down
  t.presses = t.frames.map((f, i) => (f.down && !(t.frames[i - 1] || {}).down ? i : -1)).filter((i) => i >= 0);
  return (takes[name] = t);
}

// takes that are missing are left out of the edit (with a warning), for trying out a partial recording
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
function has(name) {
  const ok = (!ONLY || ONLY.has(name)) && fs.existsSync(path.join(RAW, name, "take.json"));
  if (!ok) console.warn(`leaving out the ${name} take`);
  return ok;
}

// ---------------------------------------------------------------- camera
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const E = {
  linear: (x) => x,
  out: (x) => 1 - (1 - x) ** 3,
  in: (x) => x ** 3,
  inOut: (x) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2),
  // a whip: slow off the mark, very fast through the middle, a long soft landing
  whip: (x) => (x < 0.5 ? 16 * x ** 5 : 1 - (-2 * x + 2) ** 5 / 2),
  expoOut: (x) => (x >= 1 ? 1 : 1 - 2 ** (-10 * x)),
};
// a camera that shows `r` (page px) with `pad` around it, and never looks past the page's edges
function fit(r, { pad = 36, z = null, dx = 0, dy = 0, maxZ = 3.6 } = {}) {
  const zz = z || clamp(Math.min(VIEW.width / (r.w + 2 * pad), VIEW.height / (r.h + 2 * pad)), 1, maxZ);
  return bound({ x: r.x + r.w / 2 + dx, y: r.y + r.h / 2 + dy, z: zz });
}
function bound(c) {
  const z = Math.max(1, c.z);
  const hw = VIEW.width / 2 / z, hh = VIEW.height / 2 / z;
  return { ...c, z, x: clamp(c.x, hw, VIEW.width - hw), y: clamp(c.y, hh, VIEW.height - hh) };
}
const FULL = { x: VIEW.width / 2, y: VIEW.height / 2, z: 1 };
// keyframes: [{ t (ms), x, y, z, r (degrees), ease (into this keyframe) }]
function camAt(keys, t) {
  if (t <= keys[0].t) return keys[0];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (t > b.t) continue;
    const f = (E[b.ease || "inOut"])((t - a.t) / Math.max(1, b.t - a.t));
    return {
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      z: Math.exp(Math.log(a.z) + (Math.log(b.z) - Math.log(a.z)) * f), // zoom changes evenly to the eye
      r: (a.r || 0) + ((b.r || 0) - (a.r || 0)) * f,
    };
  }
  return keys[keys.length - 1];
}
// page px -> output px for a camera, as a canvas transform [a, b, c, d, e, f]
function camMatrix(c, unit) {
  const s = c.z * OS;
  const rad = ((c.r || 0) * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  // translate the camera centre to the origin, scale, rotate, then move to the frame's centre
  const a = s * cos, b = s * sin, cc = -s * sin, d = s * cos;
  const e = W / 2 - (a * c.x + cc * c.y), f = H / 2 - (b * c.x + d * c.y);
  return [a * unit, b * unit, cc * unit, d * unit, e, f];
}

// ---------------------------------------------------------------- shots
// footage(take, { from: frame or mark, speed, dur, cam: [...], fadeIn, fadeOut, pointer })
function footage(name, o) {
  const t = take(name);
  const from = typeof o.from === "string" ? t.mark(o.from).f : o.from || 0;
  const s = { kind: "footage", take: t, from, speed: o.speed || 1, ramp: o.ramp || null, cam: o.cam || [FULL],
    fadeIn: o.fadeIn || 0, fadeOut: o.fadeOut || 0, pointer: o.pointer !== false, shutter: o.shutter || 1 };
  const to = o.to == null ? t.frames.length - 1 : typeof o.to === "string" ? t.mark(o.to).f : o.to;
  s.dur = o.dur != null ? o.dur : timeOf(s, to);
  return s;
}
// title card: lines of words; a word in [brackets] is in the accent colour
function card(text, { dur = 1500, gap = 120, outMs = 320, start = 60 } = {}) {
  let at = start;
  const lines = text.split("\n").map((line) => line.split(" ").map((w) => {
    const word = { text: w.replace(/[[\]]/g, ""), accent: /^\[.*\]$/.test(w) || /^\[/.test(w), at };
    at += gap;
    return word;
  }));
  return { kind: "card", dur, outMs, lines, id: text };
}
const logo = (dur, tagline) => ({ kind: "logo", dur, tagline });

// source frame for a time in a footage shot; `ramp` is [[ms, speed], ...] (piecewise constant)
function srcFrame(s, t) {
  if (!s.ramp) return s.from + (t / 1000) * FPS * s.speed;
  let f = s.from, last = 0, v = s.speed;
  for (const [at, sp] of s.ramp) {
    if (t <= at) break;
    f += ((at - last) / 1000) * FPS * v;
    last = at; v = sp;
  }
  return f + ((t - last) / 1000) * FPS * v;
}

// the time in a footage shot at which it shows a given source frame
function timeOf(s, frame) {
  const segs = [[0, s.speed], ...(s.ramp || [])];
  let f = s.from;
  for (let i = 0; i < segs.length; i++) {
    const [at, v] = segs[i];
    const next = i + 1 < segs.length ? segs[i + 1][0] : Infinity;
    const df = ((next - at) / 1000) * FPS * v;
    if (frame <= f + df) return at + ((frame - f) / (FPS * v)) * 1000;
    f += df;
  }
  return Infinity;
}

// ---------------------------------------------------------------- one output frame
function pointerAt(tk, i) {
  const fr = tk.frames[i];
  if (!fr) return null;
  // pressing shrinks the dot over ~4 frames and lets it spring back
  let press = 0;
  for (let k = 0; k < 4; k++) press += (tk.frames[i - k] || fr).down ? 0.25 : 0;
  const r = 13.5 - 3.8 * press;
  const rings = [];
  for (const p of tk.presses) {
    const age = (i - p) / FPS;
    if (age < 0 || age > 0.45) continue;
    const k = age / 0.45;
    rings.push({ r: 12 + 30 * (1 - (1 - k) ** 3), a: 0.75 * (1 - k) });
  }
  return { x: fr.x, y: fr.y, r, rings };
}
function frameSpec(s, t, url) {
  if (s.kind === "card") return { glow: 0.16, vignette: 0.4, layers: [], card: { id: s.id, t, dur: s.dur, outMs: s.outMs, lines: s.lines } };
  if (s.kind === "logo") return { glow: 0.2, vignette: 0.4, layers: [], logo: { t, dur: s.dur, tagline: s.tagline, wordWidth: s.wordWidth } };
  const tk = s.take;
  const fi = clamp(Math.round(srcFrame(s, t)), 0, tk.frames.length - 1);
  const shutterMs = (1000 / FPS) * s.shutter;
  // how far the camera moved during this frame's shutter, in output pixels
  const c0 = camAt(s.cam, t), c1 = camAt(s.cam, t - shutterMs);
  const move = Math.hypot((c0.x - c1.x) * c0.z * OS, (c0.y - c1.y) * c0.z * OS) + Math.abs(Math.log(c0.z / c1.z)) * W * 0.5
    + Math.abs((c0.r || 0) - (c1.r || 0)) * 12;
  const n = t <= 0 ? 1 : clamp(Math.ceil(move / 2.2), 1, 40);
  const samples = [], ptMats = [];
  for (let k = 0; k < n; k++) {
    const c = n === 1 ? c0 : camAt(s.cam, t - (shutterMs * k) / (n - 1));
    samples.push(camMatrix(c, 1 / tk.scale));
    ptMats.push(camMatrix(c, 1));
  }
  const fin = s.fadeIn ? E.out(clamp(t / s.fadeIn, 0, 1)) : 1;
  const fout = s.fadeOut ? 1 - E.in(clamp((t - (s.dur - s.fadeOut)) / s.fadeOut, 0, 1)) : 1;
  const vis = Math.min(fin, fout);
  return {
    glow: 0.12,
    vignette: clamp((c0.z - 1) / 2, 0, 1) * 0.22,
    layers: [{
      url: `/raw/${tk.name}/f${String(fi).padStart(5, "0")}.jpg`,
      samples, ptMats,
      pointer: s.pointer ? pointerAt(tk, fi) : null,
      alpha: vis,
      blur: (1 - vis) * 16,
      bright: (0.55 + 0.45 * vis).toFixed(3),
    }],
  };
}

// ---------------------------------------------------------------- the edit
function edit() {
  const shots = require("./shots.cjs")({ take, has, footage, card, logo, fit, bound, timeOf, FULL, VIEW, FPS });
  return shots;
}

// ---------------------------------------------------------------- render
async function encode(master) {
  const name = process.env.NAME || "showreel";
  const vf = `scale=${process.env.OUT_W || 1600}:-2:flags=lanczos`;
  const enc = (...args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", master, ...args]);
  enc("-vf", vf, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", process.env.VP9_CRF || "40", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2", "-an", path.join(OUT, `${name}.webm`));
  enc("-vf", vf, "-c:v", "libx264", "-preset", "slow", "-crf", process.env.X264_CRF || "29", "-profile:v", "high", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", path.join(OUT, `${name}.mp4`));
  const posterAt = edit().posterAt || 0;
  enc("-ss", String(posterAt), "-frames:v", "1", "-vf", vf, "-c:v", "libwebp", "-quality", "82", path.join(OUT, `${name}-poster.webp`));
  for (const ext of [".webm", ".mp4", "-poster.webp"]) {
    const f = path.join(OUT, name + ext);
    console.log(`${path.relative(process.cwd(), f)}: ${(fs.statSync(f).size / 1e6).toFixed(2)} MB`);
  }
}

(async () => {
  if (process.env.MASTER) return encode(process.env.MASTER);
  const shots = edit();
  const starts = [];
  let total = 0;
  for (const s of shots) { starts.push(total); total += s.dur; }
  const nFrames = Math.round((total / 1000) * FPS);
  const from = Math.round((+process.env.FROM || 0) * FPS), to = Math.min(nFrames, process.env.TO ? Math.round(+process.env.TO * FPS) : nFrames);
  const sheet = !!process.env.SHEET;
  console.log(`${shots.length} shots, ${(total / 1000).toFixed(2)} s, ${nFrames} frames`);

  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })).newPage();
  const files = {
    "/": path.join(__dirname, "editor.html"),
    "/icon.png": path.join(SITE, "..", "assets", "icon", "icon-512.png"),
    "/font/ibm-plex-sans-latin-wght-normal.woff2": path.join(SITE, "node_modules", "@fontsource-variable", "ibm-plex-sans", "files", "ibm-plex-sans-latin-wght-normal.woff2"),
  };
  await page.route("http://showreel.edit/**", (route) => {
    const p = new URL(route.request().url()).pathname;
    const file = p.startsWith("/raw/") ? path.join(RAW, p.slice(5)) : files[p];
    if (!file || !fs.existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith(".html") ? "text/html" : undefined });
  });
  await page.goto("http://showreel.edit/");
  await page.evaluate(() => window.ready());
  const wordWidth = await page.evaluate(() => window.wordWidth());
  for (const s of shots) if (s.kind === "logo") s.wordWidth = wordWidth;
  const cdp = await page.context().newCDPSession(page);

  fs.mkdirSync(OUT, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "showreel-edit-"));
  const master = path.join(work, "master.mp4");
  const ff = sheet ? null : spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
    "-c:v", "libx264", "-preset", "medium", "-crf", "10", "-pix_fmt", "yuv420p", master], { stdio: ["pipe", "inherit", "inherit"] });
  const sheetFrames = [];
  const t0 = Date.now();
  let si = 0;
  for (let i = from; i < to; i++) {
    if (sheet && i % 10) continue;
    const t = (i * 1000) / FPS;
    while (si + 1 < shots.length && t >= starts[si + 1]) si++;
    while (si > 0 && t < starts[si]) si--;
    await page.evaluate((f) => window.render(f), frameSpec(shots[si], t - starts[si]));
    const { data } = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 95, optimizeForSpeed: true });
    const buf = Buffer.from(data, "base64");
    if (sheet) { const f = path.join(work, `s${String(sheetFrames.length).padStart(4, "0")}.jpg`); fs.writeFileSync(f, buf); sheetFrames.push(f); }
    else if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    if (i % 60 === 0) console.log(`frame ${i}/${to} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
  await browser.close();

  if (sheet) {
    const out = path.join(process.env.SHEET_DIR || work, "sheet-%02d.jpg");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "1", "-i", path.join(work, "s%04d.jpg"), "-vf", "scale=480:-1,tile=4x5:padding=4", out]);
    console.log(`contact sheets: ${out}`);
    return;
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
  if (process.env.KEEP_MASTER) fs.copyFileSync(master, process.env.KEEP_MASTER);
  await encode(master);
  fs.rmSync(work, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
