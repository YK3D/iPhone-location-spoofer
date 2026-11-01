/* iPhone Location Spoofer — browser UI. Talks to the local Python server at /api. */
"use strict";

// ------------------------------------------------------------------ helpers
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) e.append(kid);
  return e;
};

async function api(path, opts = {}) {
  const init = { method: opts.method || (opts.body !== undefined ? "POST" : "GET"), headers: {} };
  if (opts.body instanceof FormData) init.body = opts.body;
  else if (opts.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  const r = await fetch(path, init);
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok) {
    let msg = data && data.detail !== undefined ? data.detail : data;
    if (Array.isArray(msg)) msg = msg.map((d) => `${(d.loc || []).slice(1).join(".")}: ${d.msg}`).join("; ");
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), isErr ? 7000 : 3000);
}
const guard = (fn) => async (...a) => {
  try { await fn(...a); } catch (e) { toast(e.message || String(e), true); console.error(e); }
};

const fmtTime = (s) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};
const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 100000 ? 0 : 2)} km` : `${Math.round(m)} m`);
const fmtLL = (lat, lon) => `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
const numOrNull = (v) => (v === "" || v == null || isNaN(+v) ? null : +v);
const haversine = (a, b) => {
  const R = 6371008.8, toR = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toR, dLon = (b[1] - a[1]) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

const MODE_LABEL = { foot: "Footpaths", bike: "Cycle paths", car: "Roads", sea: "Sea lanes", straight: "Straight" };
const MODE_COLOR = { foot: "#2e7d32", bike: "#6a1b9a", car: "#1565c0", sea: "#00838f", straight: "#ef6c00" };
const SPEED_PRESETS = [
  ["Walk", 5, 0.5], ["Jog", 10, 0.8], ["Cycle", 18, 1.0], ["City car", 50, 2.0],
  ["Highway", 110, 2.5], ["Boat", 35, 0.3], ["Train", 160, 0.8], ["Plane", 850, 2.0],
];

// ------------------------------------------------------------------ state
const state = {
  tab: "teleport",
  picked: null,            // [lat, lon]
  waypoints: [],           // {id, lat, lon, name, speed_kmh, dwell_s, leg:{mode,cruise_kmh,ramp}}
  built: null,             // last /api/route/build or /api/gpx/timeline response
  builtSource: null,       // "route" | "gpx"
  gpx: null,               // last import response
  gpxIndex: 0,
  store: { favorites: [], routes: [], settings: {} },
  status: null,
  preview: null,           // {raf, start, data}
  seeking: false,
};
let nextId = 1;

// ------------------------------------------------------------------ map
const map = L.map("map", { zoomControl: true }).setView([51.505, -0.09], 13);
const baseLayers = {
  "Streets": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }),
  "Satellite": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19, attribution: "Imagery &copy; Esri" }),
  "Topographic": L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxZoom: 17, attribution: "&copy; OpenStreetMap contributors, SRTM | &copy; OpenTopoMap (CC-BY-SA)" }),
};
baseLayers.Streets.addTo(map);
L.control.layers(baseLayers).addTo(map);
L.control.scale().addTo(map);

const routeLayer = L.layerGroup().addTo(map);
const wpLayer = L.layerGroup().addTo(map);
const gpxLayer = L.layerGroup().addTo(map);
let pickMarker = null, deviceMarker = null, previewMarker = null, trailLine = null;
const icon = (cls, html = "") => L.divIcon({ className: cls, html, iconSize: null });

map.on("click", (e) => {
  const { lat, lng } = e.latlng;
  const lon = ((lng + 180) % 360 + 360) % 360 - 180;
  if (state.tab === "route") addWaypoint(lat, lon);
  else setPicked(lat, lon, false);
});

// Right-click (or long-press) menu-free shortcut: teleport immediately.
map.on("contextmenu", guard(async (e) => {
  const lon = ((e.latlng.lng + 180) % 360 + 360) % 360 - 180;
  setPicked(e.latlng.lat, lon, false);
  await teleport();
}));

// ------------------------------------------------------------------ tabs
document.querySelectorAll(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    state.tab = b.dataset.tab;
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".tab-panel").forEach((p) => (p.hidden = p.id !== `tab-${state.tab}`));
    map.getContainer().style.cursor = state.tab === "route" ? "crosshair" : "";
  })
);

// ------------------------------------------------------------------ device
async function refreshDevices() {
  const driver = $("driver").value;
  const sel = $("device-select");
  sel.replaceChildren(el("option", { value: "", textContent: "First connected iPhone" }));
  try {
    const { devices } = await api(`/api/devices?driver=${driver}`);
    for (const d of devices) {
      const label = `${d.name || "iPhone"}${d.ios_version ? ` (iOS ${d.ios_version})` : ""} — ${d.connection || ""}${d.error ? " ⚠" : ""}`;
      sel.append(el("option", { value: d.udid, textContent: label, title: d.error || d.udid }));
    }
    if (!devices.length) toast("No device found. Plug in the iPhone, unlock it and tap Trust.", true);
  } catch (e) {
    toast(e.message, true);
  }
}
$("btn-refresh").onclick = refreshDevices;
$("driver").onchange = refreshDevices;

