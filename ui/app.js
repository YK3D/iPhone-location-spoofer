/* Location Spoofer — UI shared by the standalone and browser apps. Talks to the local server at /api.
   Copyright (c) 2026 YK3D. All rights reserved. Licensed under the Location Spoofer License (LICENSE). */
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

const APPLE_DEVICES_URL = "https://apps.microsoft.com/detail/9np83lwlpz9k"; // Apple Devices in the Microsoft Store
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
async function apiStream(path, body, onProgress, signal) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
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
  const old = [...btn.childNodes].filter((n) => !(n.classList && n.classList.contains("ripple")));
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
// Wheel and trackpad zoom use SmoothWheelZoom (below) instead of Leaflet's stepped wheel zoom;
// fractional zoom levels (zoomSnap 0) let a pinch stop exactly where the fingers stop.
const map = L.map("map", { zoomControl: true, worldCopyJump: true, scrollWheelZoom: false, zoomSnap: 0 }).setView([51.505, -0.09], 13);

// Leaflet's own wheel zoom collects wheel events and then animates a whole zoom step. A trackpad
// sends dozens of small events per gesture, so the steps queue up and overlap, and the vector map
// (drawn by MapLibre, kept in step with Leaflet after each animation) jumps and flickers. This
// handler follows the gesture frame by frame instead: every frame moves the map part of the way to
// the zoom the gesture asks for, around the point under the pointer, without animations.
const SmoothWheelZoom = L.Handler.extend({
  addHooks() { L.DomEvent.on(this._map.getContainer(), "wheel", this._onWheel, this); },
  removeHooks() { L.DomEvent.off(this._map.getContainer(), "wheel", this._onWheel, this); },
  _onWheel(e) {
    L.DomEvent.preventDefault(e); // also stops ctrl+wheel / pinch from zooming the whole page
    const m = this._map;
    const px = e.deltaY * (e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? 400 : 1);
    // A pinch arrives as ctrl+wheel with small steps; two-finger scrolls and mouse wheels zoom slower.
    const dz = Math.max(-1.5, Math.min(1.5, -px * (e.ctrlKey ? 0.012 : 0.006)));
    if (!this._frame) {
      m._stop(); // ends a pan animation or a running zoom
      this._target = m.getZoom();
    }
    this._target = Math.max(m.getMinZoom(), Math.min(m.getMaxZoom(), this._target + dz));
    this._anchor = m.mouseEventToContainerPoint(e);
    this._lastEvent = performance.now();
    if (!this._frame) this._frame = L.Util.requestAnimFrame(this._step, this);
  },
  _zoomAround(zoom, data) {
    const m = this._map;
    const scale = m.getZoomScale(zoom, m.getZoom());
    const half = m.getSize().divideBy(2);
    const center = m.containerPointToLatLng(half.add(this._anchor.subtract(half).multiplyBy(1 - 1 / scale)));
    m._move(center, zoom, data);
  },
  _step() {
    const m = this._map;
    const z = m.getZoom(), diff = this._target - z;
    if (Math.abs(diff) > 0.002) {
      // pinch-like: tiles keep their current level, scaled, until the gesture ends
      this._zoomAround(z + diff * 0.35, { pinch: true });
      this._frame = L.Util.requestAnimFrame(this._step, this);
    } else if (performance.now() - this._lastEvent < 120) {
      this._frame = L.Util.requestAnimFrame(this._step, this); // the fingers may still be moving
    } else {
      this._zoomAround(this._target); // settle: tile layers load the new level
      this._frame = null;
      m._moveEnd(true);
    }
  },
});
map.addHandler("smoothWheelZoom", SmoothWheelZoom);
map.smoothWheelZoom.enable();

// Base maps. OpenFreeMap is drawn from vector data (MapLibre, loaded on first use), so it has a real
// dark style and stays sharp at street level; free, no key, commercial use allowed. The raster maps
// are the fallback: OpenStreetMap and the topographic map are shown inverted in dark mode (the
// "osm-tiles" class), satellite keeps its own colours.
let mapLibreLoading = null;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(s);
  });
}
function loadMapLibre() {
  if (!mapLibreLoading) {
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = "/static/vendor/maplibre/maplibre-gl.css";
    document.head.append(css);
    mapLibreLoading = loadScript("/static/vendor/maplibre/maplibre-gl.js")
      .then(() => loadScript("/static/vendor/maplibre/leaflet-maplibre-gl.js"));
    mapLibreLoading.catch(() => { mapLibreLoading = null; });
  }
  return mapLibreLoading;
}
function webglAvailable() {
  try {
    const gl = document.createElement("canvas").getContext("webgl2") || document.createElement("canvas").getContext("webgl");
    if (!gl) return false;
    const lose = gl.getExtension("WEBGL_lose_context");
    if (lose) lose.loseContext(); // only a probe: give the context back straight away
    return true;
  } catch (_) { return false; }
}
// OpenFreeMap's dark style is near-black with barely visible water and roads; these colours keep its
// calm look but make water, parks, buildings, the road hierarchy and labels readable at a glance.
// (Layers the style no longer has are skipped.)
const DARK_MAP_PAINT = [
  ["background", "background-color", "#14161a"],
  ["water", "fill-color", "#0f2236"], ["waterway", "line-color", "#173250"],
  ["water_name", "text-color", "#6d8fb3"], ["water_name", "text-halo-color", "#0b1520"],
  ["landuse_park", "fill-color", "#15231b"], ["landcover_wood", "fill-color", "#15231b"],
  ["landuse_residential", "fill-color", "#1a1c21"],
  ["building", "fill-color", "#1e2126"], ["building", "fill-outline-color", "#2a2e35"],
  ["road_area_pier", "fill-color", "#14161a"], ["road_pier", "line-color", "#14161a"],
  ["highway_path", "line-color", "#2e333a"],
  ["highway_minor", "line-color", "#32363e"], ["highway_minor", "line-opacity", 1],
  ["highway_major_casing", "line-color", "#2a2e35"], ["highway_major_inner", "line-color", "#4a505a"],
  ["highway_major_subtle", "line-color", "#3d424a"],
  ["highway_motorway_casing", "line-color", "#2e3138"], ["highway_motorway_inner", "line-color", "#6b6250"],
  ["highway_motorway_subtle", "line-color", "#4a4538"],
  ["railway", "line-color", "#3b3e45"], ["railway_minor", "line-color", "#33363c"], ["railway_transit", "line-color", "#33363c"],
  ["railway_dashline", "line-color", "#14161a"], ["railway_minor_dashline", "line-color", "#14161a"], ["railway_transit_dashline", "line-color", "#14161a"],
  ["highway_name_other", "text-color", "#949aa3"], ["highway_name_other", "text-halo-color", "#14161a"],
  ["highway_name_motorway", "text-color", "#a9a294"],
  ...["place_other", "place_suburb", "place_village", "place_town", "place_city", "place_city_large", "place_state",
    "place_country_other", "place_country_minor", "place_country_major"].flatMap((id) => [
    [id, "text-color", "#b2b8c0"], [id, "text-halo-color", "rgba(10,11,14,.85)"]]),
];
function tuneDarkStyle(gl) {
  for (const [id, prop, value] of DARK_MAP_PAINT) {
    if (!gl.getLayer(id)) continue;
    try { gl.setPaintProperty(id, prop, value); } catch (_) { /* the style changed shape: keep its own colour */ }
  }
}
// OpenFreeMap requests go through the app's offline cache (/ofm/...): downloaded areas, styles and
// fonts then work without internet. Everything else is fetched as before.
const OFM = "https://tiles.openfreemap.org/";
function viaOfflineCache(url) {
  return url.startsWith(OFM) ? { url: `${location.origin}/ofm/${url.slice(OFM.length)}` } : undefined;
}
const VectorBaseMap = L.Layer.extend({
  options: { maxZoom: 20, minZoom: 0,
    attribution: "&copy; OpenFreeMap &copy; OpenMapTiles &copy; OpenStreetMap contributors" },
  initialize() { this._darkStyle = true; this._glLayer = null; this._active = false; },
  getAttribution() { return this.options.attribution; },
  styleUrl() { return `https://tiles.openfreemap.org/styles/${this._darkStyle ? "dark" : "liberty"}`; },
  onAdd(m) {
    this._active = true;
    // Everything here runs after start-up (the script loads asynchronously), so creating a WebGL
    // context never holds up the first paint, and a fallback never switches layers inside onAdd.
    loadMapLibre().then(() => {
      if (!this._active || !this._map || this._glLayer) return;
      if (!webglAvailable()) { mapProviderFailed("this computer's graphics don't support it (WebGL is off)"); return; }
      try {
        this._glLayer = L.maplibreGL({ style: this.styleUrl(), attributionControl: false, transformRequest: viaOfflineCache }).addTo(m);
      } catch (_) {
        this._glLayer = null;
        mapProviderFailed("this computer's graphics don't support it");
        return;
      }
      const gl = this._glLayer.getMaplibreMap();
      // the style can't be fetched (offline, service down) or tiles keep failing: fall back, once
      let styleLoaded = false, errors = 0;
      gl.on("style.load", () => { styleLoaded = true; if (this._darkStyle) tuneDarkStyle(gl); });
      gl.on("error", () => {
        errors += 1;
        if (!styleLoaded || errors >= 8) mapProviderFailed("it could not be reached");
      });
    }).catch(() => mapProviderFailed("its map component could not be loaded"));
  },
  onRemove(m) {
    this._active = false;
    if (this._glLayer && m.hasLayer(this._glLayer)) m.removeLayer(this._glLayer); // also frees the WebGL map
    this._glLayer = null;
  },
  setDark(dark) {
    if (dark === this._darkStyle) return;
    this._darkStyle = dark;
    const gl = this._glLayer && this._glLayer.getMaplibreMap();
    if (gl) gl.setStyle(this.styleUrl(), { diff: false }); // a full load, so "style.load" fires (and tunes the dark one)
  },
});
const MAP_PROVIDERS = {
  openfreemap: { label: "OpenFreeMap", layer: new VectorBaseMap() },
  osm: { label: "OpenStreetMap", layer: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap contributors", className: "osm-tiles" }) },
  topo: { label: "Topographic", layer: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxZoom: 17, attribution: "&copy; OpenStreetMap contributors, SRTM | &copy; OpenTopoMap (CC-BY-SA)", className: "osm-tiles" }) },
  satellite: { label: "Satellite", layer: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19, attribution: "Imagery &copy; Esri" }) },
};
const DEFAULT_MAP_PROVIDER = "openfreemap";
const baseLayers = Object.fromEntries(Object.values(MAP_PROVIDERS).map((p) => [p.label, p.layer]));
const providerOf = (layer) => Object.keys(MAP_PROVIDERS).find((k) => MAP_PROVIDERS[k].layer === layer);
const savedProvider = (s) => (MAP_PROVIDERS[s.map_provider] ? s.map_provider : DEFAULT_MAP_PROVIDER);
// the first paint uses the provider remembered from the last start, before the settings arrive
let startProvider = DEFAULT_MAP_PROVIDER;
try { startProvider = savedProvider(JSON.parse(localStorage.getItem("ls-appearance") || "{}")); } catch (_) { /* storage blocked */ }
MAP_PROVIDERS[startProvider].layer.addTo(map);
// The map menu (top right): pick the map, its theme (dark, light, or matching the app) and open
// offline maps. Replaces Leaflet's plain layer list; like it, it reports "baselayerchange" when
// one of its maps is shown, whoever switched it.
const MAP_PREVIEWS = {
  openfreemap: '<rect width="56" height="38" fill="#1b1f25"/><path d="M-2 26 20 14 58 30M14-2 22 40M36-2 32 40" stroke="#4a515c" stroke-width="2.4" fill="none"/><path d="M-2 9 58 4" stroke="#7a6a48" stroke-width="3" fill="none"/><circle cx="40" cy="20" r="5" fill="#15301f"/><path d="M0 34h56v4H0z" fill="#10263a"/>',
  osm: '<rect width="56" height="38" fill="#f2efe9"/><path d="M-2 26 20 14 58 30M14-2 22 40M36-2 32 40" stroke="#fff" stroke-width="3" fill="none"/><path d="M-2 9 58 4" stroke="#f7c66b" stroke-width="3.2" fill="none"/><circle cx="40" cy="20" r="5" fill="#c8e6b9"/><path d="M0 33h56v5H0z" fill="#aad3df"/>',
  topo: '<rect width="56" height="38" fill="#e9eedc"/><g fill="none" stroke="#b8a17a" stroke-width="1"><path d="M6 30c8-14 22-20 40-14"/><path d="M12 32c6-9 18-13 30-9"/><path d="M18 34c4-5 11-7 18-5"/><path d="M2 22c10-16 30-22 52-14"/></g><path d="M-2 12 58 18" stroke="#d64a3a" stroke-width="1.6" fill="none"/>',
  satellite: '<rect width="56" height="38" fill="#3c4a2c"/><path d="M0 0h22l6 14-10 10H0z" fill="#566b3a"/><path d="M30 0h26v16l-12 4-10-8z" fill="#7a7448"/><path d="M0 28l20-6 14 8 22-6v14H0z" fill="#2c3a24"/><path d="M-2 20 58 8" stroke="#b9b09a" stroke-width="1.4" fill="none"/>',
  google: '<rect width="56" height="38" fill="#e8eaed"/><path d="M-2 24 58 12M18-2 26 40" stroke="#fff" stroke-width="3.4" fill="none"/><path d="M-2 6 58 30" stroke="#fdd663" stroke-width="3" fill="none"/><path d="M40 34h16v4H40z" fill="#9cc0f9"/>',
};
const MapSwitcher = L.Control.extend({
  options: { position: "topright" },
  initialize(layers) { this._layers = []; for (const [name, layer] of Object.entries(layers)) this.addBaseLayer(layer, name); },
  onAdd(m) {
    const box = L.DomUtil.create("div", "map-switch leaflet-control");
    this._btn = el("button", { type: "button", class: "map-switch-btn", title: "Map and map theme", "aria-label": "Map and map theme",
      "aria-expanded": "false", onclick: () => this.toggle() }, svgIcon("layers"));
    this._panel = el("div", { class: "map-switch-panel", hidden: true, role: "dialog", "aria-label": "Map" });
    box.append(this._btn, this._panel);
    L.DomEvent.disableClickPropagation(box);
    L.DomEvent.disableScrollPropagation(box);
    this._onDoc = (e) => { if (!box.contains(e.target)) this.toggle(false); };
    this._onKey = (e) => { if (e.key === "Escape") { this.toggle(false); this._btn.focus(); } };
    m.on("layeradd", (e) => {
      const entry = this._layers.find((l) => l.layer === e.layer);
      if (entry) { m.fire("baselayerchange", { layer: entry.layer, name: entry.name }); this.refresh(); }
    });
    return box;
  },
  addBaseLayer(layer, name) { if (!this._layers.some((l) => l.layer === layer)) this._layers.push({ layer, name }); this.refresh(); return this; },
  removeLayer(layer) { this._layers = this._layers.filter((l) => l.layer !== layer); this.refresh(); return this; },
  toggle(open = this._panel.hidden) {
    if (open === !this._panel.hidden) return;
    if (open) {
      this._panel.hidden = false;
      this.refresh();
      flash(this._panel, "pop-in");
      document.addEventListener("pointerdown", this._onDoc, true);
      document.addEventListener("keydown", this._onKey);
    } else {
      this._panel.hidden = true;
      document.removeEventListener("pointerdown", this._onDoc, true);
      document.removeEventListener("keydown", this._onKey);
    }
    this._btn.setAttribute("aria-expanded", String(open));
  },
  refresh() {
    if (!this._panel || this._panel.hidden) return;
    const current = this._layers.find((l) => this._map && this._map.hasLayer(l.layer));
    const cards = this._layers.map(({ layer, name }) => {
      const id = providerOf(layer) || "google";
      const pic = document.createElementNS(SVG_NS, "svg");
      pic.setAttribute("viewBox", "0 0 56 38");
      pic.innerHTML = MAP_PREVIEWS[id] || "";
      return el("button", { type: "button", class: "map-card" + (current && current.layer === layer ? " active" : ""),
        "aria-pressed": String(!!current && current.layer === layer), onclick: () => chooseBaseMap(id) },
        pic, el("span", { textContent: name }));
    });
    const mt = mapTheme(settings());
    const themeBtn = (value, icon, label) => el("button", { type: "button", class: mt === value ? "active" : "", "aria-pressed": String(mt === value),
      onclick: () => { settings().map_theme = value; applyAppearance(); saveSettingsSoon(); } }, svgIcon(icon), el("span", { textContent: label }));
    const google = current && state.google.layer && current.layer === state.google.layer;
    this._panel.replaceChildren(
      el("div", { class: "map-switch-title", textContent: "Map" }),
      el("div", { class: "map-cards" }, ...cards),
      el("div", { class: "map-switch-title", textContent: "Map theme" }),
      el("div", { class: "seg map-theme-seg" + (google || (current && providerOf(current.layer) === "satellite") ? " muted-seg" : "") },
        themeBtn("dark", "moon", "Dark"), themeBtn("light", "sun", "Light"), themeBtn("auto", "auto", "Auto")),
      el("button", { type: "button", class: "map-switch-offline", onclick: () => { this.toggle(false); openSettings("offline"); } },
        svgIcon("offline"), el("span", { textContent: "Offline maps…" })));
  },
});
const layerControl = new MapSwitcher(baseLayers).addTo(map);
L.control.scale().addTo(map);
// A map picked in the map menu: it becomes the saved choice (Google only while a Google route is shown).
function chooseBaseMap(id) {
  if (id === "google") { useGoogleBase().catch((e) => toast(e.message, true)); return; }
  if (state.google.layer && map.hasLayer(state.google.layer)) map.removeLayer(state.google.layer);
  settings().map_provider = id;
  providerWarned = false;
  applyAppearance();
  saveSettingsSoon();
}
// Shows the chosen base map (unless a Google map is on screen for a Google route).
// Switches made here (settings, fallback) are not the user's pick in the map's layer menu.
let switchingBase = false;
function applyMapProvider(id) {
  const want = MAP_PROVIDERS[id].layer;
  if (state.google.layer && map.hasLayer(state.google.layer)) return;
  if (map.hasLayer(want)) return;
  switchingBase = true;
  try {
    for (const p of Object.values(MAP_PROVIDERS)) if (p.layer !== want && map.hasLayer(p.layer)) map.removeLayer(p.layer);
    want.addTo(map);
  } finally { switchingBase = false; }
}
let providerWarned = false;
function mapProviderFailed(why) {
  if (!providerWarned) toast(`OpenFreeMap can't be shown: ${why}. Showing OpenStreetMap instead (Settings › Appearance › Map).`, true);
  providerWarned = true;
  if (map.hasLayer(MAP_PROVIDERS.openfreemap.layer)) applyMapProvider("osm");
}

