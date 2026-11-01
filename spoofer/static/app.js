/* Location Spoofer — UI. Talks to the local app server at /api (Python or Rust build). */
"use strict";

// ------------------------------------------------------------------ helpers
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "dataset") Object.assign(e.dataset, v);
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
    throw new Error(typeof msg === "string" && msg ? msg : `Request failed (HTTP ${r.status})`);
  }
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), isErr ? 7000 : 3500);
}
const guard = (fn) => async (...a) => {
  try { await fn(...a); } catch (e) { toast(e.message || String(e), true); console.error(e); }
};
// Disable a button while an async action runs, so double clicks don't send twice.
const busy = (btn, label, fn) => guard(async (...a) => {
  if (btn.disabled) return;
  const old = btn.textContent;
  btn.disabled = true;
  if (label) btn.textContent = label;
  try { await fn(...a); } finally { btn.disabled = false; btn.textContent = old; }
});

const fmtTime = (s) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};
const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 100000 ? 0 : 2)} km` : `${Math.round(m)} m`);
const fmtLL = (lat, lon) => `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const numOrNull = (v) => (v === "" || v == null || isNaN(+v) ? null : +v);
const wrapLon = (lng) => ((lng + 180) % 360 + 360) % 360 - 180;
const haversine = (a, b) => {
  const R = 6371008.8, toR = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toR, dLon = (b[1] - a[1]) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const looksLikeGoogleLink = (t) => /^https?:\/\/([a-z0-9-]+\.)*(google\.[a-z.]+|goo\.gl|g\.co)\//i.test(t.trim());

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
  gpx: null,               // last import response {filename, tracks}
  gpxIndex: 0,
  store: { favorites: [], routes: [], settings: {} },
  status: null,
  preview: null,
  seeking: false,
  google: { configured: false, session: null, key: null, layer: null },
  devicesError: null,
};
let nextId = 1;

// ------------------------------------------------------------------ map
const map = L.map("map", { zoomControl: true, worldCopyJump: true }).setView([51.505, -0.09], 13);
const baseLayers = {
  "Streets": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }),
  "Satellite": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19, attribution: "Imagery &copy; Esri" }),
  "Topographic": L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxZoom: 17, attribution: "&copy; OpenStreetMap contributors, SRTM | &copy; OpenTopoMap (CC-BY-SA)" }),
};
baseLayers.Streets.addTo(map);
const layerControl = L.control.layers(baseLayers).addTo(map);
L.control.scale().addTo(map);

const routeLayer = L.layerGroup().addTo(map);
const wpLayer = L.layerGroup().addTo(map);
const gpxLayer = L.layerGroup().addTo(map);
let pickMarker = null, deviceMarker = null, previewMarker = null, trailLine = null;
const icon = (cls, html = "") => L.divIcon({ className: cls, html, iconSize: null });

map.on("click", (e) => {
  const lon = wrapLon(e.latlng.lng);
  if (state.tab === "route") addWaypoint(e.latlng.lat, lon);
  else setPicked(e.latlng.lat, lon, false);
});
// Right-click: teleport straight away.
map.on("contextmenu", guard(async (e) => {
  setPicked(e.latlng.lat, wrapLon(e.latlng.lng), false);
  await teleport();
}));

// ------------------------------------------------------------------ Google map (shown when a Google route is on screen)
const GoogleAttribution = L.Control.extend({
  options: { position: "bottomleft" },
  onAdd() {
    this._div = L.DomUtil.create("div", "google-attrib");
    this._div.innerHTML = "<b>Google Maps</b> <span></span>";
    return this._div;
  },
  setText(t) { if (this._div) this._div.querySelector("span").textContent = t || ""; },
});
const googleAttrib = new GoogleAttribution();

async function ensureGoogleLayer() {
  const g = state.google;
  const fresh = g.session && g.expiry && Date.now() / 1000 < g.expiry - 300;
  if (!fresh) {
    const s = await api("/api/google/tile-session", { body: { map_type: "roadmap" } });
    g.session = s.session; g.key = s.key; g.expiry = +s.expiry || Date.now() / 1000 + 3600 * 12;
    if (g.layer) { layerControl.removeLayer(g.layer); map.removeLayer(g.layer); }
    g.layer = L.tileLayer(`https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${encodeURIComponent(g.session)}&key=${encodeURIComponent(g.key)}`, {
      maxZoom: 22, attribution: "", className: "google-tiles" });
    layerControl.addBaseLayer(g.layer, "Google Maps");
  }
  return g.layer;
}
async function useGoogleBase() {
  const layer = await ensureGoogleLayer();
  for (const l of Object.values(baseLayers)) if (map.hasLayer(l)) map.removeLayer(l);
  if (!map.hasLayer(layer)) layer.addTo(map);
  if (!googleAttrib._map) googleAttrib.addTo(map);
  refreshGoogleCopyright();
}
let copyrightTimer;
function refreshGoogleCopyright() {
  clearTimeout(copyrightTimer);
  copyrightTimer = setTimeout(guard(async () => {
    const g = state.google;
    if (!g.layer || !map.hasLayer(g.layer)) return;
    const b = map.getBounds();
    const q = new URLSearchParams({ session: g.session, zoom: Math.round(map.getZoom()),
      north: b.getNorth(), south: b.getSouth(), east: wrapLon(b.getEast()), west: wrapLon(b.getWest()) });
    const { copyright } = await api(`/api/google/copyright?${q}`);
    googleAttrib.setText(copyright);
  }), 400);
}
map.on("moveend", refreshGoogleCopyright);
map.on("baselayerchange", (e) => {
  const isGoogle = state.google.layer && e.layer === state.google.layer;
  if (isGoogle) { if (!googleAttrib._map) googleAttrib.addTo(map); refreshGoogleCopyright(); return; }
  if (googleAttrib._map) googleAttrib.remove();
  // Google's terms: Google routes may only be shown on a Google map.
  if (state.built && (state.built.providers || []).includes("google")) {
    routeLayer.clearLayers();
    gpxLayer.clearLayers();
    $("speed-legend").hidden = true;
    toast("Google routes can only be shown on the Google map, so the route line was hidden. Switch back to 'Google Maps' to see it.");
  }
});