$("btn-connect").onclick = guard(async () => {
  $("btn-connect").disabled = true;
  $("device-status").textContent = "Connecting… (iOS 17+ can take up to 30 s)";
  try {
    const { device } = await api("/api/connect", { body: { driver: $("driver").value, udid: $("device-select").value || null } });
    toast(`Connected to ${device.name}`);
    for (const n of device.notes || []) toast(n);
  } finally {
    $("btn-connect").disabled = false;
    await poll();
  }
});
$("btn-disconnect").onclick = guard(async () => { await api("/api/disconnect", { body: {} }); await poll(); });
$("btn-reveal").onclick = guard(async () => toast((await api("/api/device/reveal-developer-mode", { body: {} })).message));
$("btn-mount").onclick = guard(async () => {
  toast("Mounting… this can download ~20 MB the first time");
  toast((await api("/api/device/mount", { body: {} })).message);
});
$("btn-clear").onclick = guard(async () => {
  await api("/api/location/clear", { body: {} });
  toast("Location simulation stopped. The iPhone uses its real GPS again.");
  await poll();
});

function renderDevice(st) {
  const d = st.device;
  const box = $("device-status");
  $("btn-connect").hidden = !!d;
  $("btn-disconnect").hidden = !d;
  if (d) {
    box.className = "status ok";
    box.textContent = `● ${d.name}${d.ios_version ? ` · iOS ${d.ios_version}` : ""} · ${d.transport}`;
  } else {
    box.className = "status";
    box.textContent = "Not connected";
  }
  if (d) $("driver").value = st.driver; // when disconnected, keep whatever the user picked
}

// ------------------------------------------------------------------ teleport
function setPicked(lat, lon, pan = true) {
  state.picked = [lat, lon];
  if (!pickMarker) pickMarker = L.marker([lat, lon], { icon: icon("pick-icon"), draggable: true })
    .on("dragend", (e) => { const p = e.target.getLatLng(); setPicked(p.lat, p.lng, false); })
    .addTo(map);
  else pickMarker.setLatLng([lat, lon]);
  if (pan) map.setView([lat, lon], Math.max(map.getZoom(), 15));
  $("picked").textContent = fmtLL(lat, lon);
  $("picked").classList.remove("muted");
  ["btn-teleport", "btn-fav", "btn-copy", "btn-pick-to-route"].forEach((id) => ($(id).disabled = false));
  $("coords").value = fmtLL(lat, lon);
  updateJumpInfo();
}

function updateJumpInfo() {
  const pos = state.status && state.status.player.position;
  if (!pos || !state.picked) { $("jump-info").textContent = ""; return; }
  const d = haversine([pos.lat, pos.lon], state.picked);
  const walk = d / (5 / 3.6), drive = d / (60 / 3.6), fly = d / (800 / 3.6);
  $("jump-info").textContent =
    `Jump of ${fmtDist(d)} from the current spoofed spot. Real travel time: walking ${fmtTime(walk)}, ` +
    `driving ${fmtTime(drive)}, flying ${fmtTime(fly)}. Apps may flag instant long jumps; a route looks more natural.`;
}

async function teleport() {
  if (!state.picked) return;
  const r = await api("/api/location/set", { body: { lat: state.picked[0], lon: state.picked[1] } });
  toast(`Location set to ${fmtLL(r.lat, r.lon)}${r.jump_m ? ` (jumped ${fmtDist(r.jump_m)})` : ""}`);
  await poll();
}
$("btn-teleport").onclick = guard(teleport);
$("btn-copy").onclick = guard(async () => {
  await navigator.clipboard.writeText(fmtLL(...state.picked));
  toast("Copied");
});
$("btn-fav").onclick = guard(async () => {
  const name = prompt("Name for this place:", "Favourite " + (state.store.favorites.length + 1));
  if (name === null) return;
  state.store.favorites.push({ name: name || "Favourite", lat: state.picked[0], lon: state.picked[1] });
  await saveStore();
  toast("Saved to favourites");
});
$("btn-pick-to-route").onclick = () => { addWaypoint(...state.picked); toast("Added to the route (Route tab)"); };

$("btn-coords").onclick = guard(async () => {
  const { lat, lon } = await api("/api/parse-coords", { body: { text: $("coords").value } });
  setPicked(lat, lon);
});
$("coords").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btn-coords").click(); });

$("search").addEventListener("keydown", guard(async (e) => {
  if (e.key !== "Enter") return;
  const q = $("search").value.trim();
  const list = $("search-results");
  list.replaceChildren();
  if (!q) return;
  // Coordinates typed into search work too
  try { const { lat, lon } = await api("/api/parse-coords", { body: { text: q } }); setPicked(lat, lon); return; } catch (_) {}
  const { results } = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
  if (!results.length) list.append(el("li", { textContent: "No results" }));
  for (const r of results) {
    list.append(el("li", { textContent: r.name, onclick: () => { setPicked(r.lat, r.lon); list.replaceChildren(); } }));
  }
}));