// Explicit layers, bottom to top: route lines, the device trail, alternative labels, markers.
map.createPane("routeMain").style.zIndex = 410;
map.createPane("trail").style.zIndex = 420;
map.createPane("altLabels").style.zIndex = 590;
// Route lines (alternatives first, the chosen route on top) share one canvas: the chosen route is
// many short coloured pieces, which a canvas draws cheaply, and one canvas hit-tests all the lines
// (a canvas above SVG lines would swallow their clicks). Its tolerance makes the line easy to grab.
const routeRenderer = L.canvas({ pane: "routeMain", padding: 0.4, tolerance: 4 });
const trailRenderer = L.svg({ pane: "trail" });
const routeLayer = L.layerGroup().addTo(map);
const wpLineLayer = L.layerGroup().addTo(map);
const wpLayer = L.layerGroup().addTo(map);
const gpxLayer = L.layerGroup().addTo(map);
let pickMarker = null, deviceMarker = null, previewMarker = null, trailLine = null, realMarker = null, realCircle = null;
// Leaflet only centres a marker on its point when it knows the icon size (iconSize/iconAnchor);
// without them the icon's top-left corner sat on the point, half an icon off the route.
const icon = (cls, html = "", size = 14) => L.divIcon({ className: cls, html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });

let suppressClickUntil = 0; // a route-line drag ends with a click that must not add a checkpoint
map.on("click", (e) => {
  if (performance.now() < suppressClickUntil) return;
  const lon = wrapLon(e.latlng.lng);
  if (placing) { insertWaypointAt(placing.index, e.latlng.lat, lon); stopPlacement(); return; }
  if (state.tab === "route") addWaypoint(e.latlng.lat, lon);
  else setPicked(e.latlng.lat, lon, false);
});
map.on("contextmenu", guard(async (e) => {
  if (performance.now() < suppressClickUntil) return;
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
  // a map picked in the map's layer menu becomes the saved choice, like the one in Settings
  const id = providerOf(e.layer);
  if (id && !switchingBase && settings().map_provider !== id) { settings().map_provider = id; $("pref-map-provider").value = id; rememberAppearance(); saveSettingsSoon(); }
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
    b.replaceChildren(svgIcon("help"));
    b.addEventListener("mouseenter", () => showTip(b));
    b.addEventListener("focus", () => showTip(b));
    b.addEventListener("mouseleave", hideTip);
    b.addEventListener("blur", hideTip);
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); tip.hidden ? showTip(b) : hideTip(); });
  });
}
document.addEventListener("scroll", hideTip, true);

// ------------------------------------------------------------------ dropdowns
// Every <select> gets a button and an animated list. The native select stays in the page (hidden) and
// keeps the value, so the rest of the code and the change events work unchanged.
let selOpen = null; // { sel, pop, items, active }
function selectLabel(sel) {
  const lab = sel.closest("label");
  return sel.getAttribute("aria-label") || (lab ? lab.firstChild && lab.firstChild.textContent.trim() : "") || "Choose";
}
function enhanceSelect(sel) {
  if (sel._enh || sel.multiple) return;
  sel._enh = true;
  const value = el("span", { class: "select-value" });
  const btn = el("button", { type: "button", class: `select-btn ${sel.className}`.trim(), "aria-haspopup": "listbox", "aria-expanded": "false" },
    value, svgIcon("chevron", "ico select-chev"));
  btn.setAttribute("aria-label", selectLabel(sel));
  if (sel.title) btn.title = sel.title;
  sel.after(btn);
  sel.classList.add("select-native");
  sel.tabIndex = -1;
  sel.setAttribute("aria-hidden", "true");
  const sync = () => {
    const o = sel.options[sel.selectedIndex];
    value.textContent = o ? o.textContent : "";
    btn.disabled = sel.disabled;
    if (sel.title && btn.title !== sel.title) btn.title = sel.title;
  };
  // code sets .value / .selectedIndex directly: keep the button's label in step
  for (const prop of ["value", "selectedIndex"]) {
    const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
    Object.defineProperty(sel, prop, { configurable: true, get() { return d.get.call(this); }, set(v) { d.set.call(this, v); sync(); } });
  }
  new MutationObserver(sync).observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled", "title"] });
  sel.addEventListener("change", sync);
  sel.addEventListener("focus", () => btn.focus());
  btn.addEventListener("click", () => (selOpen && selOpen.sel === sel ? closeSelect() : openSelect(sel, btn)));
  btn.addEventListener("keydown", (e) => {
    if (selOpen && selOpen.sel === sel) return;
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); openSelect(sel, btn); }
  });
  sync();
}
function openSelect(sel, btn) {
  closeSelect(true);
  const opts = [...sel.options];
  const pop = el("div", { class: "select-pop", role: "listbox", tabIndex: -1 });
  const items = opts.map((o, i) => {
    const it = el("div", { class: "select-opt", role: "option", "aria-selected": String(i === sel.selectedIndex) },
      el("span", { textContent: o.textContent }), svgIcon("check", "ico select-tick"));
    if (o.disabled) it.classList.add("disabled");
    it.addEventListener("pointerenter", () => setActive(i));
    it.addEventListener("click", () => { if (!o.disabled) chooseOption(i); });
    pop.append(it);
    return it;
  });
  // A modal dialog (Settings) sits in the browser's top layer, above any z-index, and makes everything
  // outside it inert. So the list goes inside the dialog, and as a popover it joins the top layer too:
  // drawn above the dialog, never clipped by it, and still clickable.
  (sel.closest("dialog[open]") || document.body).append(pop);
  if (typeof pop.showPopover === "function") { pop.popover = "manual"; pop.showPopover(); }
  const r = btn.getBoundingClientRect();
  pop.style.minWidth = `${r.width}px`;
  const ph = Math.min(pop.scrollHeight, 300);
  const below = innerHeight - r.bottom - 8;
  const up = below < ph && r.top > below;
  pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
  pop.style.top = `${up ? r.top - ph - 4 : r.bottom + 4}px`;
  pop.style.maxHeight = `${Math.max(120, up ? r.top - 12 : below)}px`;
  pop.classList.toggle("up", up);
  btn.setAttribute("aria-expanded", "true");
  btn.classList.add("open");
  selOpen = { sel, btn, pop, items, active: -1, typed: "", typedAt: 0 };
  setActive(Math.max(0, sel.selectedIndex));
  const cur = items[sel.selectedIndex];
  if (cur) cur.scrollIntoView({ block: "nearest" });
}
function setActive(i) {
  if (!selOpen) return;
  selOpen.items.forEach((it, k) => it.classList.toggle("active", k === i));
  selOpen.active = i;
}
function chooseOption(i) {
  const { sel, btn } = selOpen;
  closeSelect();
  btn.focus();
  if (i === sel.selectedIndex) return;
  sel.selectedIndex = i;
  sel.dispatchEvent(new Event("input", { bubbles: true }));
  sel.dispatchEvent(new Event("change", { bubbles: true }));
}
function closeSelect(instant = false) {
  if (!selOpen) return;
  const { pop, btn } = selOpen;
  selOpen = null;
  btn.setAttribute("aria-expanded", "false");
  btn.classList.remove("open");
  if (instant || reducedMotion()) { pop.remove(); return; }
  pop.classList.add("closing");
  setTimeout(() => pop.remove(), 120);
}
document.addEventListener("keydown", (e) => {
  if (!selOpen) return;
  const n = selOpen.items.length;
  let i = selOpen.active;
  const step = (d) => { do { i = (i + d + n) % n; } while (selOpen.sel.options[i].disabled && i !== selOpen.active); setActive(i); selOpen.items[i].scrollIntoView({ block: "nearest" }); };
  if (e.key === "ArrowDown") step(1);
  else if (e.key === "ArrowUp") step(-1);
  else if (e.key === "Home") { setActive(0); }
  else if (e.key === "End") { setActive(n - 1); }
  else if (e.key === "Enter" || e.key === " ") { if (i >= 0) chooseOption(i); }
  else if (e.key === "Escape" || e.key === "Tab") { closeSelect(); if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); } return; }
  else if (e.key.length === 1) {
    // type to jump to an option
    const now = performance.now();
    selOpen.typed = (now - selOpen.typedAt < 700 ? selOpen.typed : "") + e.key.toLowerCase();
    selOpen.typedAt = now;
    const hit = [...selOpen.sel.options].findIndex((o) => o.textContent.toLowerCase().startsWith(selOpen.typed));
    if (hit >= 0) { setActive(hit); selOpen.items[hit].scrollIntoView({ block: "nearest" }); }
  } else return;
  e.preventDefault();
  e.stopPropagation();
}, true);
document.addEventListener("pointerdown", (e) => {
  if (selOpen && !selOpen.pop.contains(e.target) && !selOpen.btn.contains(e.target)) {
    closeSelect();
    if (map.getContainer().contains(e.target)) suppressClickUntil = performance.now() + 500;
  }
}, true);
window.addEventListener("resize", () => closeSelect(true));
document.addEventListener("scroll", (e) => { if (selOpen && !selOpen.pop.contains(e.target)) closeSelect(true); }, true);
// selects added later (checkpoint rows, route summary, GPX tracks) are enhanced as they appear
new MutationObserver((records) => {
  for (const r of records) for (const nd of r.addedNodes) {
    if (nd.nodeType !== 1) continue;
    if (nd.tagName === "SELECT") enhanceSelect(nd);
    else nd.querySelectorAll && nd.querySelectorAll("select").forEach(enhanceSelect);
  }
}).observe(document.body, { childList: true, subtree: true });
document.querySelectorAll("select").forEach(enhanceSelect);