// ------------------------------------------------------------------ tooltips for the grey (i) buttons
const tip = $("tooltip");
function showTip(btn) {
  tip.textContent = btn.dataset.tip;
  tip.hidden = false;
  const r = btn.getBoundingClientRect();
  const w = Math.min(300, window.innerWidth - 24);
  tip.style.maxWidth = w + "px";
  const tr = tip.getBoundingClientRect();
  let left = Math.min(Math.max(12, r.left + r.width / 2 - tr.width / 2), window.innerWidth - tr.width - 12);
  let top = r.bottom + 8;
  if (top + tr.height > window.innerHeight - 8) top = r.top - tr.height - 8;
  tip.style.left = left + "px";
  tip.style.top = Math.max(8, top) + "px";
}
const hideTip = () => (tip.hidden = true);
function wireInfoButtons(root = document) {
  root.querySelectorAll("button.info:not([data-wired])").forEach((b) => {
    b.dataset.wired = "1";
    b.setAttribute("aria-label", "More information");
    b.addEventListener("mouseenter", () => showTip(b));
    b.addEventListener("focus", () => showTip(b));
    b.addEventListener("mouseleave", hideTip);
    b.addEventListener("blur", hideTip);
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); tip.hidden ? showTip(b) : hideTip(); });
  });
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTip(); });
document.addEventListener("scroll", hideTip, true);

// ------------------------------------------------------------------ tabs
function openTab(name) {
  state.tab = name;
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((p) => (p.hidden = p.id !== `tab-${name}`));
  map.getContainer().style.cursor = name === "route" ? "crosshair" : "";
}
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => openTab(b.dataset.tab)));

// ------------------------------------------------------------------ device
async function refreshDevices(userAsked = false) {
  const driver = $("driver").value;
  const sel = $("device-select");
  const keep = sel.value;
  sel.replaceChildren(el("option", { value: "", textContent: "First connected iPhone" }));
  state.devicesError = null;
  try {
    const { devices } = await api(`/api/devices?driver=${driver}`);
    for (const d of devices) {
      const label = `${d.name || "iPhone"}${d.ios_version ? ` (iOS ${d.ios_version})` : ""} — ${d.connection || ""}${d.error ? " ⚠" : ""}`;
      sel.append(el("option", { value: d.udid, textContent: label, title: d.error || d.udid }));
    }
    if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
    if (!devices.length && userAsked) toast("No device found. Plug in the iPhone, unlock it and tap Trust.", true);
  } catch (e) {
    // Shown in the status line instead of a pop-up, so the app doesn't greet people with an error.
    state.devicesError = e.message;
    if (userAsked) toast(e.message, true);
  }
  if (state.status) renderDevice(state.status);
}
$("btn-refresh").onclick = () => refreshDevices(true);
$("driver").onchange = () => { refreshDevices(false); saveSettingsSoon(); };

async function connectNow() {
  $("device-status").className = "status";
  $("device-status").textContent = "Connecting… (iOS 17+ can take up to 30 s)";
  try {
    const { device } = await api("/api/connect", { body: { driver: $("driver").value, udid: $("device-select").value || null } });
    toast(`Connected to ${device.name}`);
    for (const n of device.notes || []) toast(n);
    return device;
  } finally {
    await poll();
  }
}
$("btn-connect").onclick = busy($("btn-connect"), "Connecting…", connectNow);
$("btn-disconnect").onclick = guard(async () => { await api("/api/disconnect", { body: {} }); await poll(); });
async function revealDevMode() { toast((await api("/api/device/reveal-developer-mode", { body: {} })).message); }
$("btn-reveal").onclick = busy($("btn-reveal"), "Asking the iPhone…", revealDevMode);
$("btn-mount").onclick = busy($("btn-mount"), "Mounting…", async () => toast((await api("/api/device/mount", { body: {} })).message));
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
    $("driver").value = st.driver;
  } else if (state.devicesError && $("driver").value !== "mock") {
    box.className = "status warn";
    box.textContent = state.devicesError;
  } else {
    box.className = "status";
    box.textContent = "Not connected";
  }
}