// ------------------------------------------------------------------ route builder
function defaultLeg() {
  return { mode: $("default-mode").value, cruise_kmh: null, ramp: "accel" };
}
function addWaypoint(lat, lon, extra = {}) {
  state.waypoints.push({ id: nextId++, lat, lon, name: "", speed_kmh: null, dwell_s: 0, leg: defaultLeg(), ...extra });
  invalidateBuilt();
  renderWaypoints();
}

function invalidateBuilt() {
  if (state.builtSource === "route") {
    routeLayer.clearLayers();
    $("route-result").replaceChildren();
    state.built = null;
  }
}

function renderWaypoints() {
  const list = $("waypoints");
  list.replaceChildren();
  wpLayer.clearLayers();
  const n = state.waypoints.length;
  const closed = $("closed").checked;
  if (!n) list.append(el("li", { class: "hint", textContent: "No checkpoints yet — click the map." }));

  state.waypoints.forEach((w, i) => {
    const change = (fn) => (e) => { fn(e.target); invalidateBuilt(); };
    const head = el("div", { class: "wp-head" },
      el("span", { class: "wp-num", textContent: i + 1 }),
      el("input", { value: w.name, placeholder: fmtLL(w.lat, w.lon), title: "Name",
        oninput: (e) => (w.name = e.target.value) }),
      el("button", { class: "small", textContent: "↑", title: "Move up", disabled: i === 0,
        onclick: () => { [state.waypoints[i - 1], state.waypoints[i]] = [state.waypoints[i], state.waypoints[i - 1]]; invalidateBuilt(); renderWaypoints(); } }),
      el("button", { class: "small", textContent: "↓", title: "Move down", disabled: i === n - 1,
        onclick: () => { [state.waypoints[i + 1], state.waypoints[i]] = [state.waypoints[i], state.waypoints[i + 1]]; invalidateBuilt(); renderWaypoints(); } }),
      el("button", { class: "small", textContent: "✕", title: "Remove",
        onclick: () => { state.waypoints.splice(i, 1); invalidateBuilt(); renderWaypoints(); } }),
    );
    const fields = el("div", { class: "wp-fields" },
      el("label", {}, "Speed here (km/h)",
        el("input", { type: "number", min: 0, step: 0.1, value: w.speed_kmh ?? "", placeholder: "auto",
          title: "Exact speed when passing this checkpoint. Blank = whatever the limits allow. 0 = come to a stop.",
          onchange: change((t) => (w.speed_kmh = numOrNull(t.value))) })),
      el("label", {}, "Wait here (s)",
        el("input", { type: "number", min: 0, step: 1, value: w.dwell_s || "", placeholder: "0",
          title: "Stop and wait this long",
          onchange: change((t) => (w.dwell_s = Math.max(0, +t.value || 0))) })),
    );
    const li = el("li", { class: "wp" }, head, fields);

    if (i < n - 1 || (closed && n > 1)) {
      const modeSel = el("select", { title: "How this leg is routed", onchange: change((t) => { w.leg.mode = t.value; }) },
        ...Object.entries(MODE_LABEL).map(([k, v]) => el("option", { value: k, textContent: v, selected: w.leg.mode === k })));
      const cruise = el("input", { type: "number", min: 0.1, step: 0.1, value: w.leg.cruise_kmh ?? "",
        placeholder: `${$("default-speed").value} km/h`, title: "Cruise speed for this leg (km/h). Blank = default.",
        onchange: change((t) => (w.leg.cruise_kmh = numOrNull(t.value))) });
      const ramp = el("select", { title: "How speed changes on this leg", onchange: change((t) => (w.leg.ramp = t.value)) },
        el("option", { value: "accel", textContent: "Accel rate", selected: w.leg.ramp === "accel" }),
        el("option", { value: "linear", textContent: "Even ramp", selected: w.leg.ramp === "linear" }));
      li.append(el("div", { class: "leg", title: `Leg ${i + 1} → ${i + 2 > n ? 1 : i + 2}` }, modeSel, cruise, ramp));
    }
    list.append(li);

    L.marker([w.lat, w.lon], { draggable: true, icon: icon("wp-icon", String(i + 1)), title: w.name || `Checkpoint ${i + 1}` })
      .on("dragend", (e) => { const p = e.target.getLatLng(); w.lat = p.lat; w.lon = p.lng; invalidateBuilt(); renderWaypoints(); })
      .addTo(wpLayer);
  });

  if (!state.built || state.builtSource !== "route") {
    const pts = state.waypoints.map((w) => [w.lat, w.lon]);
    if (closed && pts.length > 1) pts.push(pts[0]);
    if (pts.length > 1) L.polyline(pts, { color: "#888", weight: 2, dashArray: "4 6" }).addTo(wpLayer);
  }
}
$("closed").onchange = () => { invalidateBuilt(); renderWaypoints(); };
$("default-speed").onchange = () => renderWaypoints();
$("btn-clear-route").onclick = () => {
  if (state.waypoints.length && !confirm("Remove all checkpoints?")) return;
  state.waypoints = []; invalidateBuilt(); renderWaypoints();
};
$("btn-reverse").onclick = () => {
  const legs = state.waypoints.map((w) => w.leg);
  state.waypoints.reverse();
  // leg i now runs from new i to new i+1, which was old leg (n-2-i)
  const n = state.waypoints.length;
  state.waypoints.forEach((w, i) => (w.leg = { ...(legs[n - 2 - i] || defaultLeg()) }));
  invalidateBuilt(); renderWaypoints();
};

