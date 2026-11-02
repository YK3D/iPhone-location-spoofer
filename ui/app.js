/* Location Spoofer — UI shared by the standalone and browser apps. Talks to the local server at /api. */
"use strict";

// ------------------------------------------------------------------ helpers
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "dataset") Object.assign(e.dataset, v);
    else if (k === "style") e.setAttribute("style", v);
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) e.append(kid);
  return e;
};

const SVG_NS = "http://www.w3.org/2000/svg";
// An icon from the sprite in index.html (monochrome, follows the text colour).
function svgIcon(name, cls = "ico") {
  const s = document.createElementNS(SVG_NS, "svg");
  s.setAttribute("class", cls);
  s.setAttribute("aria-hidden", "true");
  const u = document.createElementNS(SVG_NS, "use");
  u.setAttribute("href", `#i-${name}`);
  s.append(u);
  return s;
}
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

function errorText(data, status) {
  let msg = data && data.detail !== undefined ? data.detail : data;
  if (Array.isArray(msg)) msg = msg.map((d) => `${(d.loc || []).slice(1).join(".")}: ${d.msg}`).join("; ");
  return typeof msg === "string" && msg ? msg : `Request failed (HTTP ${status})`;
}

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
  if (!r.ok) throw new Error(errorText(data, r.status));
  return data;
}

// POST that streams NDJSON progress lines ({type: "progress" | "result" | "error"}); returns the result.
// A plain JSON answer (a validation error, or a server without streaming) is handled like api().
async function apiStream(path, body, onProgress) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("ndjson") || !r.body) {
    const data = ct.includes("json") ? await r.json() : await r.text();
    if (!r.ok) throw new Error(errorText(data, r.status));
    return data;
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", result = null;
  const handle = (line) => {
    if (!line.trim()) return;
    const ev = JSON.parse(line);
    if (ev.type === "progress") onProgress(ev);
    else if (ev.type === "result") result = ev.data;
    else if (ev.type === "error") throw new Error(ev.detail || `Request failed (HTTP ${ev.status})`);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    if (done) { handle(buf + dec.decode()); break; }
  }
  if (!result) throw new Error("The route build stopped before it finished. Try again.");
  return result;
}

let toastTimer;
function toast(msg, isErr = false, action = null) {
  const t = $("toast");
  t.replaceChildren(el("span", { textContent: msg }));
  if (action) t.append(el("button", { type: "button", textContent: action.label, onclick: () => { t.className = ""; action.run(); } }));
  t.className = "show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), action ? 8000 : isErr ? 7000 : 3500);
}
const guard = (fn) => async (...a) => {
  try { return await fn(...a); } catch (e) { toast(e.message || String(e), true); console.error(e); }
};
// Disable a button while an async action runs, so double clicks don't send twice.
const busy = (btn, label, fn) => guard(async (...a) => {
  if (btn.disabled) return;
  const old = [...btn.childNodes];
  btn.disabled = true;
  if (label) btn.textContent = label;
  try { await fn(...a); } finally { btn.disabled = false; btn.replaceChildren(...old); }
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
const SPEED_PRESETS = [
  ["Walk", 5, 0.5], ["Jog", 10, 0.8], ["Cycle", 18, 1.0], ["City car", 50, 2.0],
  ["Highway", 110, 2.5], ["Boat", 35, 0.3], ["Train", 160, 0.8], ["Plane", 850, 2.0],
];
const THEMES = [
  ["system", "System", "#f3f5f8", "#2563eb", "#15171b"], ["light", "Light", "#f3f5f8", "#2563eb", "#ffffff"],
  ["dark", "Dark", "#15171b", "#4b9bff", "#1e2126"], ["midnight", "Midnight", "#0b1020", "#7c8cff", "#121933"],
  ["graphite", "Graphite", "#1b1d21", "#10b981", "#23262b"], ["ocean", "Ocean", "#e9f4f8", "#0e7490", "#ffffff"],
  ["forest", "Forest", "#eef3ec", "#2f7d32", "#ffffff"], ["sunset", "Sunset", "#fff3ea", "#ea580c", "#ffffff"],
  ["rose", "Rose", "#fdf0f4", "#db2777", "#ffffff"], ["lavender", "Lavender", "#f3f0fb", "#7c3aed", "#ffffff"],
  ["sand", "Sand", "#f4ecdd", "#8b5e34", "#fbf6ec"], ["nord", "Nord", "#2e3440", "#88c0d0", "#3b4252"],
  ["dracula", "Dracula", "#1e1f29", "#bd93f9", "#282a36"], ["solarized-light", "Solarized light", "#eee8d5", "#268bd2", "#fdf6e3"],
  ["solarized-dark", "Solarized dark", "#002b36", "#2aa198", "#073642"], ["contrast-dark", "High contrast dark", "#000000", "#ffd400", "#0a0a0a"],
  ["contrast-light", "High contrast light", "#ffffff", "#0040c0", "#f2f2f2"],
];
const DARK_THEMES = new Set(["dark", "midnight", "graphite", "nord", "dracula", "solarized-dark", "contrast-dark"]);

// ------------------------------------------------------------------ state
const state = {
  tab: "teleport",
  picked: null,
  waypoints: [],           // {id, lat, lon, name, speed_kmh, dwell_s, leg:{mode,cruise_kmh,ramp}}
  built: null,
  builtSource: null,       // "route" | "gpx"
  gpx: null,
  gpxIndex: 0,
  store: { favorites: [], routes: [], settings: {} },
  status: null,
  preview: null,
  seeking: false,
  google: { configured: false, session: null, key: null, layer: null },
  devicesError: null,
};
let nextId = 1;
const settings = () => state.store.settings || (state.store.settings = {});

// ------------------------------------------------------------------ map
const map = L.map("map", { zoomControl: true, worldCopyJump: true }).setView([51.505, -0.09], 13);
const baseLayers = {
  "Streets": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap contributors", className: "osm-tiles" }),
  "Satellite": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19, attribution: "Imagery &copy; Esri" }),
  "Topographic": L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxZoom: 17, attribution: "&copy; OpenStreetMap contributors, SRTM | &copy; OpenTopoMap (CC-BY-SA)", className: "osm-tiles" }),
};
baseLayers.Streets.addTo(map);
const layerControl = L.control.layers(baseLayers).addTo(map);
L.control.scale().addTo(map);

const routeLayer = L.layerGroup().addTo(map);
const wpLineLayer = L.layerGroup().addTo(map);
const wpLayer = L.layerGroup().addTo(map);
const gpxLayer = L.layerGroup().addTo(map);
let pickMarker = null, deviceMarker = null, previewMarker = null, trailLine = null, realMarker = null, realCircle = null;
// Leaflet only centres a marker on its point when it knows the icon size (iconSize/iconAnchor);
// without them the icon's top-left corner sat on the point, half an icon off the route.
const icon = (cls, html = "", size = 14) => L.divIcon({ className: cls, html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });

map.on("click", (e) => {
  const lon = wrapLon(e.latlng.lng);
  if (state.tab === "route") addWaypoint(e.latlng.lat, lon);
  else setPicked(e.latlng.lat, lon, false);
});
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
      maxZoom: 22, attribution: "" });
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
  tip.style.maxWidth = Math.min(300, window.innerWidth - 24) + "px";
  const tr = tip.getBoundingClientRect();
  const left = Math.min(Math.max(12, r.left + r.width / 2 - tr.width / 2), window.innerWidth - tr.width - 12);
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
document.addEventListener("scroll", hideTip, true);

// ------------------------------------------------------------------ themes & appearance
function applyAppearance() {
  const s = settings();
  const theme = THEMES.some((t) => t[0] === s.theme) ? s.theme : "system";
  document.documentElement.dataset.theme = theme;
  const dark = DARK_THEMES.has(theme) || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("night-map", !!s.night_map && dark);
  document.documentElement.classList.toggle("compact", !!s.compact);
  document.querySelectorAll(".theme-card").forEach((c) => c.classList.toggle("active", c.dataset.theme === theme));
}
function renderThemeGrid() {
  $("theme-grid").replaceChildren(...THEMES.map(([id, name, bg, accent, panel]) =>
    el("button", { type: "button", class: "theme-card", dataset: { theme: id }, title: name,
      onclick: () => { settings().theme = id; applyAppearance(); saveSettingsSoon(); } },
      el("span", { class: "theme-swatch" },
        el("span", { style: `background:${bg}` }),
        el("span", {}, el("span", { style: `background:${accent}` }), el("span", { style: `background:${panel}` }))),
      el("span", { class: "theme-name", textContent: name }))));
  applyAppearance();
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyAppearance);
$("pref-night-map").onchange = (e) => { settings().night_map = e.target.checked; applyAppearance(); saveSettingsSoon(); };
$("pref-compact").onchange = (e) => { settings().compact = e.target.checked; applyAppearance(); saveSettingsSoon(); };

// ------------------------------------------------------------------ collapsible sections (open/closed state is remembered)
function wireSections() {
  document.querySelectorAll("details.section").forEach((d) => {
    d.addEventListener("toggle", () => {
      const s = settings();
      s.sections = { ...(s.sections || {}), [d.id]: d.open };
      saveSettingsSoon();
    });
  });
}
function applySections() {
  const saved = settings().sections || {};
  for (const [id, open] of Object.entries(saved)) {
    const d = $(id);
    if (d && d.tagName === "DETAILS") d.open = !!open;
  }
}

