// The showreel's shots, in order (used by edit.cjs). Times are milliseconds from the start of a shot;
// camera positions are in the app's page pixels (1280x800), with z the zoom (1 = the whole window).
// Camera keyframes are placed at moments the recorder saved (pointer presses, marks), so a new
// recording with slightly different timing still cuts together.
module.exports = ({ take, has, footage, card, logo, fit, bound, timeOf, FULL, FPS }) => {
  const shots = [];
  const zoom = (c, k) => bound({ ...c, z: c.z * k });
  const shift = (c, dx, dy) => bound({ ...c, x: c.x + dx, y: c.y + dy });
  const bbox = (pts) => {
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  };
  const union = (a, b) => bbox([{ x: a.x, y: a.y }, { x: a.x + a.w, y: a.y + a.h }, { x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h }]);
  const ptRect = (p, w, h) => ({ x: p.x - w / 2, y: p.y - h / 2, w, h });
  // a camera that follows the spoofed position (smoothed over ±win frames), as keyframes
  function follow(s, tk, f0, f1, z, { dx = 0, dy = 0, every = 3, win = 12 } = {}) {
    const keys = [];
    for (let f = f0; f <= f1; f += every) {
      let sx = 0, sy = 0, n = 0;
      for (let k = f - win; k <= f + win; k++) {
        const p = (tk.frames[Math.max(0, Math.min(tk.frames.length - 1, k))] || {}).p;
        if (p) { sx += p.dx; sy += p.dy; n++; }
      }
      if (n) keys.push({ t: timeOf(s, f), ...bound({ x: sx / n + dx, y: sy / n + dy, z }), ease: "linear" });
    }
    return keys;
  }
  const deviceAt = (tk, f) => (tk.frames[f] && tk.frames[f].p) || null;
  // speed changes given by source frame: [[frame, speed from there on], ...] (real speed before the first)
  function speedUp(s, points) {
    let t = 0, f0 = s.from, v0 = 1;
    s.speed = 1;
    s.ramp = points.map(([f, v]) => { t += ((f - f0) / FPS) * 1000 / v0; f0 = f; v0 = v; return [t, v]; });
  }

  // ---- 1. Route: crop on the map, three clicks; to the list, two drags; to Build route; pull out
  if (has("route")) {
    const tk = take("route");
    const [pa, pb, pc, , , pBuild] = tk.presses;
    const s = footage("route", { from: Math.max(0, pa - 16), fadeIn: 380 });
    speedUp(s, [[tk.mark("list").f + 4, 1.35], [pBuild - 8, 1]]);
    const clicks = [pa, pb, pc].map((f) => tk.frames[f]);
    const near = (p) => fit(ptRect(p, 560, 350), { pad: 0 });
    const all = fit(bbox(clicks), { pad: 90 });
    const list = fit(tk.mark("list").rect, { pad: 18 });
    const build = fit(tk.mark("build").rect, { pad: 64 });
    const built = timeOf(s, tk.mark("built").f);
    const scroll = timeOf(s, tk.mark("scroll").f);
    s.cam = [
      // from click to click, close in on the map, then all three with the line between them
      { t: 0, ...zoom(near(clicks[0]), 0.86) },
      { t: timeOf(s, pa) - 40, ...near(clicks[0]), ease: "out" },
      { t: timeOf(s, pa) + 160, ...near(clicks[0]), ease: "linear" },
      { t: timeOf(s, pb) - 40, ...near(clicks[1]), ease: "inOut" },
      { t: timeOf(s, pb) + 160, ...near(clicks[1]), ease: "linear" },
      { t: timeOf(s, pc) - 40, ...near(clicks[2]), ease: "inOut" },
      { t: timeOf(s, pc) + 200, ...near(clicks[2]), ease: "linear" },
      { t: timeOf(s, pc) + 650, ...all, ease: "inOut" },
      { t: scroll - 40, ...zoom(all, 1.03), ease: "linear" },
      { t: scroll + 340, ...list, ease: "whip" },
      { t: timeOf(s, pBuild) - 520, ...zoom(list, 1.05), ease: "linear" },
      { t: timeOf(s, pBuild) - 90, ...build, ease: "whip" },
      { t: built + 550, ...zoom(build, 1.06), ease: "linear" },
      { t: built + 1250, ...FULL, ease: "inOut" },
    ];
    s.dur = Math.min(built + 2150, timeOf(s, tk.frames.length - 1));
    s.fadeOut = 280;
    shots.push(s);
    shots.posterAt = (built + 1700) / 1000;
  }

  if (has("route")) shots.push(card("Real [roads.] Real [speeds.]", { dur: 1450, gap: 150 }));

  // ---- 2. Playback: Play, then follow the iPhone along the route, the live speed, pull out
  if (has("playback")) {
    const tk = take("playback");
    const play = tk.presses[0];
    const s = footage("playback", { from: Math.max(0, play - 20), fadeIn: 260 });
    const player = fit(tk.mark("player").rect, { pad: 16 });
    const hudMark = tk.mark("hud");
    const hud = fit(hudMark.rect, { pad: 70, maxZ: 3.2 });
    const tPlay = timeOf(s, play);
    const f0 = play + 14, f1 = play + 14 + 66;
    const trail = follow(s, tk, f0, f1, 1.8, { dy: 40 });
    const tHud = timeOf(s, f1) + 330;
    s.cam = [
      { t: 0, ...zoom(player, 1.1) },
      { t: tPlay + 100, ...player, ease: "out" },
      { t: tPlay + 260, ...player, ease: "linear" },
      ...trail.map((k, i) => (i === 0 ? { ...k, t: Math.max(k.t, tPlay + 600), ease: "whip" } : k)),
      { t: tHud, ...hud, ease: "whip" },
      { t: tHud + 1300, ...zoom(hud, 1.06), ease: "linear" },
      { t: tHud + 2050, ...FULL, ease: "inOut" },
    ];
    s.dur = Math.min(tHud + 2800, timeOf(s, tk.frames.length - 1));
    s.fadeOut = 280;
    shots.push(s);
  }

  if (has("playback")) shots.push(card("Jump [anywhere.]", { dur: 1200, gap: 170 }));

  // ---- 3. Teleport: the Teleport tab, type a place, pick the result, Teleport here
  if (has("teleport")) {
    const tk = take("teleport");
    const [pTab, pSearch, pResult, pTeleport] = tk.presses;
    const s = footage("teleport", { from: Math.max(0, pTab - 14), fadeIn: 260 });
    speedUp(s, [[pSearch + 4, 1.5], [tk.mark("results").f - 4, 1]]);
    const tabs = fit({ x: 10, y: 140, w: 372, h: 230 }, { pad: 14 });
    const search = fit(ptRect(tk.frames[pSearch], 360, 40), { pad: 56 });
    const results = fit(tk.mark("results").rect, { pad: 30, maxZ: 2.8 });
    const paris = fit({ x: 836 - 230, y: 400 - 140, w: 460, h: 280 }, { pad: 0 });
    const teleport = fit(tk.mark("teleport").rect, { pad: 90 });
    const tEnd = timeOf(s, tk.frames.length - 1);
    s.cam = [
      { t: 0, ...zoom(tabs, 1.08) },
      { t: timeOf(s, pTab) + 200, ...tabs, ease: "out" },
      { t: timeOf(s, pSearch) - 380, ...tabs, ease: "linear" },
      { t: timeOf(s, pSearch) - 40, ...search, ease: "whip" },
      { t: timeOf(s, tk.mark("results").f) - 300, ...zoom(search, 1.04), ease: "linear" },
      { t: timeOf(s, tk.mark("results").f) + 60, ...results, ease: "whip" },
      { t: timeOf(s, pResult) + 60, ...zoom(results, 1.04), ease: "linear" },
      { t: timeOf(s, pResult) + 420, ...paris, ease: "whip" },
      { t: timeOf(s, pTeleport) - 420, ...zoom(paris, 1.06), ease: "linear" },
      { t: timeOf(s, pTeleport) - 60, ...teleport, ease: "whip" },
      { t: timeOf(s, pTeleport) + 420, ...teleport, ease: "linear" },
      { t: timeOf(s, pTeleport) + 1150, ...FULL, ease: "inOut" },
    ];
    s.dur = Math.min(timeOf(s, pTeleport) + 2050, tEnd);
    s.fadeOut = 280;
    shots.push(s);
  }

  if (has("teleport")) shots.push(card("Or drive it [live.]", { dur: 1200, gap: 160 }));

  // ---- 4. Joystick: the pad and the iPhone moving on the map in one frame
  if (has("joystick")) {
    const tk = take("joystick");
    const pads = tk.presses;
    const pPreset = pads[1];
    const s = footage("joystick", { from: Math.max(0, pPreset - 16), fadeIn: 260 });
    const pad = tk.mark("pad").rect;
    const path = [];
    for (let f = pPreset; f < tk.frames.length; f += 3) { const d = deviceAt(tk, f); if (d) path.push({ x: d.dx, y: d.dy }); }
    const both = fit(union(pad, bbox(path.length ? path : [{ x: 600, y: 400 }])), { pad: 34 });
    const last = pads[pads.length - 1];
    s.cam = [
      { t: 0, ...zoom(both, 1.12) },
      { t: timeOf(s, last), ...both, ease: "inOut" },
      { t: timeOf(s, last) + 1000, ...zoom(both, 0.98), ease: "linear" },
      { t: timeOf(s, last) + 1550, ...FULL, ease: "inOut" },
    ];
    s.dur = Math.min(timeOf(s, last) + 1950, timeOf(s, tk.frames.length - 1));
    s.fadeOut = 280;
    shots.push(s);
  }

  if (has("joystick")) shots.push(card("Make it [yours.]", { dur: 1100, gap: 170 }));

  // ---- 5. Maps and colours: the map menu (satellite, light), then a run through the colour themes
  if (has("themes")) {
    const tk = take("themes");
    const p = tk.presses;
    const [pMenu, pSat, pVector, pLight, pDark, pSettings] = p;
    const themeClicks = p.slice(7);
    const s = footage("themes", { from: Math.max(0, pMenu - 12), fadeIn: 260 });
    const lastTheme = themeClicks[themeClicks.length - 1];
    speedUp(s, [[pSat + 15, 2], [pLight - 6, 1], [pLight + 16, 2.2], [themeClicks[0] - 8, 1.5], [lastTheme + 6, 1.6]]);
    const menu = fit(bbox([pMenu, pSat, pVector, pLight, pDark].map((f) => tk.frames[f])), { pad: 150 });
    const grid = fit(bbox(themeClicks.map((f) => tk.frames[f])), { pad: 150 });
    s.cam = [
      { t: 0, ...zoom(menu, 1.1) },
      { t: timeOf(s, pSat), ...menu, ease: "out" },
      { t: timeOf(s, pSat) + 200, ...menu, ease: "linear" },
      { t: timeOf(s, pSat) + 700, ...zoom(menu, 0.75), ease: "inOut" },
      { t: timeOf(s, pDark) + 100, ...zoom(menu, 0.75), ease: "linear" },
      { t: timeOf(s, pSettings) - 120, ...shift(zoom(grid, 0.8), 0, -40), ease: "whip" },
      { t: timeOf(s, themeClicks[0]) - 60, ...grid, ease: "inOut" },
      { t: timeOf(s, lastTheme), ...zoom(grid, 1.05), ease: "linear" },
      { t: timeOf(s, lastTheme) + 800, ...FULL, ease: "inOut" },
    ];
    s.dur = Math.min(timeOf(s, lastTheme) + 1500, timeOf(s, tk.frames.length - 1));
    s.fadeOut = 420;
    shots.push(s);
  }

  // ---- the name
  shots.push(logo(3300, "<b>Free</b> for Windows · iPhone &amp; iPad"));
  return shots;
};