function presetButtons(containerId, onPick) {
  const c = $(containerId);
  for (const [name, kmh, acc] of SPEED_PRESETS) {
    c.append(el("button", { textContent: `${name} ${kmh}`, title: `${kmh} km/h, ${acc} m/s²`, onclick: () => onPick(kmh, acc) }));
  }
}
presetButtons("speed-presets", (kmh, acc) => {
  $("default-speed").value = kmh; $("accel").value = acc; $("decel").value = acc;
  invalidateBuilt(); renderWaypoints();
});

function profileSettings() {
  return {
    default_cruise_kmh: +$("default-speed").value || 5,
    accel_ms2: +$("accel").value || 1,
    decel_ms2: +$("decel").value || 1,
    start_from_rest: $("start-rest").checked,
    stop_at_end: $("stop-end").checked,
  };
}

function routeBody(name = "Route") {
  const wps = state.waypoints;
  const closed = $("closed").checked;
  const legs = wps.slice(0, closed ? wps.length : wps.length - 1).map((w) => w.leg);
  return {
    name,
    closed,
    settings: profileSettings(),
    waypoints: wps.map((w, i) => ({ lat: w.lat, lon: w.lon, name: w.name || `Checkpoint ${i + 1}`, speed_kmh: w.speed_kmh, dwell_s: w.dwell_s || 0 })),
    legs,
  };
}

$("btn-build").onclick = guard(async () => {
  if (state.waypoints.length < 2) throw new Error("Add at least two checkpoints");
  $("btn-build").disabled = true;
  $("btn-build").textContent = "Routing…";
  try {
    const body = routeBody($("route-name").value || "Route");
    const res = await api("/api/route/build", { body });
    state.built = res;
    state.builtSource = "route";
    drawBuilt(res, routeLayer, body.legs.map((l) => l.mode));
    renderResult($("route-result"), res);
    renderWaypoints();
    await api(`/api/player/load/${res.id}`, { body: {} });
    await poll();
  } finally {
    $("btn-build").disabled = false;
    $("btn-build").textContent = "Build route";
  }
});

function drawBuilt(res, layer, modes = []) {
  layer.clearLayers();
  const all = [];
  (res.legs || []).forEach((pts, i) => {
    const m = modes[i] || "straight";
    L.polyline(pts, { color: MODE_COLOR[m] || "#1565c0", weight: 4, opacity: 0.85 }).addTo(layer);
    all.push(...pts);
  });
  if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [30, 30] });
}

function renderResult(box, res) {
  const s = res.summary;
  const intervalSel = el("select", {}, ...[0.5, 1, 2, 5, 10].map((v) => el("option", { value: v, textContent: `${v}s`, selected: v === 1 })));
  box.replaceChildren(
    el("div", { class: "summary" },
      el("span", {}, "Distance ", el("b", { textContent: fmtDist(s.distance_m) })),
      el("span", {}, "Duration ", el("b", { textContent: fmtTime(s.duration_s) })),
      el("span", {}, "Average ", el("b", { textContent: `${s.avg_speed_kmh} km/h` })),
      el("span", {}, "Top speed ", el("b", { textContent: `${s.max_speed_kmh} km/h` })),
    ),
    ...(s.warnings || []).map((w) => el("p", { class: "warn", textContent: "⚠ " + w })),
    chartCanvas(res.preview),
    el("div", { class: "row wrap" },
      el("button", { class: "grow", textContent: "▷ Preview on map", onclick: () => togglePreview(res) }),
      el("label", { class: "button", title: "Seconds between GPX points" }, "GPX every ", intervalSel),
      el("button", { textContent: "⇩ Download GPX", onclick: () => {
        window.location.href = `/api/gpx/export/${res.id}?interval=${intervalSel.value || 1}`;
      } }),
    ),
  );
}

function chartCanvas(preview) {
  const c = el("canvas", { class: "chart", title: "Speed (km/h) over time" });
  requestAnimationFrame(() => {
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 340, h = c.clientHeight || 110;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext("2d");
    g.scale(dpr, dpr);
    if (!preview || preview.length < 2) return;
    const T = preview[preview.length - 1][0] || 1;
    const V = Math.max(1, ...preview.map((p) => p[3]));
    const pad = { l: 34, r: 6, t: 8, b: 16 };
    const x = (t) => pad.l + (t / T) * (w - pad.l - pad.r);
    const y = (v) => h - pad.b - (v / V) * (h - pad.t - pad.b);
    g.strokeStyle = cssVar("--border"); g.lineWidth = 1;
    g.beginPath(); g.moveTo(pad.l, pad.t); g.lineTo(pad.l, h - pad.b); g.lineTo(w - pad.r, h - pad.b); g.stroke();
    g.fillStyle = cssVar("--muted"); g.font = "10px system-ui";
    g.fillText(`${Math.round(V)}`, 4, pad.t + 8); g.fillText("0", 4, h - pad.b);
    g.fillText(fmtTime(T), w - pad.r - 34, h - 3); g.fillText("km/h", 4, h - 3);
    g.strokeStyle = cssVar("--accent"); g.lineWidth = 1.5;
    g.beginPath();
    preview.forEach((p, i) => (i ? g.lineTo(x(p[0]), y(p[3])) : g.moveTo(x(p[0]), y(p[3]))));
    g.stroke();
  });
  return c;
}