// ------------------------------------------------------------------ teleport
function setPicked(lat, lon, pan = true) {
  state.picked = [lat, lon];
  if (!pickMarker) pickMarker = L.marker([lat, lon], { icon: icon("pick-icon"), draggable: true })
    .on("dragend", (e) => { const p = e.target.getLatLng(); setPicked(p.lat, wrapLon(p.lng), false); })
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
  if (d < 1) { $("jump-info").textContent = ""; return; }
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
$("btn-teleport").onclick = busy($("btn-teleport"), "Setting…", teleport);
$("btn-copy").onclick = guard(async () => {
  await navigator.clipboard.writeText(fmtLL(...state.picked));
  toast("Copied");
});
$("btn-fav").onclick = guard(async () => {
  const name = prompt("Name for this place:", "Favourite " + (state.store.favorites.length + 1));
  if (name === null) return;
  state.store.favorites.push({ name: name.trim() || "Favourite", lat: state.picked[0], lon: state.picked[1] });
  await saveStore();
  toast("Saved to favourites");
});
$("btn-pick-to-route").onclick = () => { addWaypoint(...state.picked); toast("Added to the route (Route tab)"); };

$("btn-coords").onclick = guard(async () => {
  const text = $("coords").value.trim();
  if (looksLikeGoogleLink(text)) return openGoogleLink(text);
  const { lat, lon } = await api("/api/parse-coords", { body: { text } });
  setPicked(lat, lon);
});
$("coords").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btn-coords").click(); });

$("search").addEventListener("keydown", guard(async (e) => {
  if (e.key !== "Enter") return;
  const q = $("search").value.trim();
  const list = $("search-results");
  list.replaceChildren();
  if (!q) return;
  if (looksLikeGoogleLink(q)) return openGoogleLink(q);
  try { const { lat, lon } = await api("/api/parse-coords", { body: { text: q } }); setPicked(lat, lon); return; } catch (_) { /* not coordinates */ }
  list.append(el("li", { class: "muted", textContent: "Searching…" }));
  const { results } = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
  list.replaceChildren();
  if (!results.length) list.append(el("li", { textContent: "No results" }));
  for (const r of results) {
    list.append(el("li", { textContent: r.name, onclick: () => { setPicked(r.lat, r.lon); list.replaceChildren(); } }));
  }
}));

// ------------------------------------------------------------------ Google Maps links
async function parseGoogleLink(text) {
  toast("Reading the Google Maps link…");
  return api("/api/links/parse", { body: { text: text.trim() } });
}
async function openGoogleLink(text) {
  const p = await parseGoogleLink(text);
  if (p.kind === "route") return loadLinkAsRoute(p);
  const s = p.stops[0];
  setPicked(s.lat, s.lon);
  toast(`Found ${s.name || fmtLL(s.lat, s.lon)}. Press Teleport here to go there.`);
}
function loadLinkAsRoute(p) {
  const mode = p.mode || $("default-mode").value;
  state.waypoints = p.stops.map((s) => ({ id: nextId++, lat: s.lat, lon: s.lon, name: s.name || "", speed_kmh: null, dwell_s: 0,
    leg: { mode, cruise_kmh: null, ramp: "accel" } }));
  if (p.mode) $("default-mode").value = p.mode;
  state.builtSource = "route"; invalidateBuilt();
  openTab("route");
  renderWaypoints();
  map.fitBounds(L.latLngBounds(state.waypoints.map((w) => [w.lat, w.lon])), { padding: [30, 30] });
  toast(`Imported ${p.stops.length} stops from Google Maps. Press Build route.`);
}
$("btn-gmaps-link").onclick = busy($("btn-gmaps-link"), "Opening…", () => openGoogleLink($("gmaps-link").value));
$("gmaps-link").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btn-gmaps-link").click(); });
$("btn-route-link").onclick = busy($("btn-route-link"), "Importing…", async () => {
  const p = await parseGoogleLink($("route-link").value);
  if (p.kind === "point") {
    addWaypoint(p.stops[0].lat, p.stops[0].lon, { name: p.stops[0].name || "" });
    toast("That link is a single place; it was added as a checkpoint.");
  } else loadLinkAsRoute(p);
});
$("route-link").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btn-route-link").click(); });

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
    $("speed-legend").hidden = true;
    state.built = null;
    stopPreview();
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
    const move = (j) => () => { [state.waypoints[j], state.waypoints[i]] = [state.waypoints[i], state.waypoints[j]]; invalidateBuilt(); renderWaypoints(); };
    const head = el("div", { class: "wp-head" },
      el("span", { class: "wp-num", textContent: i + 1 }),
      el("input", { value: w.name, placeholder: fmtLL(w.lat, w.lon), title: "Name", oninput: (e) => (w.name = e.target.value) }),
      el("button", { class: "small", textContent: "↑", title: "Move up", disabled: i === 0, onclick: move(i - 1) }),
      el("button", { class: "small", textContent: "↓", title: "Move down", disabled: i === n - 1, onclick: move(i + 1) }),
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
          title: "Stop and wait this long", onchange: change((t) => (w.dwell_s = Math.max(0, +t.value || 0))) })),
    );
    const li = el("li", { class: "wp" }, head, fields);

    if (i < n - 1 || (closed && n > 1)) {
      const modeSel = el("select", { title: "How this leg is routed", onchange: change((t) => { w.leg.mode = t.value; }) },
        ...Object.entries(MODE_LABEL).map(([k, v]) => el("option", { value: k, textContent: v, selected: w.leg.mode === k })));
      const cruise = el("input", { type: "number", min: 0.1, step: 0.1, value: w.leg.cruise_kmh ?? "",
        placeholder: $("road-aware").checked ? "road speed" : `${$("default-speed").value} km/h`,
        title: "Cruise speed for this leg (km/h). Blank = default (or the road's speed in road-aware mode).",
        onchange: change((t) => (w.leg.cruise_kmh = numOrNull(t.value))) });
      const ramp = el("select", { title: "How speed changes on this leg", onchange: change((t) => (w.leg.ramp = t.value)) },
        el("option", { value: "accel", textContent: "Accel rate", selected: w.leg.ramp === "accel" }),
        el("option", { value: "linear", textContent: "Even ramp", selected: w.leg.ramp === "linear" }));
      li.append(el("div", { class: "leg", title: `Leg ${i + 1} → ${i + 2 > n ? 1 : i + 2}` }, modeSel, cruise, ramp));
    }
    list.append(li);

    L.marker([w.lat, w.lon], { draggable: true, icon: icon("wp-icon", String(i + 1)), title: w.name || `Checkpoint ${i + 1}` })
      .on("dragend", (e) => { const p = e.target.getLatLng(); w.lat = p.lat; w.lon = wrapLon(p.lng); invalidateBuilt(); renderWaypoints(); })
      .addTo(wpLayer);
  });

  if (!state.built || state.builtSource !== "route") {
    const pts = state.waypoints.map((w) => [w.lat, w.lon]);
    if (closed && pts.length > 1) pts.push(pts[0]);
    if (pts.length > 1) L.polyline(pts, { color: "#888", weight: 2, dashArray: "4 6", interactive: false }).addTo(wpLayer);
  }
}
$("closed").onchange = () => { invalidateBuilt(); renderWaypoints(); };
$("default-speed").onchange = () => renderWaypoints();
$("btn-clear-route").onclick = () => {
  if (state.waypoints.length && !confirm("Remove all checkpoints?")) return;
  state.waypoints = []; invalidateBuilt(); renderWaypoints();
};
$("btn-reverse").onclick = () => {
  const n = state.waypoints.length;
  const legs = state.waypoints.map((w) => w.leg);
  state.waypoints.reverse();
  // leg i now runs from new i to new i+1, which was old leg (n-2-i); the closing leg keeps its settings
  state.waypoints.forEach((w, i) => (w.leg = { ...(i < n - 1 ? legs[n - 2 - i] : legs[n - 1]) || defaultLeg() }));
  invalidateBuilt(); renderWaypoints();
};