// ------------------------------------------------------------------ themes & appearance
const DEFAULT_THEME = "graphite";
// Map theme: "dark" (default), "light", or "auto" (dark only with a dark app theme). Older versions
// stored a checkbox (night_map) that meant "auto"; unticking it meant a light map.
function mapTheme(s) {
  if (["dark", "light", "auto"].includes(s.map_theme)) return s.map_theme;
  return s.night_map === true ? "auto" : s.night_map === false ? "light" : "dark";
}
function applyAppearance() {
  const s = settings();
  const theme = THEMES.some((t) => t[0] === s.theme) ? s.theme : DEFAULT_THEME;
  document.documentElement.dataset.theme = theme;
  const dark = DARK_THEMES.has(theme) || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  const mt = mapTheme(s);
  const nightMap = mt === "dark" || (mt === "auto" && dark);
  document.documentElement.classList.toggle("night-map", nightMap);
  document.documentElement.classList.toggle("compact", !!s.compact);
  document.querySelectorAll(".theme-card").forEach((c) => c.classList.toggle("active", c.dataset.theme === theme));
  $("pref-map-theme").value = mt;
  MAP_PROVIDERS.openfreemap.layer.setDark(nightMap);
  const provider = savedProvider(s);
  $("pref-map-provider").value = provider;
  applyMapProvider(provider);
  rememberAppearance(theme, nightMap);
  layerControl.refresh();
}
// remembered for the first paint of the next start (index.html applies it before the CSS renders)
function rememberAppearance(theme = document.documentElement.dataset.theme, nightMap = document.documentElement.classList.contains("night-map")) {
  const data = { theme, nightMap, map_provider: savedProvider(settings()) };
  try { localStorage.setItem("ls-appearance", JSON.stringify(data)); } catch (_) { /* storage blocked */ }
}
// The everyday themes up front; the colourful ones sit under "More themes".
const MAIN_THEMES = new Set(["system", "light", "dark", "graphite", "contrast-dark", "contrast-light"]);
function renderThemeGrid() {
  const card = ([id, name, bg, accent, panel]) =>
    el("button", { type: "button", class: "theme-card", dataset: { theme: id }, title: name,
      onclick: () => { settings().theme = id; applyAppearance(); saveSettingsSoon(); } },
      el("span", { class: "theme-swatch" },
        el("span", { style: `background:${bg}` }),
        el("span", {}, el("span", { style: `background:${accent}` }), el("span", { style: `background:${panel}` }))),
      el("span", { class: "theme-name", textContent: name }));
  const more = el("details", { class: "sub theme-more" }, el("summary", { textContent: "More themes" }),
    el("div", { class: "theme-grid" }, ...THEMES.filter((t) => !MAIN_THEMES.has(t[0])).map(card)));
  more.querySelector("summary").addEventListener("click", (e) => { e.preventDefault(); toggleSection(more); });
  $("theme-grid").replaceChildren(el("div", { class: "theme-grid" }, ...THEMES.filter((t) => MAIN_THEMES.has(t[0])).map(card)), more);
  if (!MAIN_THEMES.has(settings().theme || DEFAULT_THEME)) more.open = true;
  applyAppearance();
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyAppearance);
$("pref-map-theme").onchange = (e) => { settings().map_theme = e.target.value; applyAppearance(); saveSettingsSoon(); };
$("pref-map-provider").onchange = (e) => { settings().map_provider = e.target.value; providerWarned = false; applyAppearance(); saveSettingsSoon(); };
$("pref-compact").onchange = (e) => { settings().compact = e.target.checked; applyAppearance(); saveSettingsSoon(); };