// Local animation of a built route (does not touch the phone)
function togglePreview(res) {
  if (state.preview) { stopPreview(); return; }
  const data = res.preview;
  if (!data || data.length < 2) return;
  const mult = Math.max(1, data[data.length - 1][0] / 20); // whole route in ~20 s
  previewMarker = L.marker([data[0][1], data[0][2]], { icon: icon("prev-icon"), interactive: false }).addTo(map);
  const t0 = performance.now();
  let i = 0;
  const step = (now) => {
    const t = ((now - t0) / 1000) * mult;
    while (i < data.length - 2 && data[i + 1][0] < t) i++;
    const a = data[i], b = data[i + 1];
    if (t >= data[data.length - 1][0]) { stopPreview(); return; }
    const f = b[0] > a[0] ? Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))) : 0;
    previewMarker.setLatLng([a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
    state.preview.raf = requestAnimationFrame(step);
  };
  state.preview = { raf: requestAnimationFrame(step) };
  toast(`Previewing at ${Math.round(mult)}× speed`);
}
function stopPreview() {
  if (state.preview) cancelAnimationFrame(state.preview.raf);
  state.preview = null;
  if (previewMarker) { map.removeLayer(previewMarker); previewMarker = null; }
}

// Random wander
$("btn-wander").onclick = () => {
  const c = state.picked || [map.getCenter().lat, map.getCenter().lng];
  const R = Math.max(20, +$("wander-radius").value || 500);
  const n = Math.min(50, Math.max(2, +$("wander-count").value || 6));
  const pts = [c];
  for (let k = 1; k < n; k++) {
    const r = R * Math.sqrt(Math.random()), a = Math.random() * 2 * Math.PI;
    const dLat = (r * Math.cos(a)) / 111320;
    const dLon = (r * Math.sin(a)) / (111320 * Math.cos((c[0] * Math.PI) / 180));
    pts.push([c[0] + dLat, c[1] + dLon]);
  }
  state.waypoints = [];
  pts.forEach(([la, lo]) => state.waypoints.push({ id: nextId++, lat: la, lon: lo, name: "", speed_kmh: null, dwell_s: 0, leg: defaultLeg() }));
  // random short pauses make a wander look more natural
  state.waypoints.slice(1, -1).forEach((w) => (w.dwell_s = Math.random() < 0.4 ? Math.round(5 + Math.random() * 40) : 0));
  invalidateBuilt(); renderWaypoints();
  toast(`Generated ${n} checkpoints. Press Build route.`);
};

// ------------------------------------------------------------------ GPX import
$("gpx-file").onchange = guard(async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const fd = new FormData();
  fd.append("file", f);
  const res = await api("/api/gpx/import", { body: fd });
  state.gpx = res;
  state.gpxIndex = 0;
  const box = $("gpx-tracks");
  box.replaceChildren();
  const sel = el("select", { onchange: (ev) => { state.gpxIndex = +ev.target.value; showGpxTrack(); } },
    ...res.tracks.map((t, i) => el("option", { value: i, textContent: `${t.name} — ${t.kind}, ${t.points.length} points${t.timed ? ", timed" : ""}` })));
  box.append(el("label", {}, "Track", sel));
  $("gpx-options").hidden = false;
  showGpxTrack();
  e.target.value = "";
});

function showGpxTrack() {
  const t = state.gpx.tracks[state.gpxIndex];
  gpxLayer.clearLayers();
  const pts = t.points.map((p) => [p[0], p[1]]);
  if (t.kind === "waypoints") pts.forEach((p) => L.circleMarker(p, { radius: 5, color: "#ef6c00" }).addTo(gpxLayer));
  else L.polyline(pts, { color: "#ef6c00", weight: 4 }).addTo(gpxLayer);
  if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [30, 30] });
  $("gpx-use-times").checked = t.timed;
  $("gpx-use-times").disabled = !t.timed;
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += haversine(pts[i - 1], pts[i]);
  const dur = t.timed ? t.points[t.points.length - 1][2] - t.points[0][2] : null;
  $("gpx-result").replaceChildren(el("p", { class: "hint", textContent:
    `${fmtDist(len)}${dur ? `, recorded over ${fmtTime(dur)} (avg ${(len / dur * 3.6).toFixed(1)} km/h)` : ", no timestamps — it will be timed with the speed below"}` }));
}