function presetButtons(containerId, onPick) {
  const c = $(containerId);
  for (const [name, kmh, acc] of SPEED_PRESETS) {
    c.append(el("button", { type: "button", textContent: `${name} ${kmh}`, title: `${kmh} km/h, ${acc} m/s²`, onclick: () => onPick(kmh, acc) }));
  }
}
presetButtons("speed-presets", (kmh, acc) => {
  $("default-speed").value = kmh; $("accel").value = acc; $("decel").value = acc;
  invalidateBuilt(); renderWaypoints(); saveSettingsSoon();
});
$("speed-factor").oninput = () => ($("speed-factor-out").textContent = `${Math.round($("speed-factor").value * 100)}%`);
["road-aware", "road-data", "corner-slow", "match-eta", "speed-factor", "provider", "accel", "decel", "start-rest", "stop-end"]
  .forEach((id) => $(id).addEventListener("change", () => { invalidateBuilt(); if (id === "road-aware") renderWaypoints(); }));
$("provider").addEventListener("change", () => {
  if ($("provider").value === "google" && !state.google.configured) {
    toast("Add your Google Maps API key in Settings (⚙) to use Google routing.", true);
    $("provider").value = "osrm";
  }
});

function profileSettings() {
  return {
    default_cruise_kmh: +$("default-speed").value || 5,
    accel_ms2: +$("accel").value || 1,
    decel_ms2: +$("decel").value || 1,
    start_from_rest: $("start-rest").checked,
    stop_at_end: $("stop-end").checked,
    road_aware: $("road-aware").checked,
    road_data: $("road-data").checked,
    match_eta: $("match-eta").checked,
    corner_slowdown: $("corner-slow").checked,
    speed_factor: +$("speed-factor").value || 1,
  };
}

function routeBody(name = "Route") {
  const wps = state.waypoints;
  const closed = $("closed").checked;
  const legs = wps.slice(0, closed ? wps.length : wps.length - 1).map((w) => w.leg);
  return {
    name, closed, provider: $("provider").value,
    settings: profileSettings(),
    waypoints: wps.map((w, i) => ({ lat: w.lat, lon: w.lon, name: w.name || `Checkpoint ${i + 1}`, speed_kmh: w.speed_kmh, dwell_s: w.dwell_s || 0 })),
    legs,
  };
}

$("btn-build").onclick = busy($("btn-build"), "Routing…", async () => {
  if (state.waypoints.length < 2) throw new Error("Add at least two checkpoints");
  const body = routeBody($("route-name").value.trim() || "Route");
  const res = await api("/api/route/build", { body });
  state.built = res;
  state.builtSource = "route";
  gpxLayer.clearLayers();
  if ((res.providers || []).includes("google")) await useGoogleBase();
  drawBuilt(res, routeLayer);
  renderResult($("route-result"), res);
  renderWaypoints();
  await api(`/api/player/load/${res.id}`, { body: {} });
  clearTrail();
  await poll();
});

// ------------------------------------------------------------------ speed-coloured route line
const SPEED_STOPS = [[0, [49, 54, 149]], [0.2, [69, 117, 180]], [0.4, [116, 173, 209]], [0.55, [171, 217, 233]],
  [0.65, [254, 224, 144]], [0.8, [253, 174, 97]], [0.9, [244, 109, 67]], [1, [215, 48, 39]]];
function speedColor(f) {
  f = Math.min(1, Math.max(0, f));
  for (let i = 1; i < SPEED_STOPS.length; i++) {
    const [f1, c1] = SPEED_STOPS[i];
    if (f <= f1) {
      const [f0, c0] = SPEED_STOPS[i - 1];
      const t = (f - f0) / (f1 - f0 || 1);
      return `rgb(${c0.map((c, k) => Math.round(c + (c1[k] - c) * t)).join(",")})`;
    }
  }
  return "rgb(215,48,39)";
}
function drawBuilt(res, layer) {
  layer.clearLayers();
  const pv = res.preview || [];
  const all = [];
  (res.legs || []).forEach((pts) => all.push(...pts));
  // casing so light colours stay visible on any map
  (res.legs || []).forEach((pts) => L.polyline(pts, { color: "#222", weight: 7, opacity: 0.35, interactive: false }).addTo(layer));
  const vmax = Math.max(1, ...pv.map((p) => p[3]));
  const vmin = Math.min(...pv.map((p) => p[3]), vmax);
  const span = Math.max(1, vmax - vmin);
  // Group consecutive samples with the same colour bucket into one polyline.
  let run = [], runBucket = -1;
  const flush = () => {
    if (run.length > 1) {
      const pl = L.polyline(run.map((p) => [p[1], p[2]]), { color: speedColor(runBucket / 20), weight: 5, opacity: 0.95 });
      const lo = Math.min(...run.map((p) => p[3])), hi = Math.max(...run.map((p) => p[3]));
      pl.bindTooltip(`${lo.toFixed(0)}–${hi.toFixed(0)} km/h`, { sticky: true });
      pl.addTo(layer);
    }
  };
  for (const p of pv) {
    const bucket = Math.round(((p[3] - vmin) / span) * 20);
    if (bucket !== runBucket && run.length) { const last = run[run.length - 1]; flush(); run = [last]; }
    runBucket = bucket;
    run.push(p);
  }
  flush();
  $("legend-min").textContent = vmin.toFixed(0);
  $("legend-max").textContent = vmax.toFixed(0);
  $("speed-legend").hidden = pv.length < 2;
  if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [30, 30] });
}