// ------------------------------------------------------------------ collapsible sections (open/closed state is remembered)
// Sections fold and unfold with a height animation; an opened section near the bottom of the side
// menu scrolls smoothly into view.
const ALWAYS_CLOSED_AT_START = new Set(["sec-route-import", "sec-route-settings", "experimental", "sec-checkpoints", "sec-wander"]);
function toggleSection(d, open = !d.open) {
  if (d._anim) { d._anim.cancel(); d._anim = null; }
  const summary = d.querySelector(":scope > summary");
  if (reducedMotion() || !summary) { d.open = open; return; }
  const from = d.offsetHeight;
  d.style.overflow = "hidden";
  if (open) d.open = true;
  const chrome = d.offsetHeight - d.clientHeight; // borders
  const to = open ? d.offsetHeight : summary.offsetHeight + chrome;
  d.classList.toggle("opening", open);
  d.classList.toggle("closing", !open);
  const anim = d.animate([{ height: `${from}px` }, { height: `${to}px` }],
    { duration: Math.min(320, 160 + Math.abs(to - from) * 0.25), easing: "cubic-bezier(.2,.8,.2,1)" });
  d._anim = anim;
  anim.onfinish = () => {
    d._anim = null;
    if (!open) d.open = false;
    d.style.overflow = "";
    d.classList.remove("opening", "closing");
    if (open) revealInSidebar(d);
  };
}
function revealInSidebar(elm) {
  const sb = $("sidebar"), r = elm.getBoundingClientRect(), view = sb.getBoundingClientRect();
  const bottom = Math.min(view.bottom, $("player").getBoundingClientRect().top) - 8;
  if (r.bottom > bottom) sb.scrollBy({ top: Math.min(r.bottom - bottom, r.top - view.top - 120), behavior: reducedMotion() ? "auto" : "smooth" });
}
function wireSections() {
  document.querySelectorAll("details.section, details.sub").forEach((d) => {
    const summary = d.querySelector(":scope > summary");
    summary.addEventListener("click", (e) => { e.preventDefault(); toggleSection(d); });
    if (!d.classList.contains("section")) return;
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
    if (d && d.tagName === "DETAILS" && !ALWAYS_CLOSED_AT_START.has(id)) d.open = !!open;
  }
  for (const id of ALWAYS_CLOSED_AT_START) { const d = $(id); if (d) d.open = false; }
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
// The side menu slides out and back in; the map follows its edge frame by frame.
function setSidebarHidden(hidden) {
  document.body.classList.toggle("sidebar-hidden", hidden);
  $("btn-show-sidebar").hidden = !hidden;
  const end = performance.now() + (reducedMotion() ? 0 : 340);
  const follow = () => {
    map.invalidateSize({ pan: false, animate: false });
    if (performance.now() < end) requestAnimationFrame(follow);
  };
  requestAnimationFrame(follow);
}
$("btn-hide-sidebar").onclick = () => setSidebarHidden(true);
$("btn-show-sidebar").onclick = () => setSidebarHidden(false);

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
    state.devices = devices;
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
    const { device } = await api("/api/connect", { body: { driver: $("driver").value, udid: $("device-select").value || null, connection: $("conn-via").value } });
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
$("btn-wifi").onclick = busy($("btn-wifi"), "Asking the iPhone…", async () => {
  toast((await api("/api/device/wifi", { body: { udid: (state.status && state.status.device && state.status.device.udid) || $("device-select").value || null } })).message);
  refreshDevices(false);
});

// ---- more iPhones at once: extra phones follow the main one (see mirrors.py / device/mirror.rs)
const lostMirrorsToasted = new Set();
async function addMirror() {
  const udid = $("mirror-select").value;
  if (!udid) { toast("Plug in or connect another iPhone, press the refresh button next to Device, then pick it here.", true); return; }
  const { mirror } = await api("/api/mirrors", { body: { udid, connection: $("conn-via").value } });
  toast(`${mirror.name} now follows ${state.status.device.name}`);
  for (const n of mirror.notes || []) toast(n);
  await poll();
}
$("btn-mirror-add").onclick = busy($("btn-mirror-add"), "Connecting…", addMirror);
async function removeMirror(m) {
  await api(`/api/mirrors/${encodeURIComponent(m.udid)}`, { method: "DELETE" });
  toast(`${m.name} no longer follows and is back on its real location`);
  lostMirrorsToasted.delete(m.udid);
  await poll();
}
function renderMirrors(st) {
  const box = $("mirrors");
  const on = !!(st.device && st.live && st.features && st.features.multi_device);
  box.hidden = !on;
  if (!on) return;
  const mirrors = st.mirrors || [];
  const listKey = JSON.stringify(mirrors.map((m) => [m.udid, m.state, m.error]));
  if (box.dataset.list !== listKey) {
    box.dataset.list = listKey;
    $("mirror-list").replaceChildren(...mirrors.map((m) => {
      const lost = m.state === "lost";
      const line = el("div", { class: `status ${lost ? "err" : "ok"}`, title: m.error || m.transport || "" },
        el("span", { textContent: `${m.name}${m.ios_version ? ` · iOS ${m.ios_version}` : ""}${m.connection && m.connection !== "Simulated" ? ` · ${m.connection}` : ""}${lost ? ` · ${m.error}` : ""}` }));
      const rm = el("button", { type: "button", textContent: "Remove", title: "Stop following and send this iPhone back to its real location" });
      rm.onclick = busy(rm, "Removing…", () => removeMirror(m));
      return el("li", {}, line, rm);
    }));
    for (const m of mirrors) {
      if (m.state === "lost" && !lostMirrorsToasted.has(m.udid)) { lostMirrorsToasted.add(m.udid); toast(`${m.name} stopped following: ${m.error}`, true); }
    }
  }
  // phones that can still be added: found in the last device scan, not the main one, not following yet
  const taken = new Set([st.device.udid, ...mirrors.map((m) => m.udid)]);
  const free = (state.devices || []).filter((d) => !taken.has(d.udid));
  const optKey = JSON.stringify(free.map((d) => [d.udid, d.connection]));
  const sel = $("mirror-select");
  if (sel.dataset.opts !== optKey) {
    sel.dataset.opts = optKey;
    const keep = sel.value;
    sel.replaceChildren(...(free.length
      ? free.map((d) => el("option", { value: d.udid, textContent: `${d.name || "iPhone"}${d.ios_version ? ` (iOS ${d.ios_version})` : ""} — ${d.connection || ""}`, title: d.error || d.udid }))
      : [el("option", { value: "", textContent: "No other iPhone found" })]));
    if (keep && free.some((d) => d.udid === keep)) sel.value = keep;
  }
  $("btn-mirror-add").disabled = !free.length;
}

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
  renderMirrors(st);
  if (d) {
    const extra = (st.mirrors || []).length;
    box.className = "status ok";
    box.textContent = `${d.name}${d.ios_version ? ` · iOS ${d.ios_version}` : ""}${d.connection && d.connection !== "Simulated" ? ` · ${d.connection}` : ""} · ${d.transport}`;
    $("driver").value = st.driver;
    chip.className = "chip ok"; chip.textContent = extra ? `${d.name} + ${extra}` : d.name;
    $("dev-summary").textContent = `Connected · ${d.name}${extra ? ` + ${extra} more` : ""}`;
  } else if (state.devicesError && $("driver").value !== "mock") {
    box.className = "status warn";
    // Rebuilt only when the message changes, so the link isn't replaced under the mouse every poll.
    const msg = state.devicesError;
    if (box.dataset.msg !== msg || !box.textContent.startsWith(msg)) {
      box.dataset.msg = msg;
      // one inline block, so the link flows with the text (the status box is a flex row)
      const text = el("span", {}, msg);
      if (/Apple Devices/.test(msg)) text.append(" ", el("a", { href: APPLE_DEVICES_URL, target: "_blank", rel: "noopener", textContent: "Get Apple Devices" }));
      box.replaceChildren(text);
    }
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
      // In the Windows app the page's own request is always allowed, so a refusal comes from Windows:
      // offer its location settings. In a browser, the site permission is in the address bar.
      const winApp = state.status && state.status.app === "standalone" && /Windows/.test(navigator.userAgent);
      const settingsAction = winApp ? { label: "Location settings", run: () => { location.href = "ms-settings:privacy-location"; } } : null;
      if (err.code === 1) {
        toast(winApp ? "Windows blocked location access. Turn on Location services and “Let desktop apps access your location”, then try again."
          : "Location permission was denied for this page, so your real location can't be shown.", !afterStop, settingsAction);
      } else {
        toast("Your real location isn't available (turn on location services for this computer to show it).", !afterStop, settingsAction);
      }
      resolve(false);
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }); // a fresh, precise fix every time
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
  const w = { id: nextId++, lat, lon, name: "", speed_kmh: null, dwell_s: 0, hold: false, leg: defaultLeg(), ...extra };
  state.waypoints.push(w);
  invalidateBuilt();
  renderWaypoints({ appear: w.id });
  // the Route sections start folded: show the list as soon as something is added to it
  const sec = $("sec-checkpoints");
  if (!sec.open && !sec._anim) toggleSection(sec, true);
}
// A route changed: the built route (and the player) no longer match it.
function invalidateBuilt() {
  state.routeRev = (state.routeRev || 0) + 1;
  cancelBuild("changed");
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
  if (hadRoute && state.loaded === "route" && p && !["playing", "held", "joystick"].includes(p.state)) unloadPlayer();
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
  // only this element's own animation ends the effect (animations of its children bubble up too)
  const end = (e) => { if (e.target !== elm) return; elm.classList.remove(cls); elm.removeEventListener("animationend", end); };
  elm.addEventListener("animationend", end);
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
  m.on("click", (e) => L.DomEvent.stop(e)); // without a listener Leaflet hands the click to the map (= add a checkpoint)
  m.on("dblclick", (e) => { L.DomEvent.stop(e); removeWaypoint(id); });
  m.on("contextmenu", (e) => {
    L.DomEvent.stop(e);
    const ev = e.originalEvent;
    openWaypointMenu(id, ev.clientX, ev.clientY);
  });
  m.on("mouseover", () => rowHot(id, true));
  m.on("mouseout", () => rowHot(id, false));
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
// A "hold until Continue" checkpoint carries a small hand badge on its marker.
const pinHtml = (label, hold) => `<div class="wp-pin"><span class="wp-label">${label}</span>${hold
  ? '<span class="wp-mark" title="Holds until you press Continue"><svg viewBox="0 0 24 24"><path d="M8 6v12M16 6v12"/></svg></span>' : ""}</div>`;
function syncMarkers(appearId) {
  const seen = new Set();
  state.waypoints.forEach((w, i) => {
    seen.add(w.id);
    const label = String(i + 1);
    const title = `${w.name || `Checkpoint ${i + 1}`}${w.hold ? " · holds until Continue" : ""} — double-click to delete, right-click for more`;
    let m = wpMarkers.get(w.id);
    if (!m) {
      m = L.marker([w.lat, w.lon], { draggable: true, autoPan: true, title, riseOnHover: true,
        icon: icon("wp-icon", pinHtml(label, w.hold), 24) });
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
    const key = `${label}|${!!w.hold}`;
    if (pin && pin.dataset.key !== key) { pin.outerHTML = pinHtml(label, w.hold); e.querySelector(".wp-pin").dataset.key = key; }
    if (e) e.title = title;
  });
  for (const [id, m] of wpMarkers) if (!seen.has(id)) { wpLayer.removeLayer(m); wpMarkers.delete(id); }
  markHeld();
}
function markerHot(id, on) {
  const m = wpMarkers.get(id);
  if (m && m.getElement()) m.getElement().classList.toggle("hot", on);
}
function rowHot(id, on) {
  const li = wpList.querySelector(`:scope > li.wp[data-id="${id}"]`);
  if (li) li.classList.toggle("hot", on);
  markerHot(id, on);
}
// The checkpoint the player is waiting at (hold until Continue) is coloured on the map and in the list.
function markHeld() {
  const p = state.status && state.status.player;
  const heldId = p && p.state === "held" && state.loaded === "route" && p.held_at != null && state.waypoints[p.held_at]
    ? state.waypoints[p.held_at].id : null;
  for (const [id, m] of wpMarkers) if (m.getElement()) m.getElement().classList.toggle("held", id === heldId);
  wpList.querySelectorAll(":scope > li.wp").forEach((li) => li.classList.toggle("held-here", +li.dataset.id === heldId));
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
// Deleting animates first (the row folds away, the marker shrinks), then the list closes the gap.
const removing = new Set();
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
function removeWaypoint(id, { animate = true } = {}) {
  if (removing.has(id) || !wpById(id)) return;
  closeMenus();
  const finish = () => {
    removing.delete(id);
    const i = state.waypoints.findIndex((x) => x.id === id);
    if (i < 0) return;
    state.waypoints.splice(i, 1);
    invalidateBuilt();
    renderWaypoints({ flip: true });
  };
  const li = wpList.querySelector(`:scope > li.wp[data-id="${id}"]`);
  const m = wpMarkers.get(id);
  if (!animate || reducedMotion()) { finish(); return; }
  removing.add(id);
  if (li) { li.style.setProperty("--h", `${li.offsetHeight}px`); li.classList.add("removing"); }
  if (m && m.getElement()) { m.getElement().classList.remove("hot"); m.getElement().classList.add("removing"); }
  setTimeout(finish, 240);
}
// New checkpoint at position `index` of the list; it takes over the leg settings of the leg it splits.
function insertWaypointAt(index, lat, lon, extra = {}) {
  index = Math.max(0, Math.min(state.waypoints.length, index));
  const prev = state.waypoints[index - 1];
  const leg = prev ? { ...prev.leg } : defaultLeg();
  const w = { id: nextId++, lat, lon, name: "", speed_kmh: null, dwell_s: 0, hold: false, leg, ...extra };
  state.waypoints.splice(index, 0, w);
  state.builtSource = "route";
  invalidateBuilt();
  renderWaypoints({ appear: w.id, flip: true });
  return w;
}
function makeStart(id) {
  const i = state.waypoints.findIndex((x) => x.id === id);
  if (i <= 0) return;
  const wps = state.waypoints;
  // A round trip keeps its order and only starts somewhere else; an open route moves the checkpoint to the front.
  state.waypoints = $("closed").checked ? [...wps.slice(i), ...wps.slice(0, i)] : [wps[i], ...wps.slice(0, i), ...wps.slice(i + 1)];
  invalidateBuilt();
  renderWaypoints({ flip: true, settle: id });
  toast(`Checkpoint ${i + 1} is now the start.`);
}

// ---- placement mode: the next click on the map adds a checkpoint at a chosen position (Insert after)
let placing = null;
function startPlacement(index) {
  closeMenus();
  placing = { index };
  if (state.tab !== "route") openTab("route");
  document.body.classList.add("placing");
  $("map-hint-text").textContent = index >= state.waypoints.length
    ? "Click the map to add the next checkpoint at the end." : `Click the map to add a checkpoint after checkpoint ${index}.`;
  $("map-hint").hidden = false;
}
function stopPlacement() {
  placing = null;
  document.body.classList.remove("placing");
  $("map-hint").hidden = true;
}
$("map-hint-cancel").onclick = stopPlacement;

// ---- context menu (right-click a checkpoint on the map or in the list)
const ctxMenu = $("ctx-menu");
function placeFloating(elm, x, y) {
  elm.hidden = false;
  const r = elm.getBoundingClientRect();
  elm.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  elm.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
}
function closeMenus() {
  ctxMenu.hidden = true;
  $("wait-pop").hidden = true;
}
function openContextMenu(x, y, title, items) {
  closeMenus();
  ctxMenu.replaceChildren(el("div", { class: "ctx-title", textContent: title }), ...items.map((it) => it === "-" ? el("hr") :
    el("button", { type: "button", role: "menuitem", class: it.danger ? "danger" : "", disabled: !!it.disabled,
      onclick: () => { closeMenus(); guard(it.run)(); } },
      svgIcon(it.icon), el("span", { textContent: it.label }), ...(it.key ? [el("span", { class: "ctx-key", textContent: it.key })] : []))));
  placeFloating(ctxMenu, x, y);
  const first = ctxMenu.querySelector("button:not(:disabled)");
  if (first) first.focus({ preventScroll: true });
}
ctxMenu.addEventListener("keydown", (e) => {
  const btns = [...ctxMenu.querySelectorAll("button:not(:disabled)")];
  const i = btns.indexOf(document.activeElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = btns.length;
    btns[(i + (e.key === "ArrowDown" ? 1 : -1) + n) % n].focus();
  }
});
// A click outside an open menu only closes it: on the map it must not also add a checkpoint or pick a point.
function swallowMapClick(e) {
  if (map.getContainer().contains(e.target)) suppressClickUntil = performance.now() + 500;
}
document.addEventListener("pointerdown", (e) => {
  if (!ctxMenu.hidden && !ctxMenu.contains(e.target)) { ctxMenu.hidden = true; swallowMapClick(e); }
  const pop = $("wait-pop");
  if (!pop.hidden && !pop.contains(e.target)) { pop.hidden = true; swallowMapClick(e); }
}, true);
function openWaypointMenu(id, x, y) {
  const i = state.waypoints.findIndex((w) => w.id === id);
  if (i < 0) return;
  const w = state.waypoints[i];
  openContextMenu(x, y, `${i + 1} · ${w.name || fmtLL(w.lat, w.lon)}`, [
    { label: "Delete", icon: "trash", danger: true, key: "Double-click", run: () => removeWaypoint(id) },
    { label: "Insert after", icon: "insert", run: () => startPlacement(i + 1) },
    { label: w.dwell_s || w.hold ? `Set wait… (${w.hold ? "hold" : `${w.dwell_s} s`})` : "Set wait…", icon: "clock", run: () => openWaitPopover(id, x, y) },
    { label: "Make start", icon: "start", disabled: i === 0, run: () => makeStart(id) },
  ]);
}
// ---- "Set wait" popover: seconds to wait, or hold until Continue
let waitFor = null;
function openWaitPopover(id, x, y) {
  const i = state.waypoints.findIndex((w) => w.id === id);
  if (i < 0) return;
  const w = state.waypoints[i];
  waitFor = id;
  $("wait-title").textContent = `Checkpoint ${i + 1}${w.name ? ` · ${w.name}` : ""}`;
  $("wait-input").value = w.dwell_s || "";
  $("wait-hold").checked = !!w.hold;
  placeFloating($("wait-pop"), x, y);
  $("wait-input").focus();
  $("wait-input").select();
}
function saveWait() {
  const w = wpById(waitFor);
  $("wait-pop").hidden = true;
  if (!w) return;
  w.dwell_s = Math.max(0, Math.min(86400, Math.round(+$("wait-input").value || 0)));
  w.hold = $("wait-hold").checked;
  invalidateBuilt();
  renderWaypoints({ settle: w.id });
}
$("wait-save").onclick = saveWait;
$("wait-cancel").onclick = () => ($("wait-pop").hidden = true);
$("wait-pop").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); saveWait(); }
  if (e.key === "Escape") { e.preventDefault(); $("wait-pop").hidden = true; }
});
function renderWaypoints(opts = {}) {
  const first = opts.flip ? captureRects() : null;
  const focusedGrip = document.activeElement && document.activeElement.classList.contains("wp-grip")
    ? document.activeElement.closest("li.wp").dataset.id : null;
  wpList.replaceChildren();
  const n = state.waypoints.length;
  const closed = $("closed").checked;
  $("wp-count").textContent = n ? `${n} checkpoint${n > 1 ? "s" : ""}` : "";
  if (!n) wpList.append(el("li", { class: "empty" }, el("b", { textContent: "No checkpoints yet" }),
    el("span", { textContent: "Click the map to add one. Drag markers to move them; drag the handle here to reorder." })));
  state.waypoints.forEach((w, i) => {
    const change = (fn) => (e) => { fn(e.target); invalidateBuilt(); };
    const grip = el("button", { type: "button", class: "wp-grip", title: "Drag to reorder (or focus and press the arrow keys)",
      "aria-label": `Move checkpoint ${i + 1}. Use the up and down arrow keys.` }, svgIcon("grip"));
    const num = el("span", { class: "wp-num", textContent: i + 1, title: "Drag to reorder" });
    const head = el("div", { class: "wp-head" }, grip, num,
      el("input", { value: w.name, placeholder: fmtLL(w.lat, w.lon), title: "Name", "aria-label": "Checkpoint name", oninput: (e) => (w.name = e.target.value) }),
      el("button", { type: "button", class: "wp-del", title: "Remove (or double-click its marker)", "aria-label": `Remove checkpoint ${i + 1}`, onclick: () => removeWaypoint(w.id) }, svgIcon("x")),
    );
    const fields = el("div", { class: "wp-fields" },
      el("label", {}, "Speed here (km/h)",
        el("input", { type: "number", min: 0, step: 0.1, value: w.speed_kmh ?? "", placeholder: "auto",
          title: "Exact speed when passing this checkpoint. Blank = whatever the limits allow. 0 = come to a stop.",
          onchange: change((t) => (w.speed_kmh = numOrNull(t.value))) })),
      el("label", {}, "Wait here (s)",
        el("input", { type: "number", min: 0, step: 1, value: w.dwell_s || "", placeholder: "0", title: "Stop and wait this long",
          onchange: change((t) => (w.dwell_s = Math.max(0, +t.value || 0))) })),
      el("label", { class: "check", title: "Stop here and wait until you press Continue (any wait time runs after that)" },
        el("input", { type: "checkbox", checked: !!w.hold, "aria-label": `Hold at checkpoint ${i + 1} until Continue`,
          onchange: change((t) => { w.hold = t.checked; syncMarkers(); }) }), "Hold"),
    );
    const li = el("li", { class: "wp", dataset: { id: w.id } }, head, fields);
    li.addEventListener("contextmenu", (e) => {
      if (["INPUT", "SELECT"].includes(e.target.tagName)) return; // keep copy/paste in the fields
      e.preventDefault();
      openWaypointMenu(w.id, e.clientX, e.clientY);
    });
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
    li.addEventListener("mouseenter", () => rowHot(w.id, true));
    li.addEventListener("mouseleave", () => rowHot(w.id, false));
    if (opts.appear === w.id) flash(li, "settle");
    wpList.append(li);
  });
  if (first) playFlip(first, opts.settle);
  if (focusedGrip) { const g = wpList.querySelector(`li.wp[data-id="${focusedGrip}"] .wp-grip`); if (g) g.focus(); }
  for (const id of removing) { const li = wpList.querySelector(`:scope > li.wp[data-id="${id}"]`); if (li) li.classList.add("removing"); }
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
// The default speed applies to every leg without its own speed, so the built route no longer matches.
$("default-speed").onchange = () => { invalidateBuilt(); renderWaypoints(); };
$("default-mode").onchange = () => { cancelBuild("changed"); renderRouteSettingsSub(); };
$("alt-count").addEventListener("change", () => { cancelBuild("changed"); renderRouteSettingsSub(); });
async function clearRoute() {
  const saved = { waypoints: state.waypoints.map((w) => ({ ...w, leg: { ...w.leg } })), built: state.built };
  state.builtSource = "route";
  state.waypoints = [];
  invalidateBuilt();
  renderWaypoints();
  const p = state.status && state.status.player;
  if (p && state.loaded === "route" && p.state !== "joystick") {
    if (["playing", "paused", "held"].includes(p.state)) await api("/api/player/stop", { body: {} }).catch(() => {});
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
    waypoints: wps.map((w, i) => ({ lat: w.lat, lon: w.lon, name: w.name || `Checkpoint ${i + 1}`, speed_kmh: w.speed_kmh,
      dwell_s: w.dwell_s || 0, hold: !!w.hold })),
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
  buildBtn.classList.remove("done", "failed", "cancelled");
  buildBtn.classList.add("loading");
  $("build-row").classList.add("loading");
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
function buildFinish(ok, msg, kind = ok ? "done" : "failed") {
  cancelAnimationFrame(bp.raf);
  clearTimeout(bp.timer);
  bp.timer = 0;
  bp.queue = [];
  buildBtn.classList.remove("loading");
  buildBtn.classList.add(kind);
  $("build-row").classList.remove("loading");
  buildBtn.disabled = false;
  buildBtn.removeAttribute("aria-busy");
  if (ok) { bp.fill.style.width = "100%"; bp.pct.textContent = "100%"; }
  else bp.pct.textContent = "";
  showTick(msg, ok ? "check" : kind === "cancelled" ? "x" : "warn");
  bp.resetTimer = setTimeout(buildReset, ok ? 2200 : kind === "cancelled" ? 1400 : 2600);
}
function buildReset() {
  cancelAnimationFrame(bp.raf);
  buildBtn.classList.remove("loading", "done", "failed", "cancelled");
  buildBtn.disabled = false;
  bp.fill.style.width = "0%";
  bp.ticker.replaceChildren();
}
function noAlternativesReason(body) {
  const roads = body.legs.filter((l) => ["car", "bike", "foot"].includes(l.mode)).length;
  return roads ? "No alternative routes were found for these checkpoints (short legs often have only one sensible way)."
    : "Sea and straight-line legs have no alternative routes.";
}
// A build in progress stops when it's cancelled or when the route or its settings change: the
// request is aborted, which also stops the server's work on it.
function cancelBuild(reason = "user") {
  const ctl = state.buildCtl;
  if (!ctl || ctl.signal.aborted) return;
  state.cancelReason = reason;
  ctl.abort();
}
$("btn-build-cancel").onclick = () => cancelBuild("user");
async function buildRoute() {
  if (state.building) {
    // a new build (for example after dragging the route line) replaces the one running
    state.replacing = true;
    cancelBuild("restart");
    await state.buildDone;
    state.replacing = false;
  }
  if (state.waypoints.length < 2) throw new Error("Add at least two checkpoints (click the map in the Route tab).");
  state.building = true;
  let done;
  state.buildDone = new Promise((r) => (done = r));
  const ctl = new AbortController();
  state.buildCtl = ctl;
  state.cancelReason = null;
  const rev = state.routeRev;
  buildStart();
  buildStage(0, "Preparing the route", 0.02);
  try {
    const body = routeBody($("route-name").value.trim() || "Route");
    const res = await apiStream("/api/route/build?stream=1", body, (ev) => buildStage(ev.p, ev.msg, ev.next), ctl.signal);
    if (ctl.signal.aborted || rev !== state.routeRev) throw new DOMException("cancelled", "AbortError");
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
    if (e.name === "AbortError" || ctl.signal.aborted) {
      const why = state.cancelReason;
      buildFinish(false, why === "user" ? "Build cancelled" : "Cancelled: the route changed", "cancelled");
      if (why === "changed" && !state.replacing) toast("The route changed while it was building, so that build was cancelled. Press Build route when you're ready.");
      return;
    }
    buildFinish(false, "Couldn't build the route");
    throw e;
  } finally {
    state.building = false;
    if (state.buildCtl === ctl) state.buildCtl = null;
    done();
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
  const wasPlaying = p && state.loaded === "route" && ["playing", "paused", "held"].includes(p.state);
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
// Colours blend in OKLab, a perceptually even colour space: mixing two sRGB colours directly passes
// through muddy greys and jumps in brightness, which showed as bands along the route.
const toLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const fromLin = (c) => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)));
function oklab([r, g, b]) {
  const [R, G, B] = [toLin(r), toLin(g), toLin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const q = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * q, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * q,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * q];
}
function fromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    q = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [fromLin(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * q), fromLin(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * q),
    fromLin(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * q)];
}
const SPEED_LAB = SPEED_STOPS.map(([f, c]) => [f, oklab(c)]);
const speedColorCache = new Map();
function speedColor(f) {
  f = Math.min(1, Math.max(0, f));
  const key = Math.round(f * 512);
  let c = speedColorCache.get(key);
  if (c) return c;
  const x = key / 512;
  let i = 1;
  while (i < SPEED_LAB.length - 1 && x > SPEED_LAB[i][0]) i++;
  const [f0, c0] = SPEED_LAB[i - 1], [f1, c1] = SPEED_LAB[i];
  const t = Math.min(1, Math.max(0, (x - f0) / (f1 - f0 || 1)));
  c = `rgb(${fromOklab(c0.map((v, k) => v + (c1[k] - v) * t)).join(",")})`;
  speedColorCache.set(key, c);
  return c;
}
// Speeds every `step` metres along the path, lightly smoothed over distance (Gaussian), so the colour
// follows acceleration and braking as a gradient instead of stepping between neighbouring samples.
function speedProfile(path, at, total) {
  const step = Math.max(3, total / 6000);
  const pts = [], vs = [];
  let j = 0;
  for (let d = 0; ; d += step) {
    const dd = Math.min(d, total);
    while (j < path.length - 2 && path[j + 1].d < dd) j++;
    const a = path[j], b = path[Math.min(j + 1, path.length - 1)];
    const f = b.d > a.d ? (dd - a.d) / (b.d - a.d) : 0;
    pts.push({ ll: [a.ll[0] + (b.ll[0] - a.ll[0]) * f, a.ll[1] + (b.ll[1] - a.ll[1]) * f], d: dd });
    vs.push(at(dd));
    if (dd >= total) break;
  }
  const sigma = Math.min(50, Math.max(5, total / 2000)) / step;
  const r = Math.min(60, Math.ceil(sigma * 2.5));
  const w = Array.from({ length: 2 * r + 1 }, (_, k) => Math.exp(-(((k - r) / sigma) ** 2) / 2));
  return pts.map((p, i) => {
    let num = 0, den = 0;
    for (let k = -r; k <= r; k++) {
      const v = vs[i + k];
      if (v === undefined) continue;
      num += v * w[k + r]; den += w[k + r];
    }
    return { ...p, v: num / den };
  });
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
// Each point also records which leg it belongs to (for inserting a checkpoint by dragging the line).
function routePath(legs) {
  const out = [];
  let prev = null, d = 0;
  (legs || []).forEach((leg, li) => {
    for (const p of leg) {
      if (!prev) { out.push({ ll: p, d: 0, leg: li }); prev = p; continue; }
      const step = haversine(prev, p);
      if (step < 1e-3) continue; // the shared checkpoint between two legs
      const n = step > 2000 ? Math.min(64, Math.ceil(step / 2000)) : 1;
      for (let k = 1; k <= n; k++) out.push({ ll: k === n ? p : gcInterp(prev, p, k / n), d: d + (step * k) / n, leg: li });
      d += step;
      prev = p;
    }
  });
  return out;
}
// Closest point of a path to a map position, in screen pixels: {i (segment), f, ll, d, leg, px}.
function nearestOnPath(path, latlng) {
  const P = map.latLngToLayerPoint(latlng);
  let best = null;
  for (let i = 0; i < path.length - 1; i++) {
    const a = map.latLngToLayerPoint(path[i].ll), b = map.latLngToLayerPoint(path[i + 1].ll);
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    const f = L2 > 0 ? Math.max(0, Math.min(1, ((P.x - a.x) * dx + (P.y - a.y) * dy) / L2)) : 0;
    const px = Math.hypot(P.x - a.x - f * dx, P.y - a.y - f * dy);
    if (!best || px < best.px) best = { i, f, px };
  }
  if (!best) return null;
  const a = path[best.i], b = path[best.i + 1];
  return { ...best, ll: [a.ll[0] + (b.ll[0] - a.ll[0]) * best.f, a.ll[1] + (b.ll[1] - a.ll[1]) * best.f],
    d: a.d + (b.d - a.d) * best.f, leg: b.leg };
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
const SPEED_LEVELS = 64; // colour steps: fine enough that neighbouring pieces can't be told apart
function optionLabel(o, k) { return o.option ? o.option.label : "ABCD"[k] || String(k + 1); }
const altLines = new Map(); // option index -> {line, label}
// Where an alternative is furthest from the chosen route: the clearest spot for its label.
function mostDistinctPoint(altPath, mainPath) {
  const sub = (p, n) => p.filter((_, i) => i % Math.max(1, Math.floor(p.length / n)) === 0);
  const main = sub(mainPath, 240).map((g) => g.ll);
  let best = null, bestD = -1;
  for (const g of sub(altPath, 160)) {
    let dmin = Infinity;
    for (const m of main) { const d = haversine(g.ll, m); if (d < dmin) dmin = d; }
    if (dmin > bestD) { bestD = dmin; best = g.ll; }
  }
  return best;
}
function highlightAlt(k, on) {
  const a = altLines.get(k);
  if (!a) return;
  a.line.setStyle({ color: on ? "#e5e7eb" : "#a3acb9", weight: on ? 7 : 5.5 });
  if (a.label && a.label.getElement()) a.label.getElement().classList.toggle("hover", on);
}
function drawRoute({ fit = false } = {}) {
  const res = state.built;
  const layer = state.builtSource === "gpx" ? gpxLayer : routeLayer;
  layer.clearLayers();
  altLines.clear();
  state.routeGeom = null;
  if (!res) return;
  const opts = state.options && state.options.length ? state.options : [res];
  const path = routePath(res.legs);
  // Other route options underneath in grey, each labelled where it differs most. Clicking one uses it.
  opts.forEach((o, k) => {
    if (o === res) return;
    const altPath = routePath(o.legs);
    const pts = altPath.map((g) => g.ll);
    const d = o.summary.duration_s - opts[0].summary.duration_s;
    const delta = k ? `${d >= 0 ? "+" : "−"}${fmtTime(Math.abs(d))}` : "main";
    L.polyline(pts, { ...LINE, renderer: routeRenderer, color: "#334155", weight: 9, opacity: 0.45, interactive: false }).addTo(layer);
    const line = L.polyline(pts, { ...LINE, renderer: routeRenderer, color: "#a3acb9", weight: 5.5, opacity: 1, bubblingMouseEvents: false })
      .bindTooltip(`Route ${optionLabel(o, k)} · ${fmtDist(o.summary.distance_m)} · ${fmtTime(o.summary.duration_s)}`
        + `${k ? ` (${delta})` : ""} — click to use it`, { sticky: true })
      .on("click", () => guard(selectOption)(k))
      .on("mouseover", () => highlightAlt(k, true))
      .on("mouseout", () => highlightAlt(k, false))
      .addTo(layer);
    const spot = mostDistinctPoint(altPath, path);
    let label = null;
    if (spot) {
      label = L.marker(spot, { pane: "altLabels", keyboard: false, title: `Use route ${optionLabel(o, k)}`,
        icon: L.divIcon({ className: "alt-label", html: `<span><b>${optionLabel(o, k)}</b>${delta}</span>`, iconSize: [84, 22], iconAnchor: [42, 11] }) })
        .on("click", () => guard(selectOption)(k))
        .on("mouseover", () => highlightAlt(k, true))
        .on("mouseout", () => highlightAlt(k, false))
        .addTo(layer);
    }
    altLines.set(k, { line, label });
  });
  // The chosen route: a white halo and a dark outline keep it readable over roads of any colour
  // (and over satellite imagery), then the speed colours on top.
  const pts = path.map((g) => g.ll);
  const R = { ...LINE, renderer: routeRenderer };
  L.polyline(pts, { ...R, color: "#ffffff", weight: 13, opacity: 0.6, interactive: false }).addTo(layer);
  L.polyline(pts, { ...R, color: "#0f172a", weight: 9.5, opacity: 0.9, interactive: false }).addTo(layer);
  const pv = res.preview || [];
  const vmax = Math.max(1, ...pv.map((p) => p[3]));
  const vmin = Math.min(...pv.map((p) => p[3]), vmax);
  const span = Math.max(1, vmax - vmin);
  const at = speedLookup(pv);
  const total = path.length ? path[path.length - 1].d : 0;
  // colour runs along the real geometry (older servers without distances: along the samples)
  const samples = at && total > 0 ? speedProfile(path, at, total) : pv.map((p) => ({ ll: [p[1], p[2]], v: p[3] }));
  let run = [], runLevel = -1;
  const flush = () => {
    if (run.length < 2) return;
    L.polyline(run.map((p) => p.ll), { ...R, color: speedColor(runLevel / SPEED_LEVELS), weight: 5.5, opacity: 1, interactive: false }).addTo(layer);
  };
  for (const p of samples) {
    const level = Math.round(((p.v - vmin) / span) * SPEED_LEVELS);
    if (level !== runLevel && run.length) { const last = run[run.length - 1]; flush(); run = [last]; }
    runLevel = level;
    run.push(p);
  }
  flush();
  // One invisible, wider line on top takes the mouse: a tooltip with the speed under the pointer, and
  // (Route tab) dragging it inserts a checkpoint there, like moving a route in Google Maps.
  if (pts.length > 1) {
    state.routeGeom = { path, at };
    const hit = L.polyline(pts, { ...R, weight: 18, opacity: 0, className: "route-main" }).addTo(layer);
    hit.bindTooltip("", { sticky: true, direction: "top", offset: [0, -8] });
    hit.on("mousemove", (e) => {
      const g = state.routeGeom;
      if (!g || routeDrag) return;
      const near = nearestOnPath(g.path, e.latlng);
      if (!near) return;
      const v = g.at ? g.at(near.d) : null;
      const canDrag = state.builtSource === "route" && state.tab === "route";
      hit.setTooltipContent(`${v != null ? `${v.toFixed(0)} km/h · ` : ""}${fmtDist(near.d)} from the start`
        + `${(res.legs || []).length > 1 ? ` · leg ${near.leg + 1}` : ""}${canDrag ? "<br><span class='muted'>Drag to add a checkpoint here</span>" : ""}`);
    });
    hit.on("mousedown", (e) => startRouteDrag(e));
    // canvas lines can't carry a CSS cursor of their own: show "grab" on the canvas while over the line
    const cur = (c) => { const el = routeRenderer.getPane && routeRenderer._container; if (el) el.style.cursor = c; };
    hit.on("mouseover", () => cur(state.builtSource === "route" && state.tab === "route" ? "grab" : ""));
    hit.on("mouseout", () => cur(""));
  }
  $("legend-min").textContent = vmin.toFixed(0);
  $("legend-max").textContent = vmax.toFixed(0);
  $("speed-legend").hidden = pv.length < 2;
  if (fit) {
    const all = opts.flatMap((o) => (o.legs || []).flat());
    if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [30, 30] });
  }
}

// ---- drag the route line to insert a checkpoint (into the leg that was grabbed)
let routeDrag = null;
function startRouteDrag(e) {
  const ev = e.originalEvent;
  if (ev.button !== 0 || state.builtSource !== "route" || state.tab !== "route" || state.building || !state.routeGeom) return;
  const near = nearestOnPath(state.routeGeom.path, e.latlng);
  if (!near) return;
  L.DomEvent.stop(e); // no map panning while the line is held
  map.dragging.disable();
  routeDrag = { leg: near.leg, x: ev.clientX, y: ev.clientY, moved: false, ghost: null, guide: null };
  document.addEventListener("pointermove", onRouteDragMove);
  document.addEventListener("pointerup", endRouteDrag, { once: true });
}
function onRouteDragMove(ev) {
  const d = routeDrag;
  if (!d) return;
  if (!d.moved && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < 5) return;
  const ll = map.mouseEventToLatLng(ev);
  if (!d.moved) {
    d.moved = true;
    routeLayer.eachLayer((l) => { if (l.closeTooltip) l.closeTooltip(); });
    d.ghost = L.marker(ll, { interactive: false, keyboard: false, icon: icon("drag-ghost", '<div class="ghost-pin"></div>', 16) }).addTo(map);
    d.guide = L.polyline([], { color: cssVar("--accent") || "#2563eb", weight: 2.5, dashArray: "6 6", interactive: false }).addTo(map);
  }
  const wps = state.waypoints, n = wps.length;
  const a = wps[d.leg], b = wps[(d.leg + 1) % n];
  d.ghost.setLatLng(ll);
  if (a && b) d.guide.setLatLngs([[a.lat, a.lon], ll, [b.lat, b.lon]]);
  d.ll = ll;
}
function endRouteDrag() {
  const d = routeDrag;
  routeDrag = null;
  document.removeEventListener("pointermove", onRouteDragMove);
  map.dragging.enable();
  if (!d || !d.moved) return; // a plain click on the line: handled like a click on the map
  suppressClickUntil = performance.now() + 400;
  if (d.ghost) map.removeLayer(d.ghost);
  if (d.guide) map.removeLayer(d.guide);
  if (!d.ll) return;
  const w = insertWaypointAt(d.leg + 1, d.ll.lat, wrapLon(d.ll.lng));
  toast(`Added checkpoint ${d.leg + 2} on leg ${d.leg + 1}. Rebuilding the route…`);
  guard(buildRoute)().then(() => flash(wpList.querySelector(`:scope > li.wp[data-id="${w.id}"]`), "settle"));
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
        title: `Use route ${optionLabel(o, k)}`, onclick: () => guard(selectOption)(k),
        onmouseenter: () => highlightAlt(k, true), onmouseleave: () => highlightAlt(k, false) },
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
  if (s.corners_slowed) {
    const t = s.sharpest_turn;
    feat.push(`slowed for ${s.corners_slowed} bend${s.corners_slowed > 1 ? "s" : ""}/U-turns`
      + (t ? ` (sharpest: ${Math.round(t.angle_deg)}° on a ${t.radius_m < 10 ? t.radius_m.toFixed(1) : Math.round(t.radius_m)} m arc, taken at ${Math.round(t.speed_kmh)} km/h)` : ""));
  }
  if (f.uturns) feat.push(`${f.uturns} U-turn${f.uturns > 1 ? "s" : ""} in the directions`);
  if (f.offnet_m >= 25) feat.push(`${fmtDist(f.offnet_m)} off the road network (private road, gated area or car park; driven slowly)`);
  if (f.restricted_segments) feat.push("private/restricted roads driven slowly");
  if (f.highway_segments || f.ramps) feat.push("motorway sections");
  const rings = s.roundabouts || [];
  if (rings.length) {
    const sp = rings.map((r) => r.speed_kmh);
    const lo = Math.round(Math.min(...sp)), hi = Math.round(Math.max(...sp));
    feat.push(`${rings.length} roundabout${rings.length > 1 ? "s" : ""} driven at ${lo === hi ? lo : `${lo}–${hi}`} km/h`);
  }
  if (feat.length) extra.push(el("p", { class: "hint" }, "Road features: " + feat.join("; ") + "."));
  if (s.holds) extra.push(el("p", { class: "hint", textContent: `Stops at ${s.holds} checkpoint${s.holds > 1 ? "s" : ""} until you press Continue (the times above don't include that wait).` }));
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
    if (p && ["playing", "paused", "held"].includes(p.state)) await api("/api/player/stop", { body: {} }).catch(() => {});
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
  if (st.state === "held") { await continuePlayback(); return; }
  if (st.state === "playing") { await api("/api/player/pause", { body: {} }); await poll(); return; }
  if (!st.name && !st.duration) { toast("Build a route or load a GPX track first."); return; }
  if (!state.status.device) { toast("Connect a device (or the Simulator) first.", true); return; }
  if (st.state !== "paused" && st.t === 0) clearTrail();
  await api(st.state === "paused" ? "/api/player/resume" : "/api/player/play", { body: {} });
  await poll();
}
async function stopPlayback() { await api("/api/player/stop", { body: {} }); await poll(); }
async function continuePlayback() {
  const st = state.status && state.status.player;
  if (!st || st.state !== "held") return;
  await api("/api/player/continue", { body: {} });
  await poll();
}
$("btn-continue").onclick = guard(continuePlayback);
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
    lap_limit: Math.min(100000, Math.max(0, Math.round(+$("laps").value || 0))),
  } });
  saveSettingsSoon();
});
["multiplier", "loop", "jitter", "tick", "laps"].forEach((id) => $(id).addEventListener("change", sendOptions));
function clearTrail() { if (trailLine) trailLine.setLatLngs([]); }
function lapText(p) {
  if (p.loop === "once" || !["playing", "paused", "held", "finished"].includes(p.state)) return "";
  const lap = p.lap || p.laps + 1;
  if (p.lap_limit) return ` · lap ${Math.min(lap, p.lap_limit)} of ${p.lap_limit}`;
  return lap > 1 ? ` · lap ${lap}` : "";
}
function renderPlayer(st) {
  const p = st.player;
  const has = p.duration > 0 || !!p.name;
  $("player").classList.toggle("empty", !has && p.state !== "joystick");
  $("player-name").textContent = p.state === "joystick" ? "Joystick" : (p.name || "No route loaded");
  const badge = $("player-state");
  const word = p.state === "held" ? "waiting" : p.state;
  badge.textContent = word.charAt(0).toUpperCase() + word.slice(1) + lapText(p);
  badge.className = "badge " + p.state;
  const connected = !!st.device;
  const held = p.state === "held";
  playerBtns.play.disabled = !has || !connected || p.state === "playing";
  playerBtns.play.title = !connected ? "Connect a device (or the Simulator) first" : !has ? "Build a route or load a GPX track first" : "";
  playerBtns.play.querySelector(".lbl").textContent = held ? "Continue" : p.state === "paused" ? "Resume" : "Play";
  $("hold-banner").hidden = !held;
  if (held) {
    const w = state.loaded === "route" && p.held_at != null ? state.waypoints[p.held_at] : null;
    $("hold-text").textContent = `Waiting at checkpoint ${p.held_at != null ? p.held_at + 1 : ""}${w && w.name ? ` · ${w.name}` : ""}`;
  }
  markHeld();
  renderHud(p);
  playerBtns.pause.disabled = p.state !== "playing";
  playerBtns.stop.disabled = !["playing", "paused", "held", "joystick"].includes(p.state);
  seek.disabled = !has;
  seek.max = p.duration;
  if (!state.seeking) { seek.value = p.t; $("player-time").textContent = `${fmtTime(p.t)} / ${fmtTime(p.duration)}`; }
  $("player-dist").textContent = `${fmtDist(p.distance_m)} / ${fmtDist(p.total_distance_m)}`;
  $("player-speed").textContent = p.position ? `${(moving(p) ? p.position.speed_kmh : 0).toFixed(1)} km/h` : "—";
  if (p.state === "error" && p.error && state.lastError !== p.error) toast(p.error, true);
  state.lastError = p.error;
  if (p.position) {
    const ll = [p.position.lat, p.position.lon];
    if (!deviceMarker) {
      deviceMarker = L.marker(ll, { icon: icon("dev-icon", '<div class="dev-cone"></div><div class="dev-dot"></div>', 18), zIndexOffset: 1000,
        title: "Spoofed location", interactive: false, keyboard: false }).addTo(map);
      trailLine = L.polyline([], { renderer: trailRenderer, color: "#e53935", weight: 2, opacity: 0.6, interactive: false }).addTo(map);
    }
    deviceMarker.setLatLng(ll);
    const de = deviceMarker.getElement();
    if (de) {
      de.style.setProperty("--course", `${hudAngle(p.position.course, "marker")}deg`);
      de.classList.toggle("still", !moving(p) || p.position.speed_kmh < 0.5);
    }
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

// ------------------------------------------------------------------ live HUD (speed + heading on the map)
const CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const moving = (p) => ["playing", "joystick"].includes(p.state);
// Rotations keep counting past 360 so a turn from 350° to 10° rotates 20°, not back round 340°.
const angles = {};
function hudAngle(course, key) {
  const prev = angles[key];
  if (prev === undefined) return (angles[key] = course);
  const delta = ((course - prev) % 360 + 540) % 360 - 180;
  return (angles[key] = prev + delta);
}
function renderHud(p) {
  const hud = $("hud");
  const show = !!p.position && (["playing", "paused", "held", "joystick"].includes(p.state));
  hud.hidden = !show;
  document.body.classList.toggle("hud-on", show);
  if (!show) return;
  const v = moving(p) ? p.position.speed_kmh : 0;
  const c = ((p.position.course % 360) + 360) % 360;
  $("hud-speed").textContent = v < 10 ? v.toFixed(1) : Math.round(v);
  $("hud-course").textContent = `${Math.round(c) % 360}°`;
  $("hud-card").textContent = CARDINALS[Math.round(c / 45) % 8];
  $("hud-needle").style.transform = `rotate(${hudAngle(c, "hud")}deg)`;
  const tag = $("hud-state");
  tag.hidden = !["paused", "held"].includes(p.state);
  tag.textContent = p.state === "held" ? "Waiting" : "Paused";
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
  ["continue", "N", "Continue from a hold checkpoint", () => continuePlayback()],
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
document.addEventListener("keydown", (e) => {
  if (listeningFor) return;
  if (joystickKeydown(e)) return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || typing()) return;
  if (e.key === "Escape") { hideTip(); closeMenus(); stopPlacement(); if (state.building) cancelBuild("user"); return; }
  const k = e.key.length === 1 ? e.key.toUpperCase() : "";
  if (!/^[A-Z0-9]$/.test(k)) return;
  const m = shortcutMap();
  const id = Object.keys(m).find((a) => m[a] === k);
  if (!id) return;
  e.preventDefault();
  guard(actionById[id][3])();
});
// Shortcuts are listed in tooltips, the right-click menu and the shortcut list (H), not printed on
// every button.
function decorateShortcutHints(root = document) {
  const m = shortcutMap();
  root.querySelectorAll("[data-action]").forEach((b) => {
    const k = m[b.dataset.action];
    b.querySelectorAll(".kbd").forEach((h) => h.remove());
    const base = (b.title || "").replace(/\s*\(shortcut .\)$/, "");
    b.title = k ? `${base} (shortcut ${k})`.trim() : base;
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
$("btn-shortcut-help-close").onclick = () => closeDialog($("shortcut-help"));
$("btn-shortcut-customize").onclick = async () => { await closeDialog($("shortcut-help")); openSettings("keys"); };

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
const SETTING_IDS = ["driver", "conn-via", "provider", "default-mode", "default-speed", "accel", "decel", "alt-count", "start-rest", "stop-end",
  "road-aware", "road-data", "corner-slow", "match-eta", "speed-factor", "multiplier", "loop", "jitter", "tick", "laps", "joy-speed", "gpx-speed"];
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
    waypoints: state.waypoints.map(({ lat, lon, name, speed_kmh, dwell_s, hold, leg }) => ({ lat, lon, name, speed_kmh, dwell_s, hold: !!hold, leg })),
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

// ------------------------------------------------------------------ dialogs
// Dialogs fade and scale in and out (CSS), and when their content changes (another Settings page, the
// next tutorial step) their height glides to the new size instead of jumping.
function morphHeight(dlg, change) {
  if (!dlg.open || reducedMotion()) { change(); return; }
  if (dlg._morph) dlg._morph.cancel();
  const from = dlg.getBoundingClientRect().height;
  change();
  const to = dlg.getBoundingClientRect().height;
  if (Math.abs(to - from) < 1) return;
  dlg.classList.add("morphing");
  const anim = dlg.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 280, easing: "cubic-bezier(.2,.8,.2,1)" });
  dlg._morph = anim;
  const done = () => { if (dlg._morph === anim) { dlg._morph = null; dlg.classList.remove("morphing"); } };
  anim.onfinish = done;
  anim.oncancel = done;
}
function closeDialog(dlg) {
  if (!dlg.open || dlg.classList.contains("closing")) return Promise.resolve();
  if (reducedMotion()) { dlg.close(); return Promise.resolve(); }
  dlg.classList.add("closing");
  return new Promise((resolve) => {
    setTimeout(() => { dlg.classList.remove("closing"); dlg.close(); resolve(); }, 170);
  });
}
for (const dlg of document.querySelectorAll("dialog.modal")) {
  // Esc and the dialog's own close button animate out too
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); if (dlg.id === "tutorial") finishTutorial(); else closeDialog(dlg); });
}
const settingsDlg = $("settings-dialog");
settingsDlg.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); closeDialog(settingsDlg); });
function openSettings(pane = "appearance") {
  $("key-status").textContent = "";
  applyDeveloperMode();
  morphHeight(settingsDlg, () => {
    document.querySelectorAll("#settings-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.pane === pane));
    document.querySelectorAll("#settings-dialog .pane").forEach((p) => (p.hidden = p.dataset.pane !== pane));
    if (pane === "keys") renderShortcutEditor();
  });
  if (pane === "offline") { pollOffline().catch((e) => toast(e.message, true)); updateOfflineEstimate(); }
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
$("btn-tutorial-again").onclick = async () => { await closeDialog(settingsDlg); openTutorial(0); };
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
      "Want to look around first? Pick “Simulator (no iPhone)” as the connection and skip ahead." ], art: "welcome" },
  { title: "1 · Install Apple's device software", body: [
      ["Windows needs Apple's iPhone drivers. Install ", ["Apple Devices from the Microsoft Store", APPLE_DEVICES_URL], " (free, made by Apple). iTunes also works."],
      "Leave it installed; it runs in the background while you use this app.",
      "macOS: nothing to install. Linux: install the usbmuxd package." ], art: "install" },
  { title: "2 · Connect and trust", body: [
      "Plug the iPhone in with a cable and unlock it.",
      "When the phone asks “Trust This Computer?”, tap Trust and enter your passcode.",
      "Then press the refresh button next to the Device list: your iPhone should appear in it." ], art: "trust",
    action: { label: "Look for devices now", run: () => refreshDevices(true) } },
  { title: "3 · Turn on Developer Mode", body: [
      "iOS only lets a computer change the location when Developer Mode is on. Press the button below (iPhone plugged in and unlocked) to make the switch appear.",
      "On the iPhone: Settings › Privacy & Security › Developer Mode → On → Restart. After the restart, unlock and tap Turn On.",
      "You only do this once per phone." ], art: "devmode",
    action: { label: "Reveal Developer Mode", run: revealDevMode } },
  { title: "4 · Connect in this app", body: [
      "Choose “Direct (recommended)” as the connection and press Connect. The first connection to iOS 17 or newer can take up to 30 seconds.",
      "If it fails, the message says what is missing. The help icons next to each tool explain what it does." ], art: "connect",
    action: { label: "Connect now", run: connectNow } },
  { title: "5 · Move your iPhone", body: [
      "Teleport: click the map (or paste a Google Maps link) and press Teleport here. Right-click the map to jump instantly.",
      "Route: click checkpoints, choose roads, footpaths or sea lanes, set speeds, Build route, then Play. The line's colour shows the speed.",
      "Every section can be folded away, the side menu can be resized by dragging its edge, and Settings has themes and keyboard shortcuts (press H to see them).",
      "When you're done, press “Stop spoofing — back to real location”." ], art: "move" },
];
// Small animated illustrations for the tutorial steps (drawn with the theme's colours, see style.css).
const PIN = (x, y) => `<path class="ta-pin" d="M${x} ${y} C${x - 9} ${y - 9} ${x - 14} ${y - 15} ${x - 14} ${y - 22} A14 14 0 0 1 ${x + 14} ${y - 22} C${x + 14} ${y - 15} ${x + 9} ${y - 9} ${x} ${y}Z"/><circle class="ta-pin-dot" cx="${x}" cy="${y - 22}" r="5"/>`;
const ROADS = '<path class="ta-road" d="M20 52H300M20 94H300M92 10V122M204 10V122M20 118L140 10M176 122L300 34"/>';
const TUT_ART = {
  welcome: `<rect class="ta-card" x="20" y="10" width="280" height="112" rx="12"/>${ROADS}
    <path class="ta-route ta-draw" d="M60 100C100 100 112 64 150 62S222 34 250 42"/><circle class="ta-start" cx="60" cy="100" r="6"/>
    <g class="ta-drop">${PIN(250, 42)}</g>`,
  install: `<rect class="ta-win" x="70" y="12" width="180" height="108" rx="9"/><path class="ta-line" d="M70 32H250"/>
    <circle class="ta-dotc" cx="84" cy="22" r="3"/><circle class="ta-dotc" cx="95" cy="22" r="3"/><circle class="ta-dotc" cx="106" cy="22" r="3"/>
    <rect class="ta-tile" x="118" y="48" width="46" height="46" rx="11"/><rect class="ta-glyph" x="133" y="55" width="16" height="31" rx="4"/>
    <g class="ta-down"><path class="ta-acc-s" d="M200 46v28M189 63l11 11 11-11"/></g><path class="ta-line" d="M186 92h28"/>
    <g class="ta-pop"><circle class="ta-ok" cx="164" cy="48" r="10"/><path class="ta-tick" d="M159 48l3.5 3.5 6.5-7"/></g>`,
  trust: `<rect class="ta-win" x="30" y="30" width="100" height="64" rx="7"/><path class="ta-line" d="M20 102h120"/>
    <path class="ta-cable ta-flow" d="M130 82C160 82 160 100 190 100"/>
    <rect class="ta-phone" x="190" y="10" width="68" height="114" rx="13"/>
    <rect class="ta-dialog" x="198" y="42" width="52" height="46" rx="7"/><path class="ta-line" d="M206 53h36M209 61h30"/>
    <rect class="ta-btn ta-pulse" x="206" y="70" width="36" height="11" rx="5.5"/>`,
  devmode: `<rect class="ta-phone" x="116" y="6" width="88" height="120" rx="15"/>
    <rect class="ta-row" x="126" y="26" width="68" height="18" rx="5"/><rect class="ta-row ta-row-hi" x="126" y="50" width="68" height="18" rx="5"/>
    <rect class="ta-row" x="126" y="74" width="68" height="18" rx="5"/><rect class="ta-row" x="126" y="98" width="68" height="18" rx="5"/>
    <path class="ta-line" d="M132 35h22M132 59h26M132 83h20M132 107h16"/>
    <rect class="ta-switch" x="172" y="53" width="18" height="12" rx="6"/><circle class="ta-knob" cx="178" cy="59" r="4.5"/>`,
  connect: `<rect class="ta-win" x="26" y="22" width="124" height="88" rx="9"/><circle class="ta-status" cx="46" cy="44" r="5"/><path class="ta-line" d="M58 44h74"/>
    <rect class="ta-btn" x="48" y="70" width="80" height="20" rx="6"/>
    <circle class="ta-sig s1" cx="172" cy="66" r="4"/><circle class="ta-sig s2" cx="188" cy="66" r="4"/><circle class="ta-sig s3" cx="204" cy="66" r="4"/>
    <rect class="ta-phone" x="222" y="16" width="62" height="104" rx="12"/><g transform="translate(0 4)">${PIN(253, 76)}</g>`,
  move: `<rect class="ta-card" x="20" y="10" width="280" height="112" rx="12"/>${ROADS}
    <path id="tut-route" class="ta-route" d="M40 104C80 104 92 72 130 68S192 94 222 62S262 26 284 32"/>
    <circle class="ta-cp" cx="40" cy="104" r="6"/><circle class="ta-cp" cx="130" cy="68" r="6"/><circle class="ta-cp" cx="284" cy="32" r="6"/>
    <circle class="ta-dev" r="6.5"><animateMotion dur="5s" repeatCount="indefinite"><mpath href="#tut-route"/></animateMotion></circle>`,
};
function tutArt(name) {
  const fig = el("figure", { class: "tut-art", "aria-hidden": "true" });
  fig.innerHTML = `<svg viewBox="0 0 320 132" xmlns="http://www.w3.org/2000/svg">${TUT_ART[name] || ""}</svg>`;
  if (reducedMotion()) fig.firstChild.pauseAnimations(); // the moving dot is SVG animation, not CSS
  return fig;
}
let tutIndex = 0;
const tutDlg = $("tutorial");
function openTutorial(i = 0) { tutIndex = i; renderTutorial(); if (!tutDlg.open) tutDlg.showModal(); }
function stepTutorial(i) { morphHeight(tutDlg, () => { tutIndex = i; renderTutorial(); }); }
function richParagraph(p) {
  if (typeof p === "string") return el("p", { textContent: p });
  return el("p", {}, ...p.map((part) => (Array.isArray(part) ? el("a", { href: part[1], target: "_blank", rel: "noopener", textContent: part[0] }) : part)));
}
function renderTutorial() {
  const step = TUTORIAL[tutIndex];
  $("tut-step").textContent = `Step ${tutIndex + 1} of ${TUTORIAL.length}`;
  $("tut-bar").style.width = `${((tutIndex + 1) / TUTORIAL.length) * 100}%`;
  $("tut-title").textContent = step.title;
  $("tut-art").replaceChildren(tutArt(step.art));
  $("tut-body").replaceChildren(...step.body.map(richParagraph));
  for (const e of [$("tut-art"), $("tut-title"), $("tut-body")]) flash(e, "step-in");
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
  closeDialog(tutDlg);
  settings().tutorial_done = true;
  saveStore().catch(() => {});
}
$("tut-back").onclick = () => { if (tutIndex > 0) stepTutorial(tutIndex - 1); };
$("tut-next").onclick = () => { if (tutIndex < TUTORIAL.length - 1) stepTutorial(tutIndex + 1); else finishTutorial(); };
$("tut-skip").onclick = finishTutorial;
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
// Feature tests (Settings › Updates › Developer access): encrypted builds of unreleased
// experiments. The app checks the password by opening the encrypted list of builds; "Open"
// downloads a build once, then starts it as a separate app in its own window.
const devAccess = $("dev-access");
devAccess.addEventListener("toggle", () => { if (devAccess.open) refreshFeatureTests(false); }); // folds like other sections (wireSections)
// Developer mode: hidden until the About tab is clicked 7 times in a row (like phones do).
let aboutClicks = 0, aboutClickAt = 0;
function applyDeveloperMode() { devAccess.hidden = !settings().developer_mode; }
document.querySelector('#settings-tabs button[data-pane="about"]').addEventListener("click", () => {
  const now = performance.now();
  aboutClicks = now - aboutClickAt < 1500 ? aboutClicks + 1 : 1;
  aboutClickAt = now;
  if (settings().developer_mode) { if (aboutClicks === 7) toast("Developer mode is already on (Settings › Updates)."); return; }
  if (aboutClicks >= 4 && aboutClicks < 7) toast(`${7 - aboutClicks} more to turn on developer mode.`);
  if (aboutClicks === 7) {
    settings().developer_mode = true;
    saveStore().catch(() => {});
    applyDeveloperMode();
    toast("Developer mode is on. Developer access is in Settings › Updates.");
  }
});
$("btn-dev-off").onclick = guard(async () => {
  await api("/api/feature-tests/lock", { body: {} });
  settings().developer_mode = false;
  await saveStore();
  morphHeight(settingsDlg, () => { devAccess.open = false; applyDeveloperMode(); renderFeatureTests({ locked: true }); });
  toast("Developer mode is off.");
});
let ftTimer = null;
function watchFeatureTests(r) {
  clearTimeout(ftTimer);
  if (r.locked || !(r.builds || []).some((b) => !b.ready)) return;
  ftTimer = setTimeout(guard(async () => {
    if (!settingsDlg.open || devAccess.hidden || !devAccess.open) return;
    const p = await api("/api/feature-tests/progress");
    renderFeatureTests(p, false);
  }), 1500);
}
function featureTestDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
function renderFeatureTests(r, animate = true) {
  watchFeatureTests(r);
  const run = animate ? (fn) => morphHeight(settingsDlg, fn) : (fn) => fn();
  run(() => {
    $("ft-locked").hidden = !r.locked;
    $("ft-unlocked").hidden = !!r.locked;
    if (r.locked) return;
    const builds = r.builds || [];
    $("feature-test-list").replaceChildren(...(builds.length ? builds.map((b) => {
      const open = el("button", { type: "button", textContent: "Open", class: b.ready ? "primary" : "",
        title: b.ready ? "Start it in its own window" : "Download it, then start it in its own window" });
      open.onclick = busy(open, "Opening…", async () => {
        await api("/api/feature-tests/open", { body: { pr: b.pr } });
        toast(`Feature test #${b.pr} is starting in its own window.`);
      });
      const page = typeof b.url === "string" && b.url.startsWith("https://github.com/")
        ? el("a", { href: b.url, target: "_blank", rel: "noopener", class: "icon-link", title: "Open the pull request on GitHub", "aria-label": `Pull request #${b.pr} on GitHub` }, svgIcon("external"))
        : el("span");
      return el("li", {},
        el("span", { textContent: `#${b.pr} · ${b.title || "Untitled"}`, title: b.title || "" }),
        el("span", { class: "tag", textContent: b.ready ? "Ready" : b.downloading ? "Downloading…" : "Not downloaded",
          title: `${b.state === "merged" ? "Merged" : "Open"} pull request · built ${featureTestDate(b.built_at)}` }),
        page, open);
    }) : [el("li", { class: "hint", textContent: "No feature-test builds at the moment." })]));
  });
}
async function refreshFeatureTests(report = true) {
  try { renderFeatureTests(await api("/api/feature-tests")); } catch (e) { if (report) throw e; }
}
$("btn-ft-unlock").onclick = busy($("btn-ft-unlock"), "Checking…", async () => {
  const r = await api("/api/feature-tests/unlock", { body: { password: $("ft-password").value, remember: $("ft-remember").checked } });
  $("ft-password").value = "";
  renderFeatureTests(r);
});
$("ft-password").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("btn-ft-unlock").click(); } });
$("btn-ft-refresh").onclick = busy($("btn-ft-refresh"), "Refreshing…", () => refreshFeatureTests(true));
$("btn-ft-lock").onclick = guard(async () => renderFeatureTests(await api("/api/feature-tests/lock", { body: {} })));