$("btn-gpx-load").onclick = guard(async () => {
  const t = state.gpx.tracks[state.gpxIndex];
  const res = await api("/api/gpx/timeline", { body: {
    name: t.name, points: t.points, use_times: $("gpx-use-times").checked, reverse: $("gpx-reverse").checked,
    cruise_kmh: +$("gpx-speed").value || 5, settings: profileSettings(),
  } });
  state.built = res;
  state.builtSource = "gpx";
  drawBuilt(res, gpxLayer, ["straight"]);
  renderResult($("gpx-result"), res);
  await api(`/api/player/load/${res.id}`, { body: {} });
  await poll();
});

// Douglas–Peucker simplification (planar, metres via equirectangular projection)
function simplify(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const lat0 = (pts[0][0] * Math.PI) / 180;
  const P = pts.map(([la, lo]) => [lo * 111320 * Math.cos(lat0), la * 110540]);
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1, bi = -1;
    const [ax, ay] = P[a], [bx, by] = P[b];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-9;
    for (let i = a + 1; i < b; i++) {
      const t = Math.max(0, Math.min(1, ((P[i][0] - ax) * dx + (P[i][1] - ay) * dy) / L2));
      const d = Math.hypot(P[i][0] - ax - t * dx, P[i][1] - ay - t * dy);
      if (d > best) { best = d; bi = i; }
    }
    if (best > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

$("btn-gpx-to-route").onclick = () => {
  const t = state.gpx.tracks[state.gpxIndex];
  let pts = t.points.map((p) => [p[0], p[1]]);
  let tol = 5;
  let s = simplify(pts, tol);
  while (s.length > 60 && tol < 5000) { tol *= 2; s = simplify(pts, tol); }
  state.waypoints = s.map(([la, lo], i) => ({ id: nextId++, lat: la, lon: lo, name: (t.names && t.kind === "waypoints" && t.names[i]) || "",
    speed_kmh: null, dwell_s: 0, leg: { mode: "straight", cruise_kmh: null, ramp: "accel" } }));
  gpxLayer.clearLayers();
  state.builtSource = "route"; invalidateBuilt();
  document.querySelector('.tabs button[data-tab="route"]').click();
  renderWaypoints();
  toast(`Converted to ${s.length} checkpoints (straight legs keep the track's shape). Edit and press Build route.`);
};

// ------------------------------------------------------------------ player
const playerBtns = { play: $("btn-play"), pause: $("btn-pause"), stop: $("btn-stop") };
playerBtns.play.onclick = guard(async () => {
  const st = state.status && state.status.player;
  await api(st && st.state === "paused" ? "/api/player/resume" : "/api/player/play", { body: {} });
  await poll();
});
playerBtns.pause.onclick = guard(async () => { await api("/api/player/pause", { body: {} }); await poll(); });
playerBtns.stop.onclick = guard(async () => { await api("/api/player/stop", { body: {} }); await poll(); });

const seek = $("seek");
seek.addEventListener("input", () => {
  state.seeking = true;
  $("player-time").textContent = `${fmtTime(+seek.value)} / ${fmtTime(+seek.max)}`;
});
seek.addEventListener("change", guard(async () => {
  try { await api("/api/player-seek", { body: { t: +seek.value } }); }
  finally { state.seeking = false; await poll(); }
}));

const sendOptions = guard(async () => {
  await api("/api/player-options", { body: {
    multiplier: +$("multiplier").value, loop: $("loop").value,
    jitter_m: Math.max(0, +$("jitter").value || 0), tick_s: Math.min(10, Math.max(0.2, +$("tick").value || 1)),
  } });
  saveSettingsSoon();
});
["multiplier", "loop", "jitter", "tick"].forEach((id) => $(id).addEventListener("change", sendOptions));

function renderPlayer(st) {
  const p = st.player;
  $("player-name").textContent = p.name || "No route loaded";
  const badge = $("player-state");
  badge.textContent = p.state + (p.laps ? ` · lap ${p.laps + 1}` : "");
  badge.className = "badge " + p.state;
  const has = p.duration > 0 || p.name;
  const connected = !!st.device;
  playerBtns.play.disabled = !has || !connected || p.state === "playing";
  playerBtns.play.textContent = p.state === "paused" ? "▶ Resume" : "▶ Play on device";
  playerBtns.pause.disabled = p.state !== "playing";
  playerBtns.stop.disabled = !["playing", "paused", "joystick"].includes(p.state);
  seek.disabled = !has;
  seek.max = p.duration;
  if (!state.seeking) {
    seek.value = p.t;
    $("player-time").textContent = `${fmtTime(p.t)} / ${fmtTime(p.duration)}`;
  }
  $("player-dist").textContent = `${fmtDist(p.distance_m)} / ${fmtDist(p.total_distance_m)}`;
  $("player-speed").textContent = p.position ? `${p.position.speed_kmh.toFixed(1)} km/h` : "—";
  if (p.state === "error" && p.error && state.lastError !== p.error) { toast(p.error, true); }
  state.lastError = p.error;

  if (p.position) {
    const ll = [p.position.lat, p.position.lon];
    if (!deviceMarker) {
      deviceMarker = L.marker(ll, { icon: icon("dev-icon"), interactive: true, zIndexOffset: 1000, title: "Spoofed location" }).addTo(map);
      trailLine = L.polyline([], { color: "#e53935", weight: 2, opacity: 0.6 }).addTo(map);
    }
    deviceMarker.setLatLng(ll);
    if (["playing", "joystick"].includes(p.state)) {
      const tl = trailLine.getLatLngs();
      tl.push(L.latLng(ll));
      if (tl.length > 2000) tl.shift();
      trailLine.setLatLngs(tl);
      if (state.follow && !map.getBounds().pad(-0.2).contains(ll)) map.panTo(ll);
    }
  } else if (deviceMarker) {
    map.removeLayer(deviceMarker); deviceMarker = null;
    if (trailLine) { map.removeLayer(trailLine); trailLine = null; }
  }
}
state.follow = true;

// ------------------------------------------------------------------ joystick
const held = new Set();
const KEYS = { ArrowUp: [0, 1], KeyW: [0, 1], ArrowDown: [0, -1], KeyS: [0, -1], ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0] };
let joyLast = "";
async function joySend(moving, bearing) {
  const speed = +$("joy-speed").value || 5;
  const key = `${moving}|${bearing}|${speed}`;
  if (key === joyLast) return;
  joyLast = key;
  try {
    await api("/api/joystick", { body: { moving, bearing, speed_kmh: speed } });
    $("joy-info").textContent = moving ? `Moving ${Math.round(bearing)}° at ${speed} km/h` : "Holding position";
  } catch (e) { joyLast = ""; toast(e.message, true); }
}
function keyVector() {
  let x = 0, y = 0;
  for (const k of held) { const v = KEYS[k]; if (v) { x += v[0]; y += v[1]; } }
  return [x, y];
}
document.addEventListener("keydown", (e) => {
  if (state.tab !== "joystick" || !KEYS[e.code] || ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
  e.preventDefault();
  if (held.has(e.code)) return;
  held.add(e.code);
  const [x, y] = keyVector();
  if (x || y) joySend(true, ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360);
});
document.addEventListener("keyup", (e) => {
  if (!held.delete(e.code)) return;
  const [x, y] = keyVector();
  joySend(!!(x || y), x || y ? ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360 : undefined);
});
window.addEventListener("blur", () => { if (held.size) { held.clear(); joySend(false); } });
document.querySelectorAll("#dpad button[data-b]").forEach((b) => {
  const start = (e) => { e.preventDefault(); b.classList.add("held"); joySend(true, +b.dataset.b); };
  const end = () => { if (!b.classList.contains("held")) return; b.classList.remove("held"); joySend(false); };
  b.addEventListener("pointerdown", start);
  b.addEventListener("pointerup", end);
  b.addEventListener("pointerleave", end);
  b.addEventListener("pointercancel", end);
});
$("joy-stop").onclick = guard(async () => { joyLast = ""; await api("/api/player/stop", { body: {} }); $("joy-info").textContent = "Joystick off"; await poll(); });
presetButtons("joy-presets", (kmh) => { $("joy-speed").value = kmh; joyLast = ""; });

// ------------------------------------------------------------------ saved data
async function loadStore() {
  try { state.store = await api("/api/store"); } catch (e) { toast(e.message, true); }
  applySettings(state.store.settings || {});
  renderSaved();
}
async function saveStore() {
  state.store = await api("/api/store", { method: "PUT", body: state.store });
  renderSaved();
}
let settingsTimer;
function saveSettingsSoon() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(guard(async () => {
    state.store.settings = collectSettings();
    await saveStore();
  }), 800);
}
const SETTING_IDS = ["driver", "default-mode", "default-speed", "accel", "decel", "start-rest", "stop-end", "multiplier", "loop", "jitter", "tick", "joy-speed", "gpx-speed"];
function collectSettings() {
  const s = {};
  for (const id of SETTING_IDS) { const e = $(id); s[id] = e.type === "checkbox" ? e.checked : e.value; }
  const c = map.getCenter(); s.view = [c.lat, c.lng, map.getZoom()];
  return s;
}
function applySettings(s) {
  for (const id of SETTING_IDS) {
    if (s[id] === undefined) continue;
    const e = $(id);
    if (e.type === "checkbox") e.checked = !!s[id]; else e.value = s[id];
  }
  if (Array.isArray(s.view)) map.setView([s.view[0], s.view[1]], s.view[2]);
}
SETTING_IDS.forEach((id) => $(id).addEventListener("change", saveSettingsSoon));
map.on("moveend", saveSettingsSoon);

function renderSaved() {
  const fl = $("fav-list");
  fl.replaceChildren();
  if (!state.store.favorites.length) fl.append(el("li", { class: "hint", textContent: "Nothing saved yet" }));
  state.store.favorites.forEach((f, i) => {
    fl.append(el("li", {},
      el("span", { textContent: `${f.name} — ${fmtLL(f.lat, f.lon)}`, title: fmtLL(f.lat, f.lon) }),
      el("button", { class: "small", textContent: "Show", onclick: () => { setPicked(f.lat, f.lon); } }),
      el("button", { class: "small", textContent: "Teleport", onclick: guard(async () => { setPicked(f.lat, f.lon); await teleport(); }) }),
      el("button", { class: "small", textContent: "✕", onclick: guard(async () => { state.store.favorites.splice(i, 1); await saveStore(); }) }),
    ));
  });
  const rl = $("route-list");
  rl.replaceChildren();
  if (!state.store.routes.length) rl.append(el("li", { class: "hint", textContent: "Nothing saved yet" }));
  state.store.routes.forEach((r, i) => {
    rl.append(el("li", {},
      el("span", { textContent: `${r.name} (${r.waypoints.length} checkpoints)` }),
      el("button", { class: "small", textContent: "Load", onclick: () => loadRoute(r) }),
      el("button", { class: "small", textContent: "✕", onclick: guard(async () => { state.store.routes.splice(i, 1); await saveStore(); }) }),
    ));
  });
}
$("btn-save-route").onclick = guard(async () => {
  if (state.waypoints.length < 2) throw new Error("Make a route with at least two checkpoints first (Route tab)");
  const name = $("route-name").value.trim() || `Route ${state.store.routes.length + 1}`;
  state.store.routes.push({
    name, closed: $("closed").checked, settings: profileSettings(),
    waypoints: state.waypoints.map(({ lat, lon, name, speed_kmh, dwell_s, leg }) => ({ lat, lon, name, speed_kmh, dwell_s, leg })),
  });
  await saveStore();
  toast(`Saved “${name}”`);
});
function loadRoute(r) {
  state.waypoints = r.waypoints.map((w) => ({ id: nextId++, ...w, leg: { ...defaultLeg(), ...(w.leg || {}) } }));
  $("closed").checked = !!r.closed;
  const s = r.settings || {};
  if (s.default_cruise_kmh) $("default-speed").value = s.default_cruise_kmh;
  if (s.accel_ms2) $("accel").value = s.accel_ms2;
  if (s.decel_ms2) $("decel").value = s.decel_ms2;
  if (s.start_from_rest !== undefined) $("start-rest").checked = s.start_from_rest;
  if (s.stop_at_end !== undefined) $("stop-end").checked = s.stop_at_end;
  $("route-name").value = r.name;
  state.builtSource = "route"; invalidateBuilt();
  document.querySelector('.tabs button[data-tab="route"]').click();
  renderWaypoints();
  const pts = state.waypoints.map((w) => [w.lat, w.lon]);
  if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [30, 30] });
}
$("btn-export-data").onclick = () => {
  const blob = new Blob([JSON.stringify(state.store, null, 1)], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: "location-spoofer-backup.json" });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$("import-data").onchange = guard(async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const data = JSON.parse(await f.text());
  state.store = {
    favorites: [...state.store.favorites, ...(data.favorites || [])],
    routes: [...state.store.routes, ...(data.routes || [])],
    settings: state.store.settings,
  };
  await saveStore();
  toast("Imported");
  e.target.value = "";
});