function renderResult(box, res) {
  const s = res.summary;
  const intervalSel = el("select", { "aria-label": "GPX point interval" },
    ...[0.5, 1, 2, 5, 10].map((v) => el("option", { value: v, textContent: `${v}s`, selected: v === 1 })));
  const items = [
    el("span", {}, "Distance ", el("b", { textContent: fmtDist(s.distance_m) })),
    el("span", {}, "Duration ", el("b", { textContent: fmtTime(s.duration_s) })),
    el("span", {}, "Average ", el("b", { textContent: `${s.avg_speed_kmh} km/h` })),
    el("span", {}, "Top speed ", el("b", { textContent: `${s.max_speed_kmh} km/h` })),
  ];
  const extra = [];
  if (s.reference_eta_s) {
    const diff = (s.moving_time_s - s.reference_eta_s) / s.reference_eta_s * 100;
    extra.push(el("p", { class: "eta" },
      `${s.reference_source} ETA ${fmtTime(s.reference_eta_s)} · simulated driving time ${fmtTime(s.moving_time_s)} `,
      el("b", { textContent: `(${diff >= 0 ? "+" : ""}${diff.toFixed(0)}%)` }),
      s.road_aware ? ` · driving style ${Math.round((s.speed_factor || 1) * 100)}%` : ""));
  }
  const f = s.features || {};
  const feat = [];
  if (s.corners_slowed) feat.push(`slowed for ${s.corners_slowed} bend${s.corners_slowed > 1 ? "s" : ""}/U-turns`);
  if (f.uturns) feat.push(`${f.uturns} U-turn${f.uturns > 1 ? "s" : ""} in the directions`);
  if (f.offnet_m >= 25) feat.push(`${fmtDist(f.offnet_m)} off the road network (private road, gated area or car park; driven slowly)`);
  if (f.restricted_segments) feat.push("private/restricted roads driven slowly");
  if (f.highway_segments || f.ramps) feat.push("motorway sections");
  if (feat.length) extra.push(el("p", { class: "hint" }, "Road features: " + feat.join("; ") + "."));
  for (const n of s.notes || []) extra.push(el("p", { class: "hint", textContent: n }));
  const exportBtn = el("button", { textContent: "⇩ Download GPX", disabled: res.exportable === false,
    title: res.exportable === false ? "Google routes can't be exported (Google's terms restrict storing route data)." : "",
    onclick: () => { window.location.href = `/api/gpx/export/${res.id}?interval=${intervalSel.value || 1}`; } });
  box.replaceChildren(
    el("div", { class: "summary" }, ...items),
    ...extra,
    ...(s.warnings || []).map((w) => el("p", { class: "warn", textContent: "⚠ " + w })),
    chartCanvas(res.preview),
    el("div", { class: "row wrap" },
      el("button", { class: "grow", textContent: "▷ Preview on map", onclick: () => togglePreview(res) }),
      el("label", { class: "button inline", title: "Seconds between GPX points" }, "GPX every ", intervalSel),
      exportBtn),
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
    const pad = { l: 34, r: 8, t: 12, b: 16 };
    const x = (t) => pad.l + (t / T) * (w - pad.l - pad.r);
    const y = (v) => h - pad.b - (v / V) * (h - pad.t - pad.b);
    g.strokeStyle = cssVar("--border"); g.lineWidth = 1;
    g.beginPath(); g.moveTo(pad.l, pad.t); g.lineTo(pad.l, h - pad.b); g.lineTo(w - pad.r, h - pad.b); g.stroke();
    g.fillStyle = cssVar("--muted"); g.font = "10px system-ui";
    g.textBaseline = "top"; g.fillText(`${Math.round(V)}`, 4, pad.t - 4);
    g.textBaseline = "alphabetic"; g.fillText("0", 4, h - pad.b);
    g.fillText(fmtTime(T), w - pad.r - 34, h - 3); g.fillText("km/h", 4, h - 3);
    g.lineWidth = 2;
    for (let i = 1; i < preview.length; i++) {
      const a = preview[i - 1], b = preview[i];
      g.strokeStyle = speedColor(b[3] / V);
      g.beginPath(); g.moveTo(x(a[0]), y(a[3])); g.lineTo(x(b[0]), y(b[3])); g.stroke();
    }
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
    if (!state.preview) return;
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
  const c = state.picked || [map.getCenter().lat, wrapLon(map.getCenter().lng)];
  const R = Math.max(20, +$("wander-radius").value || 500);
  const n = Math.min(50, Math.max(2, +$("wander-count").value || 6));
  const pts = [c];
  for (let k = 1; k < n; k++) {
    const r = R * Math.sqrt(Math.random()), a = Math.random() * 2 * Math.PI;
    const dLat = (r * Math.cos(a)) / 111320;
    const dLon = (r * Math.sin(a)) / (111320 * Math.max(0.01, Math.cos((c[0] * Math.PI) / 180)));
    pts.push([Math.max(-89.9, Math.min(89.9, c[0] + dLat)), wrapLon(c[1] + dLon)]);
  }
  state.waypoints = pts.map(([la, lo]) => ({ id: nextId++, lat: la, lon: lo, name: "", speed_kmh: null, dwell_s: 0, leg: defaultLeg() }));
  state.waypoints.slice(1, -1).forEach((w) => (w.dwell_s = Math.random() < 0.4 ? Math.round(5 + Math.random() * 40) : 0));
  state.builtSource = "route"; invalidateBuilt(); renderWaypoints();
  toast(`Generated ${n} checkpoints. Press Build route.`);
};

// ------------------------------------------------------------------ GPX import
const drop = $("gpx-drop");
drop.addEventListener("click", () => $("gpx-file").click());
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("gpx-file").click(); } });
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "dragend"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("over")));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) uploadGpx(f);
});
// Dropping a file anywhere else must not navigate the window away from the app.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f && /\.gpx$/i.test(f.name)) { openTab("gpx"); uploadGpx(f); }
});
$("gpx-file").onchange = (e) => {
  const f = e.target.files[0];
  e.target.value = ""; // always reset, so choosing the same file again (e.g. after an error) works
  if (f) uploadGpx(f);
};