// ------------------------------------------------------------------ offline maps (Settings › Offline maps)
let offlineTimer = null;
const offlineBounds = () => {
  const b = map.getBounds();
  return { south: b.getSouth(), west: Math.max(-180, b.getWest()), north: b.getNorth(), east: Math.min(180, b.getEast()) };
};
async function updateOfflineEstimate() {
  const out = $("offline-estimate");
  try {
    const r = await api("/api/offline/estimate", { body: { bounds: offlineBounds(), max_zoom: +$("offline-detail").value } });
    out.className = "small " + (r.ok ? "muted" : "warn");
    out.textContent = r.ok
      ? `The area on screen needs ${r.tiles.toLocaleString()} map tiles (up to ${r.max_tiles.toLocaleString()} per download).`
      : `The area on screen needs ${r.tiles.toLocaleString()} map tiles, more than the ${r.max_tiles.toLocaleString()} one download may have. Zoom in, or choose less detail.`;
    $("btn-offline-download").disabled = !r.ok || !!(state.offline && state.offline.job.running);
  } catch (e) { out.className = "small warn"; out.textContent = e.message; }
}
function renderOffline(st) {
  state.offline = st;
  const j = st.job;
  $("btn-offline-cancel").hidden = !j.running;
  $("btn-offline-download").disabled = j.running;
  const bar = $("offline-progress");
  bar.hidden = !j.running;
  bar.firstElementChild.style.width = `${j.total ? Math.round((j.done / j.total) * 100) : 0}%`;
  if (j.running) $("offline-estimate").textContent = `Downloading “${j.name}”: ${j.done.toLocaleString()} of ${j.total.toLocaleString()} tiles, ${(j.bytes / 1048576).toFixed(1)} MB…`;
  const areas = st.areas || [];
  $("offline-areas").replaceChildren(...(areas.length ? areas.map((a) => {
    const show = el("button", { type: "button", textContent: "Show", title: "Show this area on the map",
      onclick: () => { closeDialog(settingsDlg); map.fitBounds([[a.south, a.west], [a.north, a.east]]); } });
    const del = el("button", { type: "button", class: "danger", textContent: "Delete" });
    del.onclick = busy(del, "Deleting…", async () => { renderOffline(await api(`/api/offline/${encodeURIComponent(a.id)}`, { method: "DELETE" })); });
    return el("li", {},
      el("span", { textContent: a.name, title: a.name }),
      el("span", { class: "tag", textContent: `${(a.bytes / 1048576).toFixed(1)} MB`, title: `${a.tiles.toLocaleString()} map tiles` }), show, del);
  }) : [el("li", { class: "hint", textContent: "No offline areas yet." })]));
}
async function pollOffline() {
  clearTimeout(offlineTimer);
  const st = await api("/api/offline");
  const wasRunning = state.offline && state.offline.job.running;
  morphHeight(settingsDlg, () => renderOffline(st));
  if (st.job.running) offlineTimer = setTimeout(() => pollOffline().catch(() => {}), 600);
  else if (wasRunning) {
    if (st.job.error) toast(st.job.error, true);
    else if (st.job.finished) toast(`“${st.job.finished}” is saved for offline use.`);
    updateOfflineEstimate();
  }
}
$("btn-offline-download").onclick = busy($("btn-offline-download"), "Starting…", async () => {
  renderOffline(await api("/api/offline/download", { body: { name: $("offline-name").value, bounds: offlineBounds(), max_zoom: +$("offline-detail").value } }));
  $("offline-name").value = "";
  await pollOffline();
});
$("btn-offline-cancel").onclick = guard(async () => { await api("/api/offline/cancel", { body: {} }); });
$("offline-detail").addEventListener("change", updateOfflineEstimate);
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
    $("version").textContent = `v${st.version}${st.app === "standalone" ? "" : " · browser"}${st.feature_test ? ` · feature test #${st.feature_test}` : ""}`;
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