// ------------------------------------------------------------------ resizable / hideable side menu
const sidebar = $("sidebar"), resizer = $("resizer");
const SIDEBAR_DEFAULT = 380;
function setSidebarWidth(w, save = true) {
  const max = Math.max(320, Math.min(720, window.innerWidth * 0.7));
  w = Math.round(Math.min(max, Math.max(300, w)));
  document.documentElement.style.setProperty("--sidebar-w", w + "px");
  map.invalidateSize();
  if (save) { settings().sidebar_w = w; saveSettingsSoon(); }
}
resizer.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  resizer.setPointerCapture(e.pointerId);
  resizer.classList.add("drag");
  document.body.classList.add("resizing");
  const move = (ev) => setSidebarWidth(ev.clientX - sidebar.getBoundingClientRect().left, false);
  const up = () => {
    resizer.classList.remove("drag");
    document.body.classList.remove("resizing");
    resizer.removeEventListener("pointermove", move);
    setSidebarWidth(sidebar.getBoundingClientRect().width);
  };
  resizer.addEventListener("pointermove", move);
  resizer.addEventListener("pointerup", up, { once: true });
});
resizer.addEventListener("dblclick", () => setSidebarWidth(SIDEBAR_DEFAULT));
resizer.addEventListener("keydown", (e) => {
  const w = sidebar.getBoundingClientRect().width;
  if (e.key === "ArrowLeft") { e.preventDefault(); setSidebarWidth(w - 20); }
  if (e.key === "ArrowRight") { e.preventDefault(); setSidebarWidth(w + 20); }
});
function setSidebarHidden(hidden) {
  document.body.classList.toggle("sidebar-hidden", hidden);
  $("btn-show-sidebar").hidden = !hidden;
  setTimeout(() => map.invalidateSize(), 50);
}
$("btn-hide-sidebar").onclick = () => setSidebarHidden(true);
$("btn-show-sidebar").onclick = () => setSidebarHidden(false);

// ------------------------------------------------------------------ tabs
const TABS = ["teleport", "route", "gpx", "joystick", "saved"];
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
      const label = `${d.name || "iPhone"}${d.ios_version ? ` (iOS ${d.ios_version})` : ""} — ${d.connection || ""}${d.error ? " (needs attention)" : ""}`;
      sel.append(el("option", { value: d.udid, textContent: label, title: d.error || d.udid }));
    }
    if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
    if (!devices.length && userAsked) toast("No device found. Plug in the iPhone, unlock it and tap Trust.", true);
  } catch (e) {
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
async function disconnectNow() { await api("/api/disconnect", { body: {} }); await poll(); }
$("btn-connect").onclick = busy($("btn-connect"), "Connecting…", connectNow);
$("btn-disconnect").onclick = guard(disconnectNow);
async function revealDevMode() { toast((await api("/api/device/reveal-developer-mode", { body: {} })).message); }
$("btn-reveal").onclick = busy($("btn-reveal"), "Asking the iPhone…", revealDevMode);
$("btn-mount").onclick = busy($("btn-mount"), "Mounting…", async () => toast((await api("/api/device/mount", { body: {} })).message));

async function stopSpoofing() {
  await api("/api/location/clear", { body: {} });
  clearTrail();
  await poll();
  toast("Stopped spoofing. The iPhone uses its real GPS again.");
  await showRealLocation(true);
}
$("btn-clear").onclick = guard(stopSpoofing);

function renderDevice(st) {
  const d = st.device;
  const box = $("device-status"), chip = $("conn-chip");
  $("btn-connect").hidden = !!d;
  $("btn-disconnect").hidden = !d;
  if (d) {
    box.className = "status ok";
    box.textContent = `${d.name}${d.ios_version ? ` · iOS ${d.ios_version}` : ""} · ${d.transport}`;
    $("driver").value = st.driver;
    chip.className = "chip ok"; chip.textContent = d.name;
    $("dev-summary").textContent = `Connected · ${d.name}`;
  } else if (state.devicesError && $("driver").value !== "mock") {
    box.className = "status warn"; box.textContent = state.devicesError;
    chip.className = "chip warn"; chip.textContent = "Not ready";
    $("dev-summary").textContent = "Not connected";
  } else {
    box.className = "status"; box.textContent = "Not connected";
    chip.className = "chip"; chip.textContent = "Not connected";
    $("dev-summary").textContent = "Not connected";
  }
}

// ------------------------------------------------------------------ real location (after spoofing stops)
function showRealLocation(afterStop = false) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      if (!afterStop) toast("This window can't read your location.", true);
      return resolve(false);
    }
    navigator.geolocation.getCurrentPosition((pos) => {
      const ll = [pos.coords.latitude, pos.coords.longitude];
      if (realMarker) { map.removeLayer(realMarker); map.removeLayer(realCircle); }
      realCircle = L.circle(ll, { radius: Math.min(pos.coords.accuracy || 50, 5000), color: "#1a73e8", weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
      realMarker = L.marker(ll, { icon: icon("real-icon", "", 18), zIndexOffset: 900, title: "Your real location" }).addTo(map)
        .bindPopup(`<b>Your real location</b><br>Approximate position of this computer (±${Math.round(pos.coords.accuracy || 0)} m). The iPhone doesn't share its own GPS over USB.`);
      map.setView(ll, Math.max(map.getZoom(), 15));
      if (afterStop) realMarker.openPopup();
      resolve(true);
    }, (err) => {
      toast(err.code === 1 ? "Location permission was denied, so your real location can't be shown." :
        "Your real location isn't available (turn on location services for this computer to show it).", !afterStop);
      resolve(false);
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  });
}
$("btn-locate").onclick = guard(() => showRealLocation(false));

// ------------------------------------------------------------------ teleport
function setPicked(lat, lon, pan = true) {
  state.picked = [lat, lon];
  if (!pickMarker) pickMarker = L.marker([lat, lon], { icon: icon("pick-icon", "", 14), draggable: true })
    .on("dragend", (e) => { const p = e.target.getLatLng(); setPicked(p.lat, wrapLon(p.lng), false); })
    .addTo(map);
  else pickMarker.setLatLng([lat, lon]);
  if (pan) map.setView([lat, lon], Math.max(map.getZoom(), 15));
  $("picked").textContent = fmtLL(lat, lon);
  $("picked").classList.remove("muted");
  $("picked-sub").textContent = fmtLL(lat, lon);
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
  if (!state.picked) { toast("Pick a point on the map first."); return; }
  const r = await api("/api/location/set", { body: { lat: state.picked[0], lon: state.picked[1] } });
  toast(`Location set to ${fmtLL(r.lat, r.lon)}${r.jump_m ? ` (jumped ${fmtDist(r.jump_m)})` : ""}`);
  await poll();
}
$("btn-teleport").onclick = busy($("btn-teleport"), "Setting…", teleport);
$("btn-copy").onclick = guard(async () => { await navigator.clipboard.writeText(fmtLL(...state.picked)); toast("Copied"); });
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
  for (const r of results) list.append(el("li", { textContent: r.name, onclick: () => { setPicked(r.lat, r.lon); list.replaceChildren(); } }));
}));