function gpxError(msg) {
  const box = $("gpx-error");
  box.textContent = msg || "";
  box.hidden = !msg;
}
async function uploadGpx(file) {
  gpxError("");
  if (!/\.(gpx|xml)$/i.test(file.name)) { gpxError(`"${file.name}" is not a .gpx file.`); return; }
  if (file.size > 20 * 1024 * 1024) { gpxError("That file is larger than 20 MB."); return; }
  $("gpx-drop-title").textContent = `Reading ${file.name}…`;
  try {
    const fd = new FormData();
    fd.append("file", file);
    const res = await api("/api/gpx/import", { body: fd });
    state.gpx = { ...res, size: file.size };
    state.gpxIndex = 0;
    $("gpx-track").replaceChildren(...res.tracks.map((t, i) => el("option", { value: i,
      textContent: `${t.name} — ${t.kind}, ${t.points.length} points${t.timed ? ", timed" : ""}` })));
    $("gpx-panel").hidden = false;
    showGpxTrack();
  } catch (err) {
    gpxError(`Could not read ${file.name}: ${err.message}`);
  } finally {
    renderGpxDrop();
  }
}
function renderGpxDrop() {
  if (state.gpx) {
    $("gpx-drop-title").textContent = `📄 ${state.gpx.filename}`;
    $("gpx-drop-sub").textContent = `${fmtSize(state.gpx.size || 0)} · ${state.gpx.tracks.length} item${state.gpx.tracks.length > 1 ? "s" : ""} — click or drop to replace`;
    drop.classList.add("loaded");
  } else {
    $("gpx-drop-title").textContent = "Drop a .gpx file here";
    $("gpx-drop-sub").textContent = "or click to choose one";
    drop.classList.remove("loaded");
  }
}
$("gpx-track").onchange = (e) => { state.gpxIndex = +e.target.value; showGpxTrack(); };
$("gpx-use-times").onchange = () => ($("gpx-speed").disabled = $("gpx-use-times").checked && !$("gpx-use-times").disabled);

function showGpxTrack() {
  const t = state.gpx.tracks[state.gpxIndex];
  gpxLayer.clearLayers();
  routeLayer.clearLayers();
  $("speed-legend").hidden = true;
  $("gpx-result").replaceChildren();
  if (state.builtSource === "gpx") state.built = null;
  const pts = t.points.map((p) => [p[0], p[1]]);
  if (t.kind === "waypoints") pts.forEach((p) => L.circleMarker(p, { radius: 5, color: "#ef6c00" }).addTo(gpxLayer));
  else L.polyline(pts, { color: "#ef6c00", weight: 4, dashArray: "6 6" }).addTo(gpxLayer);
  if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [30, 30] });
  $("gpx-use-times").checked = t.timed;
  $("gpx-use-times").disabled = !t.timed;
  $("gpx-speed").disabled = t.timed;
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += haversine(pts[i - 1], pts[i]);
  const dur = t.timed ? t.points[t.points.length - 1][2] - t.points[0][2] : null;
  $("gpx-info").textContent = `${fmtDist(len)}${dur ? `, recorded over ${fmtTime(dur)} (average ${(len / Math.max(1, dur) * 3.6).toFixed(1)} km/h)` : " — no timestamps, so it will be timed with the speed below"}`;
  $("btn-gpx-load").disabled = pts.length < 2;
}

$("btn-gpx-load").onclick = busy($("btn-gpx-load"), "Loading…", async () => {
  const t = state.gpx.tracks[state.gpxIndex];
  const res = await api("/api/gpx/timeline", { body: {
    name: t.name, points: t.points, use_times: $("gpx-use-times").checked && !$("gpx-use-times").disabled,
    reverse: $("gpx-reverse").checked, cruise_kmh: +$("gpx-speed").value || 5, settings: profileSettings(),
  } });
  state.built = res;
  state.builtSource = "gpx";
  routeLayer.clearLayers();
  drawBuilt(res, gpxLayer);
  renderResult($("gpx-result"), res);
  await api(`/api/player/load/${res.id}`, { body: {} });
  clearTrail();
  await poll();
});

// Douglas–Peucker simplification that keeps original indices (planar metres, equirectangular)
function simplifyIdx(pts, tol) {
  if (pts.length < 3) return pts.map((_, i) => i);
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
  return [...keep.keys()].filter((i) => keep[i]);
}
$("btn-gpx-to-route").onclick = () => {
  const t = state.gpx.tracks[state.gpxIndex];
  const pts = t.points.map((p) => [p[0], p[1]]);
  let tol = 5, idx = simplifyIdx(pts, tol);
  while (idx.length > 60 && tol < 5000) { tol *= 2; idx = simplifyIdx(pts, tol); }
  state.waypoints = idx.map((i) => ({ id: nextId++, lat: pts[i][0], lon: pts[i][1], name: (t.names && t.names[i]) || "",
    speed_kmh: null, dwell_s: 0, leg: { mode: "straight", cruise_kmh: null, ramp: "accel" } }));
  gpxLayer.clearLayers();
  state.builtSource = "route"; invalidateBuilt();
  openTab("route");
  renderWaypoints();
  toast(`Converted to ${idx.length} checkpoints (straight legs keep the track's shape). Edit and press Build route.`);
};

// ------------------------------------------------------------------ player
const playerBtns = { play: $("btn-play"), pause: $("btn-pause"), stop: $("btn-stop") };
playerBtns.play.onclick = guard(async () => {
  const st = state.status && state.status.player;
  if (st && st.state !== "paused" && st.t === 0) clearTrail();
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
    jitter_m: Math.min(100, Math.max(0, +$("jitter").value || 0)), tick_s: Math.min(10, Math.max(0.2, +$("tick").value || 1)),
  } });
  saveSettingsSoon();
});
["multiplier", "loop", "jitter", "tick"].forEach((id) => $(id).addEventListener("change", sendOptions));