// ------------------------------------------------------------------ updates
$("btn-update-check").onclick = guard(async () => {
  const u = await api("/api/update/check", { body: {} });
  if (!u.enabled) toast("Automatic updates only work in LocationSpoofer.exe. From source, run: git pull");
  else if (u.state === "up_to_date") toast(`You have the latest version (${u.current}).`);
  else if (u.state === "error") toast(`Update check failed: ${u.error}`, true);
  await poll();
});
$("btn-update-install").onclick = guard(async () => {
  await api("/api/update/install", { body: {} });
  state.restarting = true;
  $("update-text").textContent = "Restarting with the new version… this page reloads by itself.";
  $("btn-update-install").hidden = true;
});
$("btn-tunneld").onclick = guard(async () => toast((await api("/api/tunneld/start", { body: {} })).message));

function renderUpdate(st) {
  const u = st.update;
  const banner = $("update-banner");
  if (state.restarting) {
    if (state.bootVersion && st.version !== state.bootVersion) location.reload();
    return;
  }
  const show = u && u.enabled && ["downloading", "ready", "available"].includes(u.state);
  banner.hidden = !show;
  if (!show) return;
  $("btn-update-install").hidden = u.state !== "ready";
  $("update-text").textContent =
    u.state === "ready" ? `Version ${u.latest} is downloaded. It installs on next start, or now:`
    : u.state === "downloading" ? `Downloading version ${u.latest}… ${Math.round(u.progress * 100)}%`
    : `Version ${u.latest} is available.`;
}

// ------------------------------------------------------------------ status polling
let pollTimer;
async function poll() {
  clearTimeout(pollTimer);
  try {
    const st = await api("/api/status");
    state.status = st;
    $("version").textContent = `v${st.version}`;
    if (!state.bootVersion) state.bootVersion = st.version;
    renderUpdate(st);
    renderDevice(st);
    renderPlayer(st);
    if (state.tab === "teleport") updateJumpInfo();
  } catch (e) {
    $("device-status").className = "status err";
    $("device-status").textContent = state.restarting
      ? "Restarting…"
      : "Lost contact with the app server. Is its window still open?";
  }
  const active = state.status && ["playing", "joystick"].includes(state.status.player.state);
  pollTimer = setTimeout(poll, active ? 500 : 2000);
}

// ------------------------------------------------------------------ boot
renderWaypoints();
loadStore().then(() => refreshDevices());
poll();