// ------------------------------------------------------------------ Google Maps links
async function parseGoogleLink(text) {
  if (!text.trim()) throw new Error("Paste a Google Maps link first.");
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
$("btn-gmaps-link").onclick = busy($("btn-gmaps-link"), "…", () => openGoogleLink($("gmaps-link").value));
$("gmaps-link").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btn-gmaps-link").click(); });
$("btn-route-link").onclick = busy($("btn-route-link"), "…", async () => {
  const p = await parseGoogleLink($("route-link").value);
  if (p.kind === "point") {
    addWaypoint(p.stops[0].lat, p.stops[0].lon, { name: p.stops[0].name || "" });
    toast("That link is a single place; it was added as a checkpoint.");
  } else loadLinkAsRoute(p);
});
$("route-link").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btn-route-link").click(); });

// ------------------------------------------------------------------ route builder
function defaultLeg() { return { mode: $("default-mode").value, cruise_kmh: null, ramp: "accel" }; }
function addWaypoint(lat, lon, extra = {}) {
  const w = { id: nextId++, lat, lon, name: "", speed_kmh: null, dwell_s: 0, leg: defaultLeg(), ...extra };
  state.waypoints.push(w);
  invalidateBuilt();
  renderWaypoints({ appear: w.id });
}
// A route changed: the built route (and the player) no longer match it.
function invalidateBuilt() {
  state.routeRev = (state.routeRev || 0) + 1;
  if (state.builtSource !== "route") return;
  const hadRoute = !!state.built;
  routeLayer.clearLayers();
  $("route-result").replaceChildren();
  $("sec-route-result").hidden = true;
  $("speed-legend").hidden = true;
  state.built = null;
  state.options = null;
  stopPreview();
  drawCheckpointLine();
  const p = state.status && state.status.player;
  if (hadRoute && state.loaded === "route" && p && !["playing", "joystick"].includes(p.state)) unloadPlayer();
}
async function unloadPlayer() {
  try { await api("/api/player/unload", { body: {} }); } catch (_) { /* older server */ }
  state.loaded = null;
  clearTrail();
  await poll();
}
// Restart a CSS animation class on an element (press / settle / appear effects).
function flash(elm, cls) {
  if (!elm) return;
  elm.classList.remove(cls);
  void elm.offsetWidth;
  elm.classList.add(cls);
  elm.addEventListener("animationend", () => elm.classList.remove(cls), { once: true });
}

// ---- checkpoint markers: kept by id, so a dropped marker can finish its settle animation
const wpMarkers = new Map();
const wpById = (id) => state.waypoints.find((x) => x.id === id);
function wireMarker(m, id) {
  const elm = () => m.getElement();
  m.on("add", () => {
    const e = elm();
    e.addEventListener("pointerdown", (ev) => { if (ev.button === 0) e.classList.add("pressed"); });
  });
  m.on("dragstart", () => { const e = elm(); e.classList.remove("pressed"); e.classList.add("lifted"); });
  m.on("drag", () => { if (!state.built) drawCheckpointLine(id, m.getLatLng()); });
  m.on("dragend", () => {
    const e = elm();
    e.classList.remove("lifted");
    flash(e, "settle");
    const w = wpById(id);
    if (!w) return;
    const p = m.getLatLng();
    w.lat = p.lat; w.lon = wrapLon(p.lng);
    if (w.lon !== p.lng) m.setLatLng([w.lat, w.lon]);
    invalidateBuilt();
    renderWaypoints();
  });
}
window.addEventListener("pointerup", () => document.querySelectorAll(".wp-icon.pressed").forEach((e) => e.classList.remove("pressed")));
function syncMarkers(appearId) {
  const seen = new Set();
  state.waypoints.forEach((w, i) => {
    seen.add(w.id);
    const label = String(i + 1);
    const title = w.name || `Checkpoint ${i + 1}`;
    let m = wpMarkers.get(w.id);
    if (!m) {
      m = L.marker([w.lat, w.lon], { draggable: true, autoPan: true, title, riseOnHover: true,
        icon: icon("wp-icon", `<div class="wp-pin">${label}</div>`, 24) });
      wireMarker(m, w.id);
      m.addTo(wpLayer);
      wpMarkers.set(w.id, m);
      if (appearId === w.id) flash(m.getElement(), "appear");
      return;
    }
    const ll = m.getLatLng();
    if (ll.lat !== w.lat || ll.lng !== w.lon) m.setLatLng([w.lat, w.lon]);
    const e = m.getElement();
    const pin = e && e.querySelector(".wp-pin");
    if (pin && pin.textContent !== label) pin.textContent = label;
    if (e) e.title = title;
  });
  for (const [id, m] of wpMarkers) if (!seen.has(id)) { wpLayer.removeLayer(m); wpMarkers.delete(id); }
}
function markerHot(id, on) {
  const m = wpMarkers.get(id);
  if (m && m.getElement()) m.getElement().classList.toggle("hot", on);
}
// Dashed straight lines between checkpoints, shown until a route is built.
function drawCheckpointLine(movingId, movingLatLng) {
  wpLineLayer.clearLayers();
  if (state.built && state.builtSource === "route") return;
  const pts = state.waypoints.map((w) => (w.id === movingId && movingLatLng ? [movingLatLng.lat, movingLatLng.lng] : [w.lat, w.lon]));
  if ($("closed").checked && pts.length > 1) pts.push(pts[0]);
  if (pts.length > 1) L.polyline(pts, { color: "#6b7280", weight: 2, dashArray: "4 6", interactive: false }).addTo(wpLineLayer);
}

// ---- checkpoint list
const wpList = $("waypoints");
function captureRects() {
  const m = new Map();
  wpList.querySelectorAll(":scope > li.wp").forEach((li) => m.set(li.dataset.id, li.getBoundingClientRect()));
  return m;
}
// FLIP: rows start where they were drawn before the change and glide to their new place.
function playFlip(first, settleId) {
  const moved = [];
  wpList.querySelectorAll(":scope > li.wp").forEach((li) => {
    const a = first.get(li.dataset.id);
    if (!a) return;
    const dy = a.top - li.getBoundingClientRect().top;
    if (Math.abs(dy) < 0.5) return;
    li.style.transition = "none";
    li.style.translate = `0 ${dy}px`;
    moved.push(li);
  });
  if (settleId != null) flash(wpList.querySelector(`:scope > li.wp[data-id="${settleId}"]`), "settle");
  if (!moved.length) return;
  void wpList.offsetHeight;
  for (const li of moved) {
    li.style.transition = "";
    li.classList.add("shift");
    li.style.translate = "";
    li.addEventListener("transitionend", () => li.classList.remove("shift"), { once: true });
  }
}
function moveWaypoint(from, to) {
  if (from === to || to < 0 || to >= state.waypoints.length) return;
  const [w] = state.waypoints.splice(from, 1);
  state.waypoints.splice(to, 0, w);
  invalidateBuilt();
  renderWaypoints({ flip: true, settle: w.id });
}
function removeWaypoint(id) {
  const i = state.waypoints.findIndex((x) => x.id === id);
  if (i < 0) return;
  state.waypoints.splice(i, 1);
  invalidateBuilt();
  renderWaypoints({ flip: true });
}
function renderWaypoints(opts = {}) {
  const first = opts.flip ? captureRects() : null;
  const focusedGrip = document.activeElement && document.activeElement.classList.contains("wp-grip")
    ? document.activeElement.closest("li.wp").dataset.id : null;
  wpList.replaceChildren();
  const n = state.waypoints.length;
  const closed = $("closed").checked;
  $("wp-count").textContent = n ? `${n} checkpoint${n > 1 ? "s" : ""}` : "";
  if (!n) wpList.append(el("li", { class: "hint", textContent: "No checkpoints yet — click the map." }));
  state.waypoints.forEach((w, i) => {
    const change = (fn) => (e) => { fn(e.target); invalidateBuilt(); };
    const grip = el("button", { type: "button", class: "wp-grip", title: "Drag to reorder (or focus and press the arrow keys)",
      "aria-label": `Move checkpoint ${i + 1}. Use the up and down arrow keys.` }, svgIcon("grip"));
    const num = el("span", { class: "wp-num", textContent: i + 1, title: "Drag to reorder" });
    const head = el("div", { class: "wp-head" }, grip, num,
      el("input", { value: w.name, placeholder: fmtLL(w.lat, w.lon), title: "Name", "aria-label": "Checkpoint name", oninput: (e) => (w.name = e.target.value) }),
      el("button", { type: "button", class: "wp-del", title: "Remove", "aria-label": `Remove checkpoint ${i + 1}`, onclick: () => removeWaypoint(w.id) }, svgIcon("x")),
    );
    const fields = el("div", { class: "wp-fields" },
      el("label", {}, "Speed here (km/h)",
        el("input", { type: "number", min: 0, step: 0.1, value: w.speed_kmh ?? "", placeholder: "auto",
          title: "Exact speed when passing this checkpoint. Blank = whatever the limits allow. 0 = come to a stop.",
          onchange: change((t) => (w.speed_kmh = numOrNull(t.value))) })),
      el("label", {}, "Wait here (s)",
        el("input", { type: "number", min: 0, step: 1, value: w.dwell_s || "", placeholder: "0", title: "Stop and wait this long",
          onchange: change((t) => (w.dwell_s = Math.max(0, +t.value || 0))) })),
    );
    const li = el("li", { class: "wp", dataset: { id: w.id } }, head, fields);
    if (i < n - 1 || (closed && n > 1)) {
      const modeSel = el("select", { title: "How this leg is routed", "aria-label": "Leg routing", onchange: change((t) => { w.leg.mode = t.value; }) },
        ...Object.entries(MODE_LABEL).map(([k, v]) => el("option", { value: k, textContent: v, selected: w.leg.mode === k })));
      const cruise = el("input", { type: "number", min: 0.1, step: 0.1, value: w.leg.cruise_kmh ?? "", "aria-label": "Leg speed",
        placeholder: $("road-aware").checked ? "road speed" : `${$("default-speed").value} km/h`,
        title: "Cruise speed for this leg (km/h). Blank = default (or the road's speed in road-aware mode).",
        onchange: change((t) => (w.leg.cruise_kmh = numOrNull(t.value))) });
      const ramp = el("select", { title: "How speed changes on this leg", "aria-label": "Speed ramp", onchange: change((t) => (w.leg.ramp = t.value)) },
        el("option", { value: "accel", textContent: "Accel rate", selected: w.leg.ramp === "accel" }),
        el("option", { value: "linear", textContent: "Even ramp", selected: w.leg.ramp === "linear" }));
      li.append(el("div", { class: "leg", title: `Leg ${i + 1} → ${i + 2 > n ? 1 : i + 2}` }, modeSel, cruise, ramp));
    }
    for (const h of [grip, num]) h.addEventListener("pointerdown", (e) => startSort(e, li, h));
    grip.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const at = state.waypoints.findIndex((x) => x.id === w.id);
      moveWaypoint(at, at + (e.key === "ArrowUp" ? -1 : 1));
    });
    li.addEventListener("mouseenter", () => markerHot(w.id, true));
    li.addEventListener("mouseleave", () => markerHot(w.id, false));
    if (opts.appear === w.id) flash(li, "settle");
    wpList.append(li);
  });
  if (first) playFlip(first, opts.settle);
  if (focusedGrip) { const g = wpList.querySelector(`li.wp[data-id="${focusedGrip}"] .wp-grip`); if (g) g.focus(); }
  syncMarkers(opts.appear);
  drawCheckpointLine();
  renderRouteSettingsSub();
}