function clearTrail() {
  if (trailLine) trailLine.setLatLngs([]);
}
function renderPlayer(st) {
  const p = st.player;
  $("player-name").textContent = p.name || "No route loaded";
  const badge = $("player-state");
  badge.textContent = p.state + (p.laps ? ` · lap ${p.laps + 1}` : "");
  badge.className = "badge " + p.state;
  const has = p.duration > 0 || !!p.name;
  const connected = !!st.device;
  playerBtns.play.disabled = !has || !connected || p.state === "playing";
  playerBtns.play.title = !connected ? "Connect a device (or the Simulator) first" : !has ? "Build a route or load a GPX track first" : "";
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
  if (p.state === "error" && p.error && state.lastError !== p.error) toast(p.error, true);
  state.lastError = p.error;

  if (p.position) {
    const ll = [p.position.lat, p.position.lon];
    if (!deviceMarker) {
      deviceMarker = L.marker(ll, { icon: icon("dev-icon"), interactive: true, zIndexOffset: 1000, title: "Spoofed location" }).addTo(map);
      trailLine = L.polyline([], { color: "#e53935", weight: 2, opacity: 0.6, interactive: false }).addTo(map);
    }
    deviceMarker.setLatLng(ll);
    if (["playing", "joystick"].includes(p.state)) {
      const tl = trailLine.getLatLngs();
      tl.push(L.latLng(ll));
      if (tl.length > 2000) tl.shift();
      trailLine.setLatLngs(tl);
      if (!map.getBounds().pad(-0.2).contains(ll)) map.panTo(ll);
    }
  } else if (deviceMarker) {
    map.removeLayer(deviceMarker); deviceMarker = null;
    if (trailLine) { map.removeLayer(trailLine); trailLine = null; }
  }
}

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
const typing = () => ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName) || document.querySelector("dialog[open]");
document.addEventListener("keydown", (e) => {
  if (state.tab !== "joystick" || !KEYS[e.code] || typing()) return;
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
    state.store.settings = { ...state.store.settings, ...collectSettings() };
    await saveStore();
  }), 800);
}
const SETTING_IDS = ["driver", "provider", "default-mode", "default-speed", "accel", "decel", "start-rest", "stop-end",
  "road-aware", "road-data", "corner-slow", "match-eta", "speed-factor",
  "multiplier", "loop", "jitter", "tick", "joy-speed", "gpx-speed"];
function collectSettings() {
  const s = {};
  for (const id of SETTING_IDS) { const e = $(id); s[id] = e.type === "checkbox" ? e.checked : e.value; }
  const c = map.getCenter(); s.view = [c.lat, wrapLon(c.lng), map.getZoom()];
  return s;
}
function applySettings(s) {
  for (const id of SETTING_IDS) {
    if (s[id] === undefined) continue;
    const e = $(id);
    if (e.type === "checkbox") e.checked = !!s[id]; else e.value = s[id];
  }
  $("speed-factor").oninput();
  if (Array.isArray(s.view)) map.setView([s.view[0], s.view[1]], s.view[2]);
  $("google-key").value = s.google_api_key || "";
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
      el("span", { textContent: `${r.name} (${(r.waypoints || []).length} checkpoints)` }),
      el("button", { class: "small", textContent: "Load", onclick: () => loadRoute(r) }),
      el("button", { class: "small", textContent: "✕", onclick: guard(async () => { state.store.routes.splice(i, 1); await saveStore(); }) }),
    ));
  });
}
$("btn-save-route").onclick = guard(async () => {
  if (state.waypoints.length < 2) throw new Error("Make a route with at least two checkpoints first (Route tab)");
  const name = $("route-name").value.trim() || `Route ${state.store.routes.length + 1}`;
  state.store.routes.push({
    name, closed: $("closed").checked, settings: profileSettings(), provider: $("provider").value,
    waypoints: state.waypoints.map(({ lat, lon, name, speed_kmh, dwell_s, leg }) => ({ lat, lon, name, speed_kmh, dwell_s, leg })),
  });
  await saveStore();
  toast(`Saved “${name}”`);
});
function loadRoute(r) {
  state.waypoints = (r.waypoints || []).map((w) => ({ id: nextId++, ...w, leg: { ...defaultLeg(), ...(w.leg || {}) } }));
  $("closed").checked = !!r.closed;
  const s = r.settings || {};
  if (s.default_cruise_kmh) $("default-speed").value = s.default_cruise_kmh;
  if (s.accel_ms2) $("accel").value = s.accel_ms2;
  if (s.decel_ms2) $("decel").value = s.decel_ms2;
  if (s.start_from_rest !== undefined) $("start-rest").checked = s.start_from_rest;
  if (s.stop_at_end !== undefined) $("stop-end").checked = s.stop_at_end;
  if (s.road_aware !== undefined) $("road-aware").checked = s.road_aware;
  if (s.corner_slowdown !== undefined) $("corner-slow").checked = s.corner_slowdown;
  if (r.provider === "osrm" || (r.provider === "google" && state.google.configured)) $("provider").value = r.provider;
  $("route-name").value = r.name;
  state.builtSource = "route"; invalidateBuilt();
  openTab("route");
  renderWaypoints();
  const pts = state.waypoints.map((w) => [w.lat, w.lon]);
  if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [30, 30] });
}
$("btn-export-data").onclick = () => {
  const data = { ...state.store, settings: { ...state.store.settings } };
  delete data.settings.google_api_key; // never put the API key in a backup file
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: "location-spoofer-backup.json" });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$("import-data").onchange = guard(async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  let data;
  try { data = JSON.parse(await f.text()); } catch (_) { throw new Error("That file is not valid JSON."); }
  const okList = (x) => (Array.isArray(x) ? x : []);
  state.store = {
    favorites: [...state.store.favorites, ...okList(data.favorites).filter((v) => v && isFinite(v.lat) && isFinite(v.lon))],
    routes: [...state.store.routes, ...okList(data.routes).filter((r) => r && Array.isArray(r.waypoints))],
    settings: state.store.settings,
  };
  await saveStore();
  toast("Imported");
});