// ------------------------------------------------------------------ pressed buttons
// A pressed button sinks in slightly (CSS :active) and a single circular wave spreads from the
// exact point that was pressed to the button's far edges, fading as it goes.
const RIPPLE_TARGETS = "button, .leaflet-bar a";
document.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || reducedMotion()) return;
  const btn = e.target.closest(RIPPLE_TARGETS);
  if (!btn || btn.disabled || btn.matches(".wp-grip")) return;
  const r = btn.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const radius = Math.hypot(Math.max(x, r.width - x), Math.max(y, r.height - y));
  if (getComputedStyle(btn).position === "static") btn.classList.add("ripple-static");
  btn.classList.add("ripple-host");
  const wave = el("span", { class: "ripple", "aria-hidden": "true" });
  wave.style.cssText = `left:${x - radius}px;top:${y - radius}px;width:${radius * 2}px;height:${radius * 2}px`;
  btn.append(wave);
  const done = () => {
    wave.remove();
    if (!btn.querySelector(":scope > .ripple")) btn.classList.remove("ripple-host", "ripple-static");
  };
  wave.addEventListener("animationend", done, { once: true });
  setTimeout(done, 1200); // in case the animation never runs (hidden button)
}, { passive: true });

// ------------------------------------------------------------------ boot
wireInfoButtons();
wireSections();
renderThemeGrid();
renderWaypoints();
renderGpxDrop();
decorateShortcutHints();
// The standalone app keeps its window hidden until the page has painted with the right theme
// (no white flash at start-up); the browser version has no window.ipc.
function notifyReady() {
  try { if (window.ipc && typeof window.ipc.postMessage === "function") window.ipc.postMessage("ready"); } catch (_) { /* not the desktop app */ }
}
(async () => {
  try { await loadStore(); } finally { requestAnimationFrame(() => requestAnimationFrame(notifyReady)); }
  await refreshGoogleStatus();
  await poll();
  refreshDevices(false);
  if (!settings().tutorial_done) openTutorial(0);
})();