// ---- drag to reorder: rows slide out of the way while you drag, then everything glides into place
let sortDrag = null;
function startSort(e, li, handle) {
  if (e.button !== 0 || sortDrag || state.waypoints.length < 2) return;
  e.preventDefault();
  handle.setPointerCapture(e.pointerId);
  const sidebar = $("sidebar");
  const scroller = sidebar.scrollHeight > sidebar.clientHeight + 1 ? sidebar : document.scrollingElement;
  const items = [...wpList.querySelectorAll(":scope > li.wp")];
  li.classList.add("pressed");
  sortDrag = { li, handle, items, index: items.indexOf(li), target: items.indexOf(li), pointerId: e.pointerId,
    startY: e.clientY, y: e.clientY, scroller, startScroll: scroller.scrollTop, started: false, raf: 0 };
  handle.addEventListener("pointermove", onSortMove);
  handle.addEventListener("pointerup", onSortEnd);
  handle.addEventListener("pointercancel", onSortEnd);
  handle.addEventListener("lostpointercapture", onSortEnd);
}
function onSortMove(e) {
  const d = sortDrag;
  if (!d || e.pointerId !== d.pointerId) return;
  d.y = e.clientY;
  if (d.started || Math.abs(d.y - d.startY) < 4) return;
  d.started = true;
  const top = d.scroller.scrollTop;
  d.rects = d.items.map((it) => { const r = it.getBoundingClientRect(); return { top: r.top + top, h: r.height }; });
  d.li.classList.remove("pressed");
  d.li.classList.add("dragging");
  wpList.classList.add("sorting");
  d.items.forEach((it) => { if (it !== d.li) it.classList.add("shift"); });
  d.raf = requestAnimationFrame(sortFrame);
}
function sortFrame() {
  const d = sortDrag;
  if (!d || !d.started) return;
  // scroll the side menu when the row is dragged close to its visible top or bottom edge
  const tabs = document.querySelector(".tabs").getBoundingClientRect();
  const player = $("player").getBoundingClientRect();
  const view = d.scroller === document.scrollingElement ? { top: 0, bottom: innerHeight } : d.scroller.getBoundingClientRect();
  const topEdge = Math.max(view.top, tabs.bottom);
  const bottomEdge = player.top > topEdge && player.top < view.bottom ? player.top : view.bottom;
  const zone = 44;
  let v = 0;
  if (d.y < topEdge + zone) v = -Math.ceil(((topEdge + zone - d.y) / zone) * 12);
  else if (d.y > bottomEdge - zone) v = Math.ceil(((d.y - bottomEdge + zone) / zone) * 12);
  if (v) d.scroller.scrollTop += v;
  const me = d.rects[d.index];
  const firstRow = d.rects[0], lastRow = d.rects[d.rects.length - 1];
  const raw = d.y - d.startY + (d.scroller.scrollTop - d.startScroll);
  const dy = Math.max(firstRow.top - me.top - 10, Math.min(lastRow.top + lastRow.h - me.top - me.h + 10, raw));
  d.li.style.translate = `0 ${dy}px`;
  const center = me.top + me.h / 2 + dy;
  let target = d.index;
  for (let j = d.index + 1; j < d.rects.length; j++) if (center > d.rects[j].top + d.rects[j].h / 2) target = j;
  for (let j = d.index - 1; j >= 0; j--) if (center < d.rects[j].top + d.rects[j].h / 2) target = j;
  if (target !== d.target) {
    d.target = target;
    d.items.forEach((it, j) => {
      if (j === d.index) return;
      const off = d.index < target && j > d.index && j <= target ? -me.h : d.index > target && j < d.index && j >= target ? me.h : 0;
      it.style.translate = off ? `0 ${off}px` : "";
    });
  }
  d.raf = requestAnimationFrame(sortFrame);
}
function onSortEnd(e) {
  const d = sortDrag;
  if (!d || (e.pointerId !== undefined && e.pointerId !== d.pointerId)) return;
  sortDrag = null;
  for (const t of ["pointermove", "pointerup", "pointercancel", "lostpointercapture"]) d.handle.removeEventListener(t, t === "pointermove" ? onSortMove : onSortEnd);
  cancelAnimationFrame(d.raf);
  wpList.classList.remove("sorting");
  if (!d.started) { d.li.classList.remove("pressed"); return; } // a click on the handle, not a drag
  const id = d.li.dataset.id;
  if (e.type === "pointercancel" || d.target === d.index) {
    renderWaypoints({ flip: true, settle: id });
    return;
  }
  const [w] = state.waypoints.splice(d.index, 1);
  state.waypoints.splice(d.target, 0, w);
  invalidateBuilt();
  renderWaypoints({ flip: true, settle: w.id });
}

function renderRouteSettingsSub() {
  const alts = +$("alt-count").value || 0;
  $("route-settings-sub").textContent = `${MODE_LABEL[$("default-mode").value]} · ${$("default-speed").value} km/h`
    + `${$("road-aware").checked ? " · road-aware" : ""}${alts ? ` · ${alts} alt.` : ""}`;
}
$("closed").onchange = () => { invalidateBuilt(); renderWaypoints(); };
$("default-speed").onchange = () => renderWaypoints();
$("default-mode").onchange = () => renderRouteSettingsSub();
$("alt-count").addEventListener("change", renderRouteSettingsSub);
async function clearRoute() {
  const saved = { waypoints: state.waypoints.map((w) => ({ ...w, leg: { ...w.leg } })), built: state.built };
  state.builtSource = "route";
  state.waypoints = [];
  invalidateBuilt();
  renderWaypoints();
  const p = state.status && state.status.player;
  if (p && state.loaded === "route" && p.state !== "joystick") {
    if (["playing", "paused"].includes(p.state)) await api("/api/player/stop", { body: {} }).catch(() => {});
    await unloadPlayer();
  }
  if (saved.waypoints.length) {
    toast(`Cleared ${saved.waypoints.length} checkpoint${saved.waypoints.length > 1 ? "s" : ""}.`, false,
      { label: "Undo", run: () => { state.waypoints = saved.waypoints; renderWaypoints(); toast("Checkpoints restored. Press Build route to load it again."); } });
  }
}
$("btn-clear-route").onclick = guard(clearRoute);
$("btn-reverse").onclick = () => {
  const n = state.waypoints.length;
  const legs = state.waypoints.map((w) => w.leg);
  state.waypoints.reverse();
  state.waypoints.forEach((w, i) => (w.leg = { ...(i < n - 1 ? legs[n - 2 - i] : legs[n - 1]) || defaultLeg() }));
  invalidateBuilt(); renderWaypoints({ flip: true });
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
    toast("Add your Google Maps API key in Settings › Google Maps to use Google routing.", true);
    $("provider").value = "osrm";
  }
});
function profileSettings() {
  return {
    default_cruise_kmh: +$("default-speed").value || 5, accel_ms2: +$("accel").value || 1, decel_ms2: +$("decel").value || 1,
    start_from_rest: $("start-rest").checked, stop_at_end: $("stop-end").checked,
    road_aware: $("road-aware").checked, road_data: $("road-data").checked, match_eta: $("match-eta").checked,
    corner_slowdown: $("corner-slow").checked, speed_factor: +$("speed-factor").value || 1,
  };
}
function routeBody(name = "Route") {
  const wps = state.waypoints;
  const closed = $("closed").checked;
  const legs = wps.slice(0, closed ? wps.length : wps.length - 1).map((w) => w.leg);
  return {
    name, closed, provider: $("provider").value, settings: profileSettings(), legs,
    alternatives: Math.max(0, Math.min(3, +$("alt-count").value || 0)),
    waypoints: wps.map((w, i) => ({ lat: w.lat, lon: w.lon, name: w.name || `Checkpoint ${i + 1}`, speed_kmh: w.speed_kmh, dwell_s: w.dwell_s || 0 })),
  };
}

// ---- build button: a progress bar with the stage the server is working on
const buildBtn = $("btn-build");
const bp = { fill: buildBtn.querySelector(".build-fill"), ticker: buildBtn.querySelector(".build-ticker"), pct: buildBtn.querySelector(".build-pct"),
  shown: 0, target: 0, next: 0, raf: 0, last: 0, current: "", queue: [], msgAt: 0, timer: 0, resetTimer: 0 };