// ------------------------------------------------------------------ settings dialog
const settingsDlg = $("settings-dialog");
$("btn-settings").onclick = () => { $("key-status").textContent = ""; settingsDlg.showModal(); };
$("btn-key-show").onclick = () => {
  const k = $("google-key");
  k.type = k.type === "password" ? "text" : "password";
  $("btn-key-show").textContent = k.type === "password" ? "Show" : "Hide";
};
async function saveKey() {
  const key = $("google-key").value.trim();
  state.store.settings = { ...state.store.settings, google_api_key: key };
  await saveStore();
  state.google.session = null;
  await refreshGoogleStatus();
}
$("btn-key-test").onclick = busy($("btn-key-test"), "Testing…", async () => {
  await saveKey();
  if (!state.google.configured) { $("key-status").textContent = "No key entered."; return; }
  try {
    await ensureGoogleLayer();
    $("key-status").textContent = "✓ Map Tiles API works with this key.";
  } catch (e) {
    $("key-status").textContent = "✗ " + e.message;
  }
});
settingsDlg.addEventListener("close", guard(saveKey));
$("btn-tutorial-again").onclick = () => { settingsDlg.close(); openTutorial(0); };
async function refreshGoogleStatus() {
  try { state.google.configured = (await api("/api/google/status")).configured; } catch (_) { state.google.configured = false; }
  const opt = $("provider").querySelector('option[value="google"]');
  opt.textContent = state.google.configured ? "Google Maps" : "Google Maps (add API key in ⚙)";
  if (!state.google.configured && $("provider").value === "google") $("provider").value = "osrm";
}

// ------------------------------------------------------------------ first-run tutorial
const TUTORIAL = [
  { title: "Welcome", body: [
      "This app sets your iPhone's location from this computer over a USB cable: jump to any place, follow routes at realistic speeds, or replay GPX files.",
      "Use it only where it is allowed, for example testing your own apps. Games and dating, school or work apps often ban fake locations and can suspend accounts.",
      "Want to look around first? Pick “Simulator (no iPhone)” as the connection and skip ahead." ] },
  { title: "1 · Install Apple's device software", body: [
      "Windows needs Apple's iPhone drivers. Open the Microsoft Store, search for “Apple Devices” and install it (iTunes also works).",
      "Open it once and leave it running in the background while you use this app.",
      "macOS: nothing to install. Linux: install the usbmuxd package." ] },
  { title: "2 · Connect and trust", body: [
      "Plug the iPhone in with a cable and unlock it.",
      "When the phone asks “Trust This Computer?”, tap Trust and enter your passcode.",
      "Then press Look for devices (⟳): your iPhone should appear in the Device list." ],
    action: { label: "Look for devices now", run: () => refreshDevices(true) } },
  { title: "3 · Turn on Developer Mode", body: [
      "iOS only lets a computer change the location when Developer Mode is on. Press the button below (iPhone plugged in and unlocked) to make the switch appear.",
      "On the iPhone: Settings › Privacy & Security › Developer Mode → On → Restart. After the restart, unlock and tap Turn On.",
      "You only do this once per phone." ],
    action: { label: "Reveal Developer Mode", run: revealDevMode } },
  { title: "4 · Connect in this app", body: [
      "Choose “Direct (recommended)” as the connection and press Connect. The first connection to iOS 17 or newer can take up to 30 seconds.",
      "If it fails, the message says what is missing. The grey (i) buttons explain every device tool." ],
    action: { label: "Connect now", run: connectNow } },
  { title: "5 · Move your iPhone", body: [
      "Teleport: click the map (or paste a Google Maps link) and press Teleport here. Right-click the map to jump instantly.",
      "Route: click checkpoints, choose roads, footpaths or sea lanes, set speeds, Build route, then Play on device. The line's colour shows the speed.",
      "GPX: drop a .gpx file to replay it. Joystick: walk around live with W A S D.",
      "When you're done, press “Stop spoofing — back to real location”." ] },
];
let tutIndex = 0;
const tutDlg = $("tutorial");
function openTutorial(i = 0) { tutIndex = i; renderTutorial(); if (!tutDlg.open) tutDlg.showModal(); }
function renderTutorial() {
  const step = TUTORIAL[tutIndex];
  $("tut-step").textContent = `Step ${tutIndex + 1} of ${TUTORIAL.length}`;
  $("tut-title").textContent = step.title;
  $("tut-body").replaceChildren(...step.body.map((p) => el("p", { textContent: p })));
  const act = $("tut-action");
  act.replaceChildren();
  if (step.action) {
    const b = el("button", { type: "button", textContent: step.action.label });
    b.onclick = busy(b, "Working…", step.action.run);
    act.append(b);
  }
  $("tut-back").disabled = tutIndex === 0;
  $("tut-next").textContent = tutIndex === TUTORIAL.length - 1 ? "Start using the app" : "Next";
}
function finishTutorial() {
  tutDlg.close();
  state.store.settings = { ...state.store.settings, tutorial_done: true };
  saveStore().catch(() => {});
}
$("tut-back").onclick = () => { if (tutIndex > 0) { tutIndex--; renderTutorial(); } };
$("tut-next").onclick = () => { if (tutIndex < TUTORIAL.length - 1) { tutIndex++; renderTutorial(); } else finishTutorial(); };
$("tut-skip").onclick = finishTutorial;
tutDlg.addEventListener("cancel", (e) => { e.preventDefault(); finishTutorial(); });
$("btn-tutorial").onclick = () => openTutorial(0);

// ------------------------------------------------------------------ updates
$("btn-update-check").onclick = busy($("btn-update-check"), "Checking…", async () => {
  const u = await api("/api/update/check", { body: {} });
  if (!u.enabled) toast("Automatic updates only work in the installed app build. From source, run: git pull");
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
$("btn-tunneld").onclick = busy($("btn-tunneld"), "Starting…", async () => toast((await api("/api/tunneld/start", { body: {} })).message));

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
    $("device-status").textContent = state.restarting ? "Restarting…" : "Lost contact with the app. Is it still running?";
  }
  const active = state.status && ["playing", "joystick"].includes(state.status.player.state);
  pollTimer = setTimeout(poll, active ? 500 : 2000);
}

// ------------------------------------------------------------------ boot
wireInfoButtons();
renderWaypoints();
renderGpxDrop();
(async () => {
  await loadStore();
  await refreshGoogleStatus();
  await poll();
  refreshDevices(false);
  if (!state.store.settings.tutorial_done) openTutorial(0);
})();