const TICK_MIN_MS = 380; // each stage message stays readable for at least this long
function buildStart() {
  clearTimeout(bp.resetTimer); clearTimeout(bp.timer);
  Object.assign(bp, { shown: 0, target: 0, next: 0.02, current: "", queue: [], msgAt: 0, timer: 0, last: performance.now() });
  bp.ticker.replaceChildren();
  bp.fill.style.width = "0%";
  bp.pct.textContent = "0%";
  buildBtn.classList.remove("done", "failed");
  buildBtn.classList.add("loading");
  buildBtn.disabled = true;
  buildBtn.setAttribute("aria-busy", "true");
  cancelAnimationFrame(bp.raf);
  bp.raf = requestAnimationFrame(buildFrame);
}
// p: share of the work done, next: where this stage is expected to end. Network calls report no
// progress of their own, so the bar creeps towards `next` (never past it) until the next report.
function buildStage(p, msg, next = p) {
  bp.target = Math.min(1, Math.max(bp.target, p));
  bp.next = Math.min(1, Math.max(bp.next, next, bp.target));
  if (msg) tickerMessage(msg);
}
function buildFrame(now) {
  const dt = Math.min(0.1, (now - bp.last) / 1000);
  bp.last = now;
  if (bp.shown < bp.target - 0.002) bp.shown += (bp.target - bp.shown) * Math.min(1, dt * 9);
  else {
    bp.shown = Math.max(bp.shown, bp.target);
    const ceiling = bp.target + (bp.next - bp.target) * 0.92;
    if (bp.shown < ceiling) bp.shown += (ceiling - bp.shown) * (1 - Math.exp(-dt / 1.4));
  }
  bp.fill.style.width = `${(bp.shown * 100).toFixed(2)}%`;
  bp.pct.textContent = `${Math.min(99, Math.floor(bp.shown * 100))}%`;
  bp.raf = requestAnimationFrame(buildFrame);
}
function tickerMessage(msg) {
  if (msg === bp.current || bp.queue.includes(msg)) return;
  if (!bp.queue.length && performance.now() - bp.msgAt >= TICK_MIN_MS) { showTick(msg); return; }
  bp.queue.push(msg);
  if (bp.queue.length > 2) bp.queue.shift(); // keep the newest two, so the text never lags far behind
  scheduleTick();
}
function scheduleTick() {
  if (bp.timer) return;
  bp.timer = setTimeout(() => {
    bp.timer = 0;
    const m = bp.queue.shift();
    if (m) showTick(m);
    if (bp.queue.length) scheduleTick();
  }, Math.max(0, bp.msgAt + TICK_MIN_MS - performance.now()));
}
function showTick(msg, iconName) {
  bp.current = msg;
  bp.msgAt = performance.now();
  const text = el("span", { textContent: msg });
  const tick = el("span", { class: "tick below" }, ...(iconName ? [svgIcon(iconName)] : []), text);
  const old = [...bp.ticker.children];
  bp.ticker.append(tick);
  void tick.offsetWidth;
  tick.classList.remove("below");
  for (const o of old) { o.classList.add("above"); setTimeout(() => o.remove(), 300); }
  // long messages scroll sideways so they can be read in a narrow side menu
  requestAnimationFrame(() => {
    const overflow = tick.scrollWidth - tick.clientWidth;
    if (overflow > 2) {
      tick.style.setProperty("--shift", `-${overflow + 6}px`);
      tick.style.setProperty("--dur", `${Math.max(2.2, overflow / 28).toFixed(1)}s`);
      tick.classList.add("marquee");
    }
  });
  $("build-status").textContent = msg;
}
function buildFinish(ok, msg) {
  cancelAnimationFrame(bp.raf);
  clearTimeout(bp.timer);
  bp.timer = 0;
  bp.queue = [];
  buildBtn.classList.remove("loading");
  buildBtn.classList.add(ok ? "done" : "failed");
  buildBtn.disabled = false;
  buildBtn.removeAttribute("aria-busy");
  if (ok) { bp.fill.style.width = "100%"; bp.pct.textContent = "100%"; }
  else bp.pct.textContent = "";
  showTick(msg, ok ? "check" : "warn");
  bp.resetTimer = setTimeout(buildReset, ok ? 2200 : 2600);
}
function buildReset() {
  cancelAnimationFrame(bp.raf);
  buildBtn.classList.remove("loading", "done", "failed");
  buildBtn.disabled = false;
  bp.fill.style.width = "0%";
  bp.ticker.replaceChildren();
}
function noAlternativesReason(body) {
  const roads = body.legs.filter((l) => ["car", "bike", "foot"].includes(l.mode)).length;
  return roads ? "No alternative routes were found for these checkpoints (short legs often have only one sensible way)."
    : "Sea and straight-line legs have no alternative routes.";
}
async function buildRoute() {
  if (state.building) return;
  if (state.waypoints.length < 2) throw new Error("Add at least two checkpoints (click the map in the Route tab).");
  state.building = true;
  const rev = state.routeRev;
  buildStart();
  buildStage(0, "Preparing the route", 0.02);
  try {
    const body = routeBody($("route-name").value.trim() || "Route");
    const res = await apiStream("/api/route/build?stream=1", body, (ev) => buildStage(ev.p, ev.msg, ev.next));
    if (rev !== state.routeRev) {
      buildReset();
      toast("The checkpoints changed while the route was building. Press Build route again.");
      return;
    }
    buildStage(0.97, "Drawing the route on the map", 0.98);
    await nextFrame();
    state.options = [res, ...(res.alternatives || [])];
    state.optionIndex = 0;
    state.built = res;
    state.builtSource = "route";
    gpxLayer.clearLayers();
    if ((res.providers || []).includes("google")) await useGoogleBase();
    drawRoute({ fit: true });
    buildStage(0.98, "Plotting the speed graph", 0.99);
    await nextFrame();
    showRouteResult(res);
    renderWaypoints();
    buildStage(0.99, "Loading the route into the player", 1);
    await api(`/api/player/load/${res.id}`, { body: {} });
    state.loaded = "route";
    clearTrail();
    await poll();
    const n = state.options.length;
    buildFinish(true, `Route ready · ${fmtDist(res.summary.distance_m)} · ${fmtTime(res.summary.duration_s)}${n > 1 ? ` · ${n} options` : ""}`);
    if (body.alternatives && n === 1) toast(noAlternativesReason(body));
    else if (body.alternatives && n - 1 < body.alternatives) toast(`Found ${n - 1} of ${body.alternatives} alternative routes. Pick one under Route summary or click a grey line on the map.`);
  } catch (e) {
    buildFinish(false, "Couldn't build the route");
    throw e;
  } finally {
    state.building = false;
  }
}
buildBtn.onclick = guard(buildRoute);
function showRouteResult(res) {
  renderResult($("route-result"), res);
  $("sec-route-result").hidden = false;
  $("sec-route-result").open = true;
  $("route-result-sub").textContent = `${(state.options || []).length > 1 ? `Route ${res.option.label} · ` : ""}${fmtDist(res.summary.distance_m)} · ${fmtTime(res.summary.duration_s)}`;
}
async function selectOption(k) {
  const opts = state.options || [];
  if (!opts[k] || state.optionIndex === k) return;
  const p = state.status && state.status.player;
  const wasPlaying = p && state.loaded === "route" && ["playing", "paused"].includes(p.state);
  state.optionIndex = k;
  state.built = opts[k];
  stopPreview();
  drawRoute();
  showRouteResult(opts[k]);
  await api(`/api/player/load/${opts[k].id}`, { body: {} });
  state.loaded = "route";
  clearTrail();
  await poll();
  toast(`Using route ${opts[k].option.label}${wasPlaying ? ". Playback stopped; press Play to drive it." : "."}`);
}

// ------------------------------------------------------------------ route line: outlined, coloured by speed
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
// Point at fraction f of the great circle from a to b (what the device follows on long straight legs).
function gcInterp(a, b, f) {
  const r = Math.PI / 180, d = haversine(a, b) / 6371008.8;
  if (d < 1e-9) return a;
  const [p1, l1, p2, l2] = [a[0] * r, a[1] * r, b[0] * r, b[1] * r];
  const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
  const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
  const z = A * Math.sin(p1) + B * Math.sin(p2);
  let lon = Math.atan2(y, x) / r;
  while (lon - a[1] > 180) lon -= 360;
  while (lon - a[1] < -180) lon += 360;
  return [Math.atan2(z, Math.hypot(x, y)) / r, lon];
}
// All legs as one path with the distance along it, so it lines up with the timeline's distances.
function routePath(legs) {
  const out = [];
  let prev = null, d = 0;
  for (const leg of legs || []) {
    for (const p of leg) {
      if (!prev) { out.push({ ll: p, d: 0 }); prev = p; continue; }
      const step = haversine(prev, p);
      if (step < 1e-3) continue; // the shared checkpoint between two legs
      const n = step > 2000 ? Math.min(64, Math.ceil(step / 2000)) : 1;
      for (let k = 1; k <= n; k++) out.push({ ll: k === n ? p : gcInterp(prev, p, k / n), d: d + (step * k) / n });
      d += step;
      prev = p;
    }
  }
  return out;
}
// Speed (km/h) at a distance along the route, from the preview samples [t, lat, lon, km/h, m].
function speedLookup(pv) {
  if (!pv || pv.length < 2 || pv[0].length < 5) return null;
  const D = pv.map((p) => p[4]);
  return (dist) => {
    let lo = 0, hi = D.length - 1;
    if (dist <= D[0]) return pv[0][3];
    if (dist >= D[hi]) return pv[hi][3];
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (D[mid] <= dist) lo = mid; else hi = mid; }
    const span = D[hi] - D[lo];
    return pv[lo][3] + (pv[hi][3] - pv[lo][3]) * (span > 0 ? (dist - D[lo]) / span : 0);
  };
}
const LINE = { lineCap: "round", lineJoin: "round" };
function optionLabel(o, k) { return o.option ? o.option.label : "ABCD"[k] || String(k + 1); }
function drawRoute({ fit = false } = {}) {
  const res = state.built;
  const layer = state.builtSource === "gpx" ? gpxLayer : routeLayer;
  layer.clearLayers();
  if (!res) return;
  const opts = state.options && state.options.length ? state.options : [res];
  // Other route options underneath in grey. Clicking one switches to it.
  opts.forEach((o, k) => {
    if (o === res) return;
    const pts = routePath(o.legs).map((g) => g.ll);
    const d = o.summary.duration_s - opts[0].summary.duration_s;
    L.polyline(pts, { ...LINE, color: "#334155", weight: 9, opacity: 0.45, interactive: false }).addTo(layer);
    L.polyline(pts, { ...LINE, color: "#a3acb9", weight: 5.5, opacity: 1, className: "route-alt", bubblingMouseEvents: false })
      .bindTooltip(`Route ${optionLabel(o, k)} · ${fmtDist(o.summary.distance_m)} · ${fmtTime(o.summary.duration_s)}`
        + `${k ? ` (${d >= 0 ? "+" : "−"}${fmtTime(Math.abs(d))})` : ""} — click to use it`, { sticky: true })
      .on("click", () => guard(selectOption)(k))
      .addTo(layer);
  });
  // The chosen route: a white halo and a dark outline keep it readable over roads of any colour
  // (and over satellite imagery), then the speed colours on top.
  const path = routePath(res.legs);
  const pts = path.map((g) => g.ll);
  L.polyline(pts, { ...LINE, color: "#ffffff", weight: 13, opacity: 0.6, interactive: false }).addTo(layer);
  L.polyline(pts, { ...LINE, color: "#0f172a", weight: 9.5, opacity: 0.9, interactive: false }).addTo(layer);
  const pv = res.preview || [];
  const vmax = Math.max(1, ...pv.map((p) => p[3]));
  const vmin = Math.min(...pv.map((p) => p[3]), vmax);
  const span = Math.max(1, vmax - vmin);
  const at = speedLookup(pv);
  // colour runs along the real geometry (older servers without distances: along the samples)
  const samples = at ? path.map((g) => ({ ll: g.ll, v: at(g.d) })) : pv.map((p) => ({ ll: [p[1], p[2]], v: p[3] }));
  let run = [], runBucket = -1;
  const flush = () => {
    if (run.length < 2) return;
    const lo = Math.min(...run.map((p) => p.v)), hi = Math.max(...run.map((p) => p.v));
    L.polyline(run.map((p) => p.ll), { ...LINE, color: speedColor(runBucket / 20), weight: 5.5, opacity: 1 })
      .bindTooltip(`${lo.toFixed(0)}–${hi.toFixed(0)} km/h`, { sticky: true })
      .addTo(layer);
  };
  for (const p of samples) {
    const bucket = Math.round(((p.v - vmin) / span) * 20);
    if (bucket !== runBucket && run.length) { const last = run[run.length - 1]; flush(); run = [last]; }
    runBucket = bucket;
    run.push(p);
  }
  flush();
  $("legend-min").textContent = vmin.toFixed(0);
  $("legend-max").textContent = vmax.toFixed(0);
  $("speed-legend").hidden = pv.length < 2;
  if (fit) {
    const all = opts.flatMap((o) => (o.legs || []).flat());
    if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [30, 30] });
  }
}
function fitRoute() {
  const layers = [];
  [routeLayer, gpxLayer, wpLayer].forEach((g) => g.eachLayer((l) => layers.push(l)));
  if (!layers.length) { toast("Nothing to fit yet."); return; }
  map.fitBounds(L.featureGroup(layers).getBounds(), { padding: [30, 30] });
}
function routeOptionsList() {
  const opts = state.options || [];
  if (opts.length < 2) return null;
  const base = opts[0].summary;
  const quickest = Math.min(...opts.map((o) => o.summary.duration_s));
  const multiLeg = (opts[0].legs || []).length > 1;
  return el("div", { class: "route-options", role: "radiogroup", "aria-label": "Route options" },
    ...opts.map((o, k) => {
      const s = o.summary, dt = s.duration_s - base.duration_s;
      const meta = [];
      if (k === 0) meta.push("main route");
      if (s.duration_s <= quickest + 0.5) meta.push("quickest");
      if (o.option && o.option.detour) meta.push("detour");
      if (k && multiLeg && o.option && o.option.changed_legs.length) meta.push(`differs on leg ${o.option.changed_legs.map((i) => i + 1).join(", ")}`);
      if (!meta.length) meta.push("alternative");
      return el("button", { type: "button", class: "route-opt", role: "radio", "aria-checked": String(k === state.optionIndex),
        title: `Use route ${optionLabel(o, k)}`, onclick: () => guard(selectOption)(k) },
        el("span", { class: "opt-badge", textContent: optionLabel(o, k) }),
        el("span", { class: "opt-main" },
          el("b", { textContent: `${fmtTime(s.duration_s)} · ${fmtDist(s.distance_m)}` }),
          el("span", { textContent: meta.join(" · ") })),
        el("span", { class: "opt-delta", textContent: k ? `${dt >= 0 ? "+" : "−"}${fmtTime(Math.abs(dt))}` : "" }));
    }));
}
function renderResult(box, res) {
  const s = res.summary;
  const intervalSel = el("select", { "aria-label": "GPX point interval" },
    ...[0.5, 1, 2, 5, 10].map((v) => el("option", { value: v, textContent: `GPX every ${v}s`, selected: v === 1 })));
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
  const exportBtn = el("button", { disabled: res.exportable === false,
    title: res.exportable === false ? "Google routes can't be exported (Google's terms restrict storing route data)." : "",
    onclick: () => { window.location.href = `/api/gpx/export/${res.id}?interval=${intervalSel.value || 1}`; } },
    svgIcon("download"), "Download GPX");
  const options = box.id === "route-result" ? routeOptionsList() : null;
  box.replaceChildren(
    ...(options ? [options] : []),
    el("div", { class: "summary" },
      el("span", {}, "Distance", el("b", { textContent: fmtDist(s.distance_m) })),
      el("span", {}, "Duration", el("b", { textContent: fmtTime(s.duration_s) })),
      el("span", {}, "Average", el("b", { textContent: `${s.avg_speed_kmh} km/h` })),
      el("span", {}, "Top speed", el("b", { textContent: `${s.max_speed_kmh} km/h` }))),
    ...extra,
    ...(s.warnings || []).map((w) => el("p", { class: "warn", textContent: w })),
    chartCanvas(res.preview),
    el("div", { class: "btn-row" },
      el("button", { "data-action": "preview", onclick: () => togglePreview(res) }, svgIcon("preview"), "Preview"),
      el("button", { "data-action": "fit", onclick: fitRoute }, svgIcon("fit"), "Fit on map")),
    el("div", { class: "btn-row" }, intervalSel, exportBtn),
  );
  decorateShortcutHints(box);
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
function togglePreview(res) {
  res = res || state.built;
  if (state.preview) { stopPreview(); return; }
  if (!res) { toast("Build a route first."); return; }
  const data = res.preview;
  if (!data || data.length < 2) return;
  const mult = Math.max(1, data[data.length - 1][0] / 20);
  previewMarker = L.marker([data[0][1], data[0][2]], { icon: icon("prev-icon", "", 14), interactive: false }).addTo(map);
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
  toast(`Previewing at ${Math.round(mult)}× speed (this does not move the phone)`);
}
function stopPreview() {
  if (state.preview) cancelAnimationFrame(state.preview.raf);
  state.preview = null;
  if (previewMarker) { map.removeLayer(previewMarker); previewMarker = null; }
}
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
  $("sec-checkpoints").open = true;
  toast(`Generated ${n} checkpoints. Press Build route.`);
};

// ------------------------------------------------------------------ GPX import
const drop = $("gpx-drop");
drop.addEventListener("click", () => $("gpx-file").click());
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("gpx-file").click(); } });
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "dragend"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("over")));
drop.addEventListener("drop", (e) => {
  e.preventDefault(); e.stopPropagation();
  drop.classList.remove("over");
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) uploadGpx(f);
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f && /\.gpx$/i.test(f.name)) { openTab("gpx"); uploadGpx(f); }
});
$("gpx-file").onchange = (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (f) uploadGpx(f);
};
function gpxError(msg) { $("gpx-error").textContent = msg || ""; $("gpx-error").hidden = !msg; }
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
    $("gpx-drop-title").textContent = state.gpx.filename;
    $("gpx-drop-sub").textContent = `${fmtSize(state.gpx.size || 0)} · ${state.gpx.tracks.length} item${state.gpx.tracks.length > 1 ? "s" : ""} — click or drop to replace`;
    $("gpx-sub").textContent = state.gpx.filename;
    drop.classList.add("loaded");
  } else {
    $("gpx-drop-title").textContent = "Drop a .gpx file here";
    $("gpx-drop-sub").textContent = "or click to choose one";
    $("gpx-sub").textContent = "";
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
  state.options = [res];
  state.optionIndex = 0;
  routeLayer.clearLayers();
  drawRoute({ fit: true });
  renderResult($("gpx-result"), res);
  await api(`/api/player/load/${res.id}`, { body: {} });
  state.loaded = "gpx";
  clearTrail();
  await poll();
});
$("btn-gpx-remove").onclick = guard(async () => {
  state.gpx = null;
  gpxLayer.clearLayers();
  $("gpx-panel").hidden = true;
  $("gpx-result").replaceChildren();
  $("speed-legend").hidden = true;
  gpxError("");
  renderGpxDrop();
  if (state.loaded === "gpx") {
    state.built = null;
    const p = state.status && state.status.player;
    if (p && ["playing", "paused"].includes(p.state)) await api("/api/player/stop", { body: {} }).catch(() => {});
    await unloadPlayer();
  }
});
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
async function playOrPause() {
  const st = state.status && state.status.player;
  if (!st) return;
  if (st.state === "playing") { await api("/api/player/pause", { body: {} }); await poll(); return; }
  if (!st.name && !st.duration) { toast("Build a route or load a GPX track first."); return; }
  if (!state.status.device) { toast("Connect a device (or the Simulator) first.", true); return; }
  if (st.state !== "paused" && st.t === 0) clearTrail();
  await api(st.state === "paused" ? "/api/player/resume" : "/api/player/play", { body: {} });
  await poll();
}
async function stopPlayback() { await api("/api/player/stop", { body: {} }); await poll(); }
playerBtns.play.onclick = guard(playOrPause);
playerBtns.pause.onclick = guard(playOrPause);
playerBtns.stop.onclick = guard(stopPlayback);
const seek = $("seek");
seek.addEventListener("input", () => { state.seeking = true; $("player-time").textContent = `${fmtTime(+seek.value)} / ${fmtTime(+seek.max)}`; });
seek.addEventListener("change", guard(async () => {
  try { await api("/api/player-seek", { body: { t: +seek.value } }); } finally { state.seeking = false; await poll(); }
}));
const sendOptions = guard(async () => {
  await api("/api/player-options", { body: {
    multiplier: +$("multiplier").value, loop: $("loop").value,
    jitter_m: Math.min(100, Math.max(0, +$("jitter").value || 0)), tick_s: Math.min(10, Math.max(0.2, +$("tick").value || 1)),
  } });
  saveSettingsSoon();
});
["multiplier", "loop", "jitter", "tick"].forEach((id) => $(id).addEventListener("change", sendOptions));
function clearTrail() { if (trailLine) trailLine.setLatLngs([]); }
function renderPlayer(st) {
  const p = st.player;
  const has = p.duration > 0 || !!p.name;
  $("player").classList.toggle("empty", !has && p.state !== "joystick");
  $("player-name").textContent = p.state === "joystick" ? "Joystick" : (p.name || "No route loaded");
  const badge = $("player-state");
  badge.textContent = p.state + (p.laps ? ` · lap ${p.laps + 1}` : "");
  badge.className = "badge " + p.state;
  const connected = !!st.device;
  playerBtns.play.disabled = !has || !connected || p.state === "playing";
  playerBtns.play.title = !connected ? "Connect a device (or the Simulator) first" : !has ? "Build a route or load a GPX track first" : "";
  playerBtns.play.querySelector(".lbl").textContent = p.state === "paused" ? "Resume" : "Play";
  playerBtns.pause.disabled = p.state !== "playing";
  playerBtns.stop.disabled = !["playing", "paused", "joystick"].includes(p.state);
  seek.disabled = !has;
  seek.max = p.duration;
  if (!state.seeking) { seek.value = p.t; $("player-time").textContent = `${fmtTime(p.t)} / ${fmtTime(p.duration)}`; }
  $("player-dist").textContent = `${fmtDist(p.distance_m)} / ${fmtDist(p.total_distance_m)}`;
  $("player-speed").textContent = p.position ? `${p.position.speed_kmh.toFixed(1)} km/h` : "—";
  if (p.state === "error" && p.error && state.lastError !== p.error) toast(p.error, true);
  state.lastError = p.error;
  if (p.position) {
    const ll = [p.position.lat, p.position.lon];
    if (!deviceMarker) {
      deviceMarker = L.marker(ll, { icon: icon("dev-icon", "", 18), zIndexOffset: 1000, title: "Spoofed location" }).addTo(map);
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
const typing = () => ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName) || !!document.querySelector("dialog[open]");
function joystickKeydown(e) {
  if (state.tab !== "joystick" || !KEYS[e.code] || typing()) return false;
  e.preventDefault();
  if (!held.has(e.code)) {
    held.add(e.code);
    const [x, y] = keyVector();
    if (x || y) joySend(true, ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360);
  }
  return true;
}
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

// ------------------------------------------------------------------ keyboard shortcuts (single keys, customizable)
const ACTIONS = [
  ["teleport", "T", "Teleport to the picked point", () => teleport()],
  ["build", "B", "Build route", () => buildRoute()],
  ["playpause", "P", "Play / pause on the device", () => playOrPause()],
  ["stop", "X", "Stop playback", () => stopPlayback()],
  ["clear", "C", "Stop spoofing (back to real location)", () => stopSpoofing()],
  ["connect", "K", "Connect / disconnect", () => (state.status && state.status.device ? disconnectNow() : connectNow())],
  ["locate", "R", "Show my real location", () => showRealLocation(false)],
  ["fit", "F", "Fit the route on the map", () => fitRoute()],
  ["preview", "V", "Preview the route on the map", () => togglePreview()],
  ["gpx", "G", "Open a GPX file", () => { openTab("gpx"); $("gpx-file").click(); }],
  ["link", "L", "Paste a Google Maps link", () => { openTab("teleport"); $("sec-find").open = true; $("gmaps-link").focus(); }],
  ["search", "Q", "Search for a place", () => { openTab("teleport"); $("sec-find").open = true; $("search").focus(); }],
  ["sidebar", "M", "Hide / show the side menu", () => setSidebarHidden(!document.body.classList.contains("sidebar-hidden"))],
  ["settings", "O", "Open settings", () => openSettings("appearance")],
  ["help", "H", "Show keyboard shortcuts", () => openShortcutHelp()],
  ["tab-teleport", "1", "Teleport tab", () => openTab("teleport")],
  ["tab-route", "2", "Route tab", () => openTab("route")],
  ["tab-gpx", "3", "GPX tab", () => openTab("gpx")],
  ["tab-joystick", "4", "Joystick tab", () => openTab("joystick")],
  ["tab-saved", "5", "Saved tab", () => openTab("saved")],
];
const actionById = Object.fromEntries(ACTIONS.map((a) => [a[0], a]));
function shortcutMap() {
  const custom = settings().shortcuts || {};
  return Object.fromEntries(ACTIONS.map(([id, def]) => [id, (custom[id] || def).toUpperCase()]));
}
function keyFor(id) { return shortcutMap()[id]; }
document.addEventListener("keydown", (e) => {
  if (listeningFor) return;
  if (joystickKeydown(e)) return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || typing()) return;
  if (e.key === "Escape") { hideTip(); return; }
  const k = e.key.length === 1 ? e.key.toUpperCase() : "";
  if (!/^[A-Z0-9]$/.test(k)) return;
  const m = shortcutMap();
  const id = Object.keys(m).find((a) => m[a] === k);
  if (!id) return;
  e.preventDefault();
  guard(actionById[id][3])();
});
function decorateShortcutHints(root = document) {
  const m = shortcutMap();
  root.querySelectorAll("[data-action]").forEach((b) => {
    const k = m[b.dataset.action];
    let hint = b.querySelector(".kbd");
    if (!k) { if (hint) hint.remove(); return; }
    if (!hint) { hint = el("span", { class: "kbd" }); b.append(hint); }
    hint.textContent = k;
    b.title = `${(b.title || "").replace(/\s*\(shortcut .\)$/, "")} (shortcut ${k})`.trim();
  });
}
let listeningFor = null;
function renderShortcutEditor() {
  const m = shortcutMap();
  const list = $("shortcut-list");
  list.replaceChildren();
  for (const [id, , label] of ACTIONS) {
    const cap = el("button", { type: "button", class: "keycap", textContent: m[id], "aria-label": `Change the shortcut for ${label}` });
    cap.onclick = () => {
      document.querySelectorAll(".keycap.listening").forEach((c) => c.classList.remove("listening"));
      listeningFor = id;
      cap.classList.add("listening");
      cap.textContent = "…";
    };
    list.append(el("span", { textContent: label }), cap);
  }
}
document.addEventListener("keydown", (e) => {
  if (!listeningFor) return;
  e.preventDefault();
  e.stopPropagation();
  const id = listeningFor;
  listeningFor = null;
  if (e.key === "Escape") { renderShortcutEditor(); return; }
  const k = e.key.length === 1 ? e.key.toUpperCase() : "";
  if (!/^[A-Z0-9]$/.test(k)) { toast("Use a single letter (A–Z) or number (0–9).", true); renderShortcutEditor(); return; }
  const m = shortcutMap();
  const clash = Object.keys(m).find((a) => a !== id && m[a] === k);
  const custom = { ...(settings().shortcuts || {}) };
  if (clash) { custom[clash] = m[id]; toast(`Swapped with “${actionById[clash][2]}”, which now uses ${m[id]}.`); }
  custom[id] = k;
  if ("WASD".includes(k)) toast(`${k} also moves the joystick while the Joystick tab is open.`);
  settings().shortcuts = custom;
  saveSettingsSoon();
  renderShortcutEditor();
  decorateShortcutHints();
}, true);
$("btn-shortcuts-reset").onclick = () => { settings().shortcuts = {}; saveSettingsSoon(); renderShortcutEditor(); decorateShortcutHints(); toast("Default shortcuts restored."); };
function openShortcutHelp() {
  const m = shortcutMap();
  $("shortcut-help-list").replaceChildren(...ACTIONS.flatMap(([id, , label]) => [el("span", { textContent: label }), el("span", { class: "kbd", textContent: m[id] })]),
    el("span", { textContent: "Move the joystick (Joystick tab)" }), el("span", { class: "kbd", textContent: "WASD" }));
  $("shortcut-help").showModal();
}
$("btn-shortcuts").onclick = openShortcutHelp;
$("btn-shortcut-help-close").onclick = () => $("shortcut-help").close();
$("btn-shortcut-customize").onclick = () => { $("shortcut-help").close(); openSettings("keys"); };

// ------------------------------------------------------------------ saved data
async function loadStore() {
  try { state.store = await api("/api/store"); } catch (e) { toast(e.message, true); }
  applySettings(settings());
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
    state.store.settings = { ...settings(), ...collectSettings() };
    await saveStore();
  }), 700);
}
const SETTING_IDS = ["driver", "provider", "default-mode", "default-speed", "accel", "decel", "alt-count", "start-rest", "stop-end",
  "road-aware", "road-data", "corner-slow", "match-eta", "speed-factor", "multiplier", "loop", "jitter", "tick", "joy-speed", "gpx-speed"];
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
  $("pref-night-map").checked = !!s.night_map;
  $("pref-compact").checked = !!s.compact;
  $("pref-channel").value = s.update_channel === "dev" ? "dev" : "stable";
  if (s.sidebar_w) setSidebarWidth(s.sidebar_w, false);
  applyAppearance();
  applySections();
  decorateShortcutHints();
  renderRouteSettingsSub();
}
SETTING_IDS.forEach((id) => $(id).addEventListener("change", saveSettingsSoon));
map.on("moveend", saveSettingsSoon);
function renderSaved() {
  const fl = $("fav-list");
  fl.replaceChildren();
  $("fav-count").textContent = state.store.favorites.length ? String(state.store.favorites.length) : "";
  if (!state.store.favorites.length) fl.append(el("li", { class: "hint", textContent: "Nothing saved yet. Pick a point and press Save." }));
  state.store.favorites.forEach((f, i) => {
    fl.append(el("li", {},
      el("span", { textContent: f.name, title: fmtLL(f.lat, f.lon) }),
      el("button", { textContent: "Show", onclick: () => { openTab("teleport"); setPicked(f.lat, f.lon); } }),
      el("button", { textContent: "Teleport", onclick: guard(async () => { setPicked(f.lat, f.lon); await teleport(); }) }),
      el("button", { class: "x", title: "Delete", "aria-label": `Delete ${f.name}`, onclick: guard(async () => {
        const [removed] = state.store.favorites.splice(i, 1);
        await saveStore();
        toast(`Deleted “${removed.name}”.`, false, { label: "Undo", run: guard(async () => { state.store.favorites.splice(i, 0, removed); await saveStore(); }) });
      }) }, svgIcon("x")),
    ));
  });
  const rl = $("route-list");
  rl.replaceChildren();
  $("route-count").textContent = state.store.routes.length ? String(state.store.routes.length) : "";
  if (!state.store.routes.length) rl.append(el("li", { class: "hint", textContent: "Nothing saved yet." }));
  state.store.routes.forEach((r, i) => {
    rl.append(el("li", {},
      el("span", { textContent: `${r.name} (${(r.waypoints || []).length})`, title: r.name }),
      el("button", { textContent: "Load", onclick: () => loadRoute(r) }),
      el("span"),
      el("button", { class: "x", title: "Delete", "aria-label": `Delete ${r.name}`, onclick: guard(async () => {
        const [removed] = state.store.routes.splice(i, 1);
        await saveStore();
        toast(`Deleted “${removed.name}”.`, false, { label: "Undo", run: guard(async () => { state.store.routes.splice(i, 0, removed); await saveStore(); }) });
      }) }, svgIcon("x")),
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
  const data = { ...state.store, settings: { ...settings() } };
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
    settings: settings(),
  };
  await saveStore();
  toast("Imported");
});

// ------------------------------------------------------------------ settings dialog
const settingsDlg = $("settings-dialog");
function openSettings(pane = "appearance") {
  $("key-status").textContent = "";
  document.querySelectorAll("#settings-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.pane === pane));
  document.querySelectorAll("#settings-dialog .pane").forEach((p) => (p.hidden = p.dataset.pane !== pane));
  if (pane === "keys") renderShortcutEditor();
  if (!settingsDlg.open) settingsDlg.showModal();
}
document.querySelectorAll("#settings-tabs button").forEach((b) => (b.onclick = () => openSettings(b.dataset.pane)));
$("btn-settings").onclick = () => openSettings("appearance");
$("btn-key-show").onclick = () => {
  const k = $("google-key");
  k.type = k.type === "password" ? "text" : "password";
  $("btn-key-show").textContent = k.type === "password" ? "Show" : "Hide";
};
async function saveKey() {
  const key = $("google-key").value.trim();
  if ((settings().google_api_key || "") === key) return;
  settings().google_api_key = key;
  await saveStore();
  state.google.session = null;
  await refreshGoogleStatus();
}
$("btn-key-test").onclick = busy($("btn-key-test"), "Testing…", async () => {
  await saveKey();
  if (!state.google.configured) { $("key-status").textContent = "No key entered."; return; }
  try { await ensureGoogleLayer(); $("key-status").textContent = "The Map Tiles API works with this key."; }
  catch (e) { $("key-status").textContent = e.message; }
});
$("pref-channel").onchange = () => { settings().update_channel = $("pref-channel").value; saveSettingsSoon(); };
settingsDlg.addEventListener("close", () => { listeningFor = null; guard(saveKey)(); });
$("btn-tutorial-again").onclick = () => { settingsDlg.close(); openTutorial(0); };
async function refreshGoogleStatus() {
  try { state.google.configured = (await api("/api/google/status")).configured; } catch (_) { state.google.configured = false; }
  const opt = $("provider").querySelector('option[value="google"]');
  opt.textContent = state.google.configured ? "Google Maps" : "Google Maps (add an API key in Settings)";
  if (!state.google.configured && $("provider").value === "google") $("provider").value = "osrm";
}

// ------------------------------------------------------------------ first-run tutorial
const REPO = "https://github.com/YK3D/iPhone-location-spoofer/blob/main";
const TUTORIAL = [
  { title: "Welcome", body: [
      "This app sets your iPhone's location from this computer over a USB cable: jump to any place, follow routes at realistic speeds, or replay GPX files.",
      "Use it only where it is allowed, for example testing your own apps. Games and dating, school or work apps often ban fake locations and can suspend accounts.",
      ["By continuing you agree to the ", ["Terms of Use", `${REPO}/TERMS.md`], ". The ", ["Privacy Policy", `${REPO}/PRIVACY.md`], " explains which online map services the app contacts. Nothing is collected by the app's authors."],
      "Want to look around first? Pick “Simulator (no iPhone)” as the connection and skip ahead." ] },
  { title: "1 · Install Apple's device software", body: [
      "Windows needs Apple's iPhone drivers. Open the Microsoft Store, search for “Apple Devices” and install it (iTunes also works).",
      "Leave it installed; it runs in the background while you use this app.",
      "macOS: nothing to install. Linux: install the usbmuxd package." ] },
  { title: "2 · Connect and trust", body: [
      "Plug the iPhone in with a cable and unlock it.",
      "When the phone asks “Trust This Computer?”, tap Trust and enter your passcode.",
      "Then press the refresh button next to the Device list: your iPhone should appear in it." ],
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
      "Route: click checkpoints, choose roads, footpaths or sea lanes, set speeds, Build route, then Play. The line's colour shows the speed.",
      "Every section can be folded away, the side menu can be resized by dragging its edge, and Settings has themes and keyboard shortcuts (press H to see them).",
      "When you're done, press “Stop spoofing — back to real location”." ] },
];
let tutIndex = 0;
const tutDlg = $("tutorial");
function openTutorial(i = 0) { tutIndex = i; renderTutorial(); if (!tutDlg.open) tutDlg.showModal(); }
function richParagraph(p) {
  if (typeof p === "string") return el("p", { textContent: p });
  return el("p", {}, ...p.map((part) => (Array.isArray(part) ? el("a", { href: part[1], target: "_blank", rel: "noopener", textContent: part[0] }) : part)));
}
function renderTutorial() {
  const step = TUTORIAL[tutIndex];
  $("tut-step").textContent = `Step ${tutIndex + 1} of ${TUTORIAL.length}`;
  $("tut-bar").style.width = `${((tutIndex + 1) / TUTORIAL.length) * 100}%`;
  $("tut-title").textContent = step.title;
  $("tut-body").replaceChildren(...step.body.map(richParagraph));
  const act = $("tut-action");
  act.replaceChildren();
  if (step.action) {
    const b = el("button", { type: "button", textContent: step.action.label });
    b.onclick = busy(b, "Working…", step.action.run);
    act.append(b);
  }
  act.hidden = !step.action;
  $("tut-back").disabled = tutIndex === 0;
  $("tut-next").textContent = tutIndex === TUTORIAL.length - 1 ? "Start using the app" : "Next";
}
function finishTutorial() {
  tutDlg.close();
  settings().tutorial_done = true;
  saveStore().catch(() => {});
}
$("tut-back").onclick = () => { if (tutIndex > 0) { tutIndex--; renderTutorial(); } };
$("tut-next").onclick = () => { if (tutIndex < TUTORIAL.length - 1) { tutIndex++; renderTutorial(); } else finishTutorial(); };
$("tut-skip").onclick = finishTutorial;
tutDlg.addEventListener("cancel", (e) => { e.preventDefault(); finishTutorial(); });
$("btn-tutorial").onclick = () => openTutorial(0);

// ------------------------------------------------------------------ updates
const checkUpdates = async () => {
  const u = await api("/api/update/check", { body: {} });
  if (!u.enabled) toast("This copy is updated by its installer or from source (git pull).");
  else if (u.state === "up_to_date") toast(`You have the latest version (${u.current}).`);
  else if (u.state === "error") toast(`Update check failed: ${u.error}`, true);
  await poll();
};
$("btn-update-check").onclick = busy($("btn-update-check"), "Checking…", checkUpdates);
$("btn-update-check2").onclick = busy($("btn-update-check2"), "Checking…", checkUpdates);
$("btn-update-install").onclick = guard(async () => {
  await api("/api/update/install", { body: {} });
  state.restarting = true;
  $("update-text").textContent = "Restarting with the new version… this page reloads by itself.";
  $("btn-update-install").hidden = true;
});
$("btn-tunneld").onclick = busy($("btn-tunneld"), "Starting…", async () => toast((await api("/api/tunneld/start", { body: {} })).message));
function renderUpdate(st) {
  const u = st.update;
  if (state.restarting) {
    if (state.bootVersion && st.version !== state.bootVersion) location.reload();
    return;
  }
  const show = u && u.enabled && ["downloading", "ready", "available"].includes(u.state);
  $("update-banner").hidden = !show;
  if (!show) return;
  $("btn-update-install").hidden = u.state !== "ready";
  $("update-text").textContent =
    u.state === "ready" ? `Version ${u.latest} is downloaded. It installs on next start, or now:`
    : u.state === "downloading" ? `Downloading version ${u.latest}… ${Math.round(u.progress * 100)}%`
    : `Version ${u.latest} is available.`;
}
// Features differ between the standalone app and the browser version.
function applyFeatures(f) {
  if (!f) return;
  if (f.cli_driver === false) { const o = $("driver").querySelector('option[value="cli"]'); if (o) o.remove(); }
  if (f.tunnel_helper === false) { const b = $("btn-tunneld"); if (b) b.closest(".tool").remove(); }
}

// ------------------------------------------------------------------ status polling
let pollTimer;
async function poll() {
  clearTimeout(pollTimer);
  try {
    const st = await api("/api/status");
    state.status = st;
    $("version").textContent = `v${st.version}${st.app === "standalone" ? "" : " · browser"}`;
    document.querySelector(".brand h1").title = `Location Spoofer ${$("version").textContent}`;
    $("about-version").textContent = `Version ${st.version} (${st.app === "standalone" ? "standalone app" : "browser version"})`;
    if (!state.bootVersion) { state.bootVersion = st.version; applyFeatures(st.features); }
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
wireSections();
renderThemeGrid();
renderWaypoints();
renderGpxDrop();
decorateShortcutHints();
(async () => {
  await loadStore();
  await refreshGoogleStatus();
  await poll();
  refreshDevices(false);
  if (!settings().tutorial_done) openTutorial(0);
})();
