// A smaller version of the app that runs entirely in the browser: teleport, road routes with the
// app's speed engine, playback, and a joystick. A simulated iPhone stands in for the real one.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre looks for its worker next to its own file, which bundling moves; ship it as an asset instead.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { bearing, buildTimeline, destination, distance, sampleAt } from "./engine.js";
import { routeLeg } from "./routing.js";
import Icon from "../components/Icon.jsx";

maplibregl.setWorkerUrl(workerUrl);

import { MAP_START, MAP_STYLE as STYLE } from "./prefetch.js";
// The app's own tuning of OpenFreeMap's dark style (DARK_MAP_PAINT in ui/app.js), so the demo map looks
// like the app's: readable water, parks, buildings, road hierarchy and labels. Missing layers are skipped.
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
function tuneDarkStyle(m) {
  for (const [id, prop, value] of DARK_MAP_PAINT) {
    if (!m.getLayer(id)) continue;
    try { m.setPaintProperty(id, prop, value); } catch { /* the style changed shape: keep its own colour */ }
  }
}
const MODES = [
  { key: "car", label: "Roads (car)", kmh: 50 },
  { key: "bike", label: "Cycle paths", kmh: 18 },
  { key: "foot", label: "Footpaths", kmh: 5 },
  { key: "straight", label: "Straight line", kmh: 50 },
];
const START = MAP_START.center;
const PRESETS = [
  { name: "Westminster by car", mode: "car", kmh: 50, pts: [[51.5007, -0.1246], [51.5033, -0.1195], [51.5081, -0.1281]] },
  { name: "Paris by bike", mode: "bike", kmh: 18, pts: [[48.8584, 2.2945], [48.8638, 2.3135], [48.8606, 2.3376]] },
  { name: "Central Park on foot", mode: "foot", kmh: 5, pts: [[40.7644, -73.973], [40.7712, -73.9742], [40.7794, -73.9632]] },
];
const PLACES = [
  ["Eiffel Tower", 48.85837, 2.29448],
  ["Shibuya Crossing", 35.65952, 139.70056],
  ["Times Square", 40.758, -73.98557],
  ["Sydney Opera House", -33.85678, 151.2153],
];
const MULTS = [1, 2, 5, 10, 30];
const JOY_SPEEDS = [["Walk", 5], ["Run", 10], ["Bike", 18], ["Car", 50]];
const MAX_CP = 8;
const KEYS = { ArrowUp: [0, 1], KeyW: [0, 1], ArrowDown: [0, -1], KeyS: [0, -1], ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0] };

const ll = (p) => [p[1], p[0]];
const fmtCoord = (v) => (v < 0 ? "−" : "") + Math.abs(v).toFixed(5);
const fmtDist = (m) => (m < 1000 ? `${m.toFixed(0)} m` : m < 100000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m / 1000).toLocaleString()} km`);
const fmtTime = (s) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`;
};
const compass = (deg) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];

function parseCoords(text) {
  const m = text.trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = +m[1], lon = +m[2];
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
}

// blue (slow) -> yellow -> red (fast), like the app's speed legend
const STOPS = [[0, [59, 130, 246]], [0.55, [250, 204, 21]], [1, [239, 68, 68]]];
function speedColor(f) {
  for (let i = 1; i < STOPS.length; i++) {
    if (f <= STOPS[i][0]) {
      const [f0, c0] = STOPS[i - 1], [f1, c1] = STOPS[i];
      const t = (f - f0) / (f1 - f0 || 1);
      return `rgb(${c0.map((c, k) => Math.round(c + (c1[k] - c) * t)).join(",")})`;
    }
  }
  return "rgb(239,68,68)";
}

function gradientFor(tl) {
  const { cum, v } = tl;
  const total = cum[cum.length - 1];
  const vmax = Math.max(...v) || 1;
  const expr = ["interpolate", ["linear"], ["line-progress"]];
  const N = 120;
  let k = 0;
  for (let i = 0; i <= N; i++) {
    const s = (total * i) / N;
    while (k < cum.length - 2 && cum[k + 1] < s) k++;
    const ds = cum[k + 1] - cum[k];
    const f = ds > 0 ? (s - cum[k]) / ds : 0;
    const speed = v[k] + (v[k + 1] - v[k]) * Math.min(1, Math.max(0, f));
    expr.push(i / N, speedColor(speed / vmax));
  }
  return expr;
}

function el(cls, html = "") {
  const d = document.createElement("div");
  d.className = cls;
  d.innerHTML = html;
  return d;
}

function webglOk() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

export default function Simulator() {
  const mapBox = useRef(null);
  const map = useRef(null);
  const marks = useRef({});
  const cpMarks = useRef(new Map());
  const overlay = useRef({ route: null, gradient: null, jump: null });
  const [ready, setReady] = useState(false);
  const [mapError, setMapError] = useState(webglOk() ? "" : "This browser can't draw the map (WebGL is off), so the demo can't run here.");

  const [tab, setTab] = useState("route");
  const tabRef = useRef(tab);
  tabRef.current = tab;

  // spoofed position (null = the iPhone uses its real GPS)
  const pos = useRef(START);
  const motion = useRef({ speed: 0, heading: 0 });
  const [spoofing, setSpoofing] = useState(true);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(0);
  const say = useCallback((text, kind = "info") => {
    clearTimeout(toastTimer.current);
    setToast({ text, kind, id: Date.now() });
    toastTimer.current = setTimeout(() => setToast(null), 3600);
  }, []);

  // teleport
  const [picked, setPicked] = useState(null);
  const [coordText, setCoordText] = useState("");
  const [coordErr, setCoordErr] = useState("");

  // route
  const [cps, setCps] = useState([]);
  const cpsRef = useRef(cps);
  cpsRef.current = cps;
  const [mode, setMode] = useState("car");
  const [kmh, setKmh] = useState(50);
  const [corners, setCorners] = useState(true);
  const [build, setBuild] = useState({ state: "idle" });
  const buildCtrl = useRef(null);
  const tl = useRef(null);
  const [summary, setSummary] = useState(null);

  // playback
  const [play, setPlay] = useState("idle"); // idle | playing | paused | done
  const playRef = useRef(play);
  playRef.current = play;
  const simT = useRef(0);
  const [mult, setMult] = useState(5);
  const multRef = useRef(mult);
  multRef.current = mult;
  const [follow, setFollow] = useState(true);
  const followRef = useRef(follow);
  followRef.current = follow;
  const seek = useRef(null);
  const timeLbl = useRef(null);
  const hudSpeed = useRef(null);
  const hudHead = useRef(null);
  const hudArrow = useRef(null);
  const [hudOn, setHudOn] = useState(false);

  // joystick
  const [joyKmh, setJoyKmh] = useState(5);
  const joyKmhRef = useRef(joyKmh);
  joyKmhRef.current = joyKmh;
  const joyKeys = useRef(new Set());
  const joyPad = useRef(null); // bearing from the on-screen pad
  const [joyActive, setJoyActive] = useState(false);
  const inView = useRef(false);
  const root = useRef(null);

  // ---------- map drawing ----------
  const placeMarker = useCallback(() => {
    const m = marks.current.pos;
    if (!m) return;
    if (pos.current) {
      m.setLngLat(ll(pos.current));
      m.getElement().style.display = "";
      m.getElement().querySelector(".pm-arrow").style.transform = `rotate(${motion.current.heading}deg)`;
    } else {
      m.getElement().style.display = "none";
    }
  }, []);

  const drawOverlay = useCallback(() => {
    const m = map.current;
    if (!m || !m.isStyleLoaded()) return;
    const empty = { type: "FeatureCollection", features: [] };
    const route = overlay.current.route;
    if (!m.getSource("route")) {
      m.addSource("route", { type: "geojson", data: empty, lineMetrics: true });
      m.addSource("jump", { type: "geojson", data: empty });
      m.addLayer({ id: "route-casing", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#0b0c0e", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 5, 16, 11], "line-opacity": 0.85 } });
      m.addLayer({ id: "route-line", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 16, 6.5], "line-color": "#10b981" } });
      m.addLayer({ id: "jump-line", type: "line", source: "jump",
        paint: { "line-color": "#10b981", "line-width": 2, "line-dasharray": [1.5, 1.5], "line-opacity": 0.9 } });
    }
    m.getSource("route").setData(route ? { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: route } } : empty);
    if (overlay.current.gradient) m.setPaintProperty("route-line", "line-gradient", overlay.current.gradient);
    const jump = overlay.current.jump;
    m.getSource("jump").setData(jump ? { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: jump } } : empty);
  }, []);

  const setRouteOverlay = useCallback((coords, gradient) => {
    overlay.current.route = coords;
    overlay.current.gradient = gradient;
    const m = map.current;
    if (m && m.isStyleLoaded() && m.getLayer("route-line") && !gradient) {
      // line-gradient can't be removed by setting null on some versions; redraw the layer plainly
      m.removeLayer("route-line");
      m.addLayer({ id: "route-line", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 16, 6.5], "line-color": "#10b981" } }, "jump-line");
    }
    drawOverlay();
  }, [drawOverlay]);

  // ---------- map setup ----------
  useEffect(() => {
    if (mapError || !mapBox.current) return undefined;
    let m;
    try {
      m = new maplibregl.Map({
        container: mapBox.current,
        style: STYLE,
        center: ll(START),
        zoom: MAP_START.zoom,
        attributionControl: { compact: true },
        cooperativeGestures: true,
        pixelRatio: Math.min(window.devicePixelRatio || 1, 2), // 3x screens draw a third fewer pixels
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
      });
    } catch {
      setMapError("The map couldn't start in this browser.");
      return undefined;
    }
    map.current = m;
    m.touchZoomRotate.disableRotation();
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    const pm = el("pos-marker", '<span class="pm-pulse"></span><span class="pm-arrow"><svg viewBox="0 0 24 24"><path d="M12 3 19 20l-7-3.6L5 20Z"/></svg></span>');
    marks.current.pos = new maplibregl.Marker({ element: pm, anchor: "center" }).setLngLat(ll(START)).addTo(m);
    const pk = el("pick-marker");
    marks.current.pick = new maplibregl.Marker({ element: pk, anchor: "center" }).setLngLat(ll(START)).addTo(m);
    pk.style.display = "none";

    m.on("style.load", () => { tuneDarkStyle(m); drawOverlay(); });
    m.on("load", () => setReady(true));
    m.on("error", (e) => {
      if (String(e?.error?.message || "").includes("Failed to fetch")) setMapError("The map tiles couldn't be loaded. Check your connection and reload.");
    });
    m.on("dragstart", () => { if (playRef.current === "playing") setFollow(false); });
    m.on("click", (e) => {
      const p = [e.lngLat.lat, e.lngLat.lng];
      if (tabRef.current === "teleport") setPicked(p);
      else if (tabRef.current === "route") addCheckpoint(p);
    });
    m.on("contextmenu", (e) => {
      e.preventDefault?.();
      teleportTo([e.lngLat.lat, e.lngLat.lng], true);
    });
    return () => { m.remove(); map.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapError]);

  // ---------- picked point ----------
  useEffect(() => {
    const pk = marks.current.pick;
    if (!pk) return;
    if (picked) { pk.setLngLat(ll(picked)); pk.getElement().style.display = ""; }
    else pk.getElement().style.display = "none";
  }, [picked, ready]);

  // ---------- checkpoints ----------
  const invalidate = useCallback(() => {
    buildCtrl.current?.abort();
    tl.current = null;
    setSummary(null);
    setBuild({ state: "idle" });
    setPlay("idle");
    setHudOn(false);
    setRouteOverlay(null, null);
  }, [setRouteOverlay]);

  const addCheckpoint = useCallback((p) => {
    if (cpsRef.current.length >= MAX_CP) { say(`The demo takes up to ${MAX_CP} checkpoints. The app has no such limit.`); return; }
    setCps((list) => [...list, { id: Math.random().toString(36).slice(2), p }]);
    invalidate();
  }, [invalidate, say]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const live = cpMarks.current;
    const ids = new Set(cps.map((c) => c.id));
    for (const [id, mk] of live) if (!ids.has(id)) { mk.remove(); live.delete(id); }
    cps.forEach((c, i) => {
      let mk = live.get(c.id);
      if (!mk) {
        const d = el("cp-marker");
        mk = new maplibregl.Marker({ element: d, draggable: true, anchor: "center" }).setLngLat(ll(c.p)).addTo(m);
        mk.on("dragend", () => {
          const at = mk.getLngLat();
          setCps((list) => list.map((x) => (x.id === c.id ? { ...x, p: [at.lat, at.lng] } : x)));
          invalidate();
        });
        d.addEventListener("click", (e) => e.stopPropagation());
        d.addEventListener("dblclick", (e) => {
          e.stopPropagation();
          setCps((list) => list.filter((x) => x.id !== c.id));
          invalidate();
        });
        live.set(c.id, mk);
      }
      mk.setLngLat(ll(c.p));
      const d = mk.getElement();
      d.textContent = String(i + 1);
      d.classList.toggle("end", i === cps.length - 1 && cps.length > 1);
      d.title = "Drag to move · double-click to delete";
    });
  }, [cps, ready, invalidate]);

  // ---------- teleport ----------
  const teleportTo = useCallback((p, instant = false) => {
    stopPlayback();
    const from = pos.current;
    const jump = from ? distance(from, p) : 0;
    overlay.current.jump = from ? [ll(from), ll(p)] : null;
    drawOverlay();
    const m = map.current;
    const done = () => {
      pos.current = p;
      motion.current = { speed: 0, heading: from ? bearing(from, p) : 0 };
      setSpoofing(true);
      placeMarker();
      setTimeout(() => { overlay.current.jump = null; drawOverlay(); }, 1400);
    };
    if (instant || !from || jump > 50000) {
      done();
      if (m && jump > 2000) m.flyTo({ center: ll(p), zoom: Math.max(m.getZoom(), 13), speed: 1.6 });
    } else {
      const t0 = performance.now();
      const step = (now) => {
        const f = Math.min(1, (now - t0) / 520);
        const e = 1 - Math.pow(1 - f, 3);
        pos.current = [from[0] + (p[0] - from[0]) * e, from[1] + (p[1] - from[1]) * e];
        placeMarker();
        if (f < 1) requestAnimationFrame(step); else done();
      };
      requestAnimationFrame(step);
    }
    say(from ? `Location set. Jumped ${fmtDist(jump)}.` : "Location set.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawOverlay, placeMarker, say]);

  const showCoords = (e) => {
    e.preventDefault();
    const p = parseCoords(coordText);
    if (!p) { setCoordErr("Use decimal degrees, like 48.8584, 2.2945"); return; }
    setCoordErr("");
    setPicked(p);
    map.current?.flyTo({ center: ll(p), zoom: 15, speed: 1.6 });
  };

  const goPlace = ([, lat, lon]) => {
    setPicked([lat, lon]);
    map.current?.flyTo({ center: [lon, lat], zoom: 15, speed: 1.8 });
  };

  const stopSpoofing = () => {
    stopPlayback();
    joyKeys.current.clear();
    joyPad.current = null;
    pos.current = null;
    setSpoofing(false);
    setHudOn(false);
    placeMarker();
    say("The iPhone is back on its real GPS.");
  };

  // ---------- route building ----------
  const runBuild = useCallback(async () => {
    const list = cpsRef.current;
    if (list.length < 2) return;
    buildCtrl.current?.abort();
    const ctrl = new AbortController();
    buildCtrl.current = ctrl;
    stopPlayback();
    const n = list.length - 1;
    const legs = [];
    let fellBack = false;
    try {
      for (let i = 0; i < n; i++) {
        setBuild({ state: "building", step: mode === "straight" ? `Leg ${i + 1} of ${n}` : `Routing leg ${i + 1} of ${n}`, progress: (i / n) * 0.85 });
        let pts;
        try {
          pts = await routeLeg(list[i].p, list[i + 1].p, mode, ctrl.signal);
        } catch (err) {
          if (err.name === "AbortError") throw err;
          pts = [list[i].p, list[i + 1].p];
          fellBack = true;
        }
        legs.push({ points: pts, kmh, mode });
      }
      setBuild({ state: "building", step: corners ? "Speeds and bends" : "Speeds", progress: 0.93 });
      await new Promise((r) => requestAnimationFrame(() => r()));
      if (ctrl.signal.aborted) return;
      const t = buildTimeline(legs, { corners });
      tl.current = t;
      const coords = [];
      legs.forEach((lg, i) => lg.points.forEach((p, j) => { if (i === 0 || j > 0) coords.push(ll(p)); }));
      setRouteOverlay(coords, gradientFor(t));
      const slowed = t.turns.filter((x) => x.slowed);
      const sharpest = slowed.reduce((a, b) => (!a || b.kmh < a.kmh ? b : a), null);
      setSummary({ distance: t.distance, duration: t.duration, bends: slowed.length, sharpest, top: Math.max(...t.v) * 3.6 });
      setBuild({ state: "built", note: fellBack ? "The routing server didn't answer for some legs, so they are straight lines." : "" });
      simT.current = 0;
      setPlay("paused");
      const b = new maplibregl.LngLatBounds();
      coords.forEach((c) => b.extend(c));
      map.current?.fitBounds(b, { padding: 70, maxZoom: 16, duration: 900 });
      renderAt(0);
    } catch (err) {
      if (err.name === "AbortError") { setBuild({ state: "idle" }); return; }
      setBuild({ state: "error", note: err.message || "The route couldn't be built." });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, kmh, corners, setRouteOverlay]);

  const cancelBuild = () => { buildCtrl.current?.abort(); setBuild({ state: "idle" }); };

  const loadPreset = (pr) => {
    stopPlayback();
    setMode(pr.mode);
    setKmh(pr.kmh);
    setCps(pr.pts.map((p) => ({ id: Math.random().toString(36).slice(2), p })));
    invalidate();
    pendingBuild.current = true;
  };
  const pendingBuild = useRef(false);
  useEffect(() => {
    if (pendingBuild.current && cps.length >= 2) { pendingBuild.current = false; runBuild(); }
  }, [cps, runBuild]);

  // settings changes make a built route out of date
  const firstSettings = useRef(true);
  useEffect(() => {
    if (firstSettings.current) { firstSettings.current = false; return; }
    if (!pendingBuild.current && tl.current) invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, kmh, corners]);

  // ---------- playback ----------
  const renderAt = useCallback((t) => {
    const timeline = tl.current;
    if (!timeline) return;
    const s = sampleAt(timeline, t);
    pos.current = s.pos;
    motion.current = { speed: s.speed, heading: s.heading };
    placeMarker();
    if (hudSpeed.current) hudSpeed.current.textContent = (s.speed * 3.6).toFixed(s.speed * 3.6 < 10 ? 1 : 0);
    if (hudHead.current) hudHead.current.textContent = `${Math.round(s.heading)}° ${compass(s.heading)}`;
    if (hudArrow.current) hudArrow.current.style.transform = `rotate(${s.heading}deg)`;
    if (seek.current) {
      seek.current.value = String(t);
      seek.current.style.setProperty("--p", `${(t / timeline.duration) * 100}%`);
    }
    if (timeLbl.current) timeLbl.current.textContent = `${fmtTime(t)} / ${fmtTime(timeline.duration)} · ${fmtDist(s.s)}`;
    if (followRef.current && playRef.current === "playing" && map.current) map.current.jumpTo({ center: ll(s.pos) });
  }, [placeMarker]);

  const stopPlayback = useCallback(() => {
    if (playRef.current === "playing" || playRef.current === "done") setPlay(tl.current ? "paused" : "idle");
  }, []);

  useEffect(() => {
    if (play !== "playing") return undefined;
    setSpoofing(true);
    setHudOn(true);
    let raf = 0;
    let last = performance.now();
    const loop = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const timeline = tl.current;
      if (!timeline) return;
      simT.current = Math.min(timeline.duration, simT.current + dt * multRef.current);
      renderAt(simT.current);
      if (simT.current >= timeline.duration) { setPlay("done"); return; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [play, renderAt]);

  const togglePlay = () => {
    if (!tl.current) return;
    if (play === "playing") { setPlay("paused"); return; }
    if (play === "done") simT.current = 0;
    setFollow(true);
    setPlay("playing");
  };
  const stopRoute = () => { setPlay("paused"); simT.current = 0; renderAt(0); };

  // ---------- joystick ----------
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => { inView.current = e.intersectionRatio > 0.45; }, { threshold: [0, 0.45, 1] });
    if (root.current) io.observe(root.current);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (tab !== "joystick") return undefined;
    const typing = (t) => t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA");
    const down = (e) => {
      if (!KEYS[e.code] || !inView.current || typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      joyKeys.current.add(e.code);
      setJoyActive(true);
    };
    const up = (e) => { if (KEYS[e.code]) joyKeys.current.delete(e.code); };
    const blur = () => joyKeys.current.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", blur); };
  }, [tab]);

  useEffect(() => {
    if (!joyActive) return undefined;
    stopPlayback();
    setHudOn(true);
    if (!pos.current) { pos.current = map.current ? (({ lat, lng }) => [lat, lng])(map.current.getCenter()) : START; setSpoofing(true); }
    let raf = 0;
    let last = performance.now();
    let v = 0;
    let head = motion.current.heading || 0;
    const loop = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      let x = 0, y = 0;
      joyKeys.current.forEach((k) => { x += KEYS[k][0]; y += KEYS[k][1]; });
      let want = 0;
      if (joyPad.current !== null) { head = joyPad.current; want = joyKmhRef.current / 3.6; }
      else if (x || y) { head = (Math.atan2(x, y) * 180 / Math.PI + 360) % 360; want = joyKmhRef.current / 3.6; }
      const a = 3; // m/s^2, so it eases in and out
      v = want > v ? Math.min(want, v + a * dt) : Math.max(want, v - a * dt);
      if (v > 0 && pos.current) pos.current = destination(pos.current, head, v * dt);
      motion.current = { speed: v, heading: head };
      placeMarker();
      if (hudSpeed.current) hudSpeed.current.textContent = (v * 3.6).toFixed(v * 3.6 < 10 ? 1 : 0);
      if (hudHead.current) hudHead.current.textContent = `${Math.round(head)}° ${compass(head)}`;
      if (hudArrow.current) hudArrow.current.style.transform = `rotate(${head}deg)`;
      if (v > 0 && map.current && pos.current) map.current.jumpTo({ center: ll(pos.current) });
      if (v === 0 && want === 0) { setJoyActive(false); return; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [joyActive, placeMarker, stopPlayback]);

  const padDown = (b) => (e) => { e.preventDefault(); e.currentTarget.setPointerCapture?.(e.pointerId); joyPad.current = b; setJoyActive(true); };
  const padUp = () => { joyPad.current = null; };

  // Esc cancels a build, like the app
  useEffect(() => {
    const on = (e) => { if (e.key === "Escape" && build.state === "building") cancelBuild(); };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [build.state]);

  const hint = useMemo(() => ({
    teleport: "Click to pick a point · right-click to jump there",
    route: cps.length >= MAX_CP ? "Up to 8 checkpoints in the demo" : "Click to add checkpoints · drag to move · double-click to delete",
    joystick: "W A S D or the arrow keys · or hold the pad",
  }[tab]), [tab, cps.length]);

  const jumpDist = picked && pos.current ? distance(pos.current, picked) : null;

  return (
    <div className="sim" ref={root}>
      <aside className="sim-panel" aria-label="Demo controls">
        <div className="sim-tabs" role="tablist" aria-label="Tool">
          {[["teleport", "Teleport", "pin"], ["route", "Route", "route"], ["joystick", "Joystick", "joystick"]].map(([k, label, icon]) => (
            <button key={k} role="tab" type="button" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
              <Icon name={icon} /> {label}
            </button>
          ))}
        </div>

        {tab === "teleport" && (
          <div className="sim-body" role="tabpanel">
            <form className="field" onSubmit={showCoords}>
              <label htmlFor="sim-coords" className="field-label">Coordinates</label>
              <div className="field-row">
                <input id="sim-coords" className="input mono" placeholder="48.8584, 2.2945" value={coordText}
                  onChange={(e) => setCoordText(e.target.value)} aria-invalid={!!coordErr} aria-describedby="sim-coords-err" autoComplete="off" />
                <button className="btn btn-quiet btn-sm" type="submit">Show</button>
              </div>
              <p id="sim-coords-err" className="field-err" role="status">{coordErr}</p>
            </form>
            <div className="chips" aria-label="Places">
              {PLACES.map((pl) => <button key={pl[0]} type="button" className="chip" onClick={() => goPlace(pl)}>{pl[0]}</button>)}
            </div>
            <div className="picked">
              <span className="field-label">Picked point</span>
              {picked ? (
                <>
                  <div className="mono tnum picked-coords">{fmtCoord(picked[0])}, {fmtCoord(picked[1])}</div>
                  <div className="muted small">{jumpDist !== null ? `${fmtDist(jumpDist)} from the current position` : "The iPhone is on its real GPS"}</div>
                </>
              ) : <div className="muted small">Click the map, or pick a place above.</div>}
              <button className="btn btn-primary" type="button" disabled={!picked} onClick={() => teleportTo(picked)}>
                <Icon name="pin" /> Teleport here
              </button>
            </div>
          </div>
        )}

        {tab === "route" && (
          <div className="sim-body" role="tabpanel">
            <div className="field-grid">
              <label className="field">
                <span className="field-label">Follow</span>
                <select className="input" value={mode} onChange={(e) => { const md = MODES.find((x) => x.key === e.target.value); setMode(md.key); setKmh(md.kmh); }}>
                  {MODES.map((md) => <option key={md.key} value={md.key}>{md.label}</option>)}
                </select>
              </label>
              <label className="field">
                <span className="field-label">Speed (km/h)</span>
                <input className="input mono" type="number" min="1" max="300" step="1" value={kmh}
                  onChange={(e) => setKmh(Math.min(300, Math.max(1, Number(e.target.value) || 1)))} />
              </label>
            </div>
            <label className="check">
              <input type="checkbox" checked={corners} onChange={(e) => setCorners(e.target.checked)} />
              <span>Slow down for bends</span>
            </label>
            <div className="cp-list">
              <div className="cp-head"><span className="field-label">Checkpoints</span><span className="muted small mono">{cps.length} / {MAX_CP}</span></div>
              {cps.length === 0 ? (
                <p className="muted small">Click the map to add them, or load an example:</p>
              ) : (
                <ol>
                  {cps.map((c, i) => (
                    <li key={c.id}>
                      <span className="cp-n">{i + 1}</span>
                      <span className="mono tnum">{c.p[0].toFixed(4)}, {c.p[1].toFixed(4)}</span>
                      <button type="button" className="x" aria-label={`Delete checkpoint ${i + 1}`}
                        onClick={() => { setCps((l) => l.filter((x) => x.id !== c.id)); invalidate(); }}><Icon name="x" /></button>
                    </li>
                  ))}
                </ol>
              )}
              <div className="chips">
                {PRESETS.map((pr) => <button key={pr.name} type="button" className="chip" onClick={() => loadPreset(pr)}>{pr.name}</button>)}
              </div>
            </div>
            {build.state === "building" ? (
              <div className="build-progress" role="status">
                <div className="bp-bar"><span style={{ width: `${Math.round(build.progress * 100)}%` }} /></div>
                <div className="bp-row"><span>{build.step}…</span><button type="button" className="text-link" onClick={cancelBuild}>Cancel</button></div>
              </div>
            ) : (
              <div className="btn-row">
                <button className="btn btn-primary grow" type="button" disabled={cps.length < 2} onClick={runBuild}>
                  <Icon name="route" /> {build.state === "built" ? "Rebuild route" : "Build route"}
                </button>
                <button className="btn btn-quiet" type="button" disabled={!cps.length}
                  onClick={() => { setCps([]); invalidate(); }}>Clear</button>
              </div>
            )}
            {build.note && <p className={`note ${build.state === "error" ? "err" : ""}`}>{build.note}</p>}
            {summary && (
              <dl className="summary mono">
                <div><dt>Distance</dt><dd className="tnum">{fmtDist(summary.distance)}</dd></div>
                <div><dt>Time</dt><dd className="tnum">{fmtTime(summary.duration)}</dd></div>
                <div><dt>Bends slowed</dt><dd className="tnum">{summary.bends}</dd></div>
                <div><dt>Slowest bend</dt><dd className="tnum">{summary.sharpest ? `${Math.abs(summary.sharpest.angle).toFixed(0)}° at ${summary.sharpest.kmh.toFixed(0)} km/h` : "–"}</dd></div>
              </dl>
            )}
          </div>
        )}

        {tab === "joystick" && (
          <div className="sim-body" role="tabpanel">
            <div className="field">
              <span className="field-label">Speed</span>
              <div className="seg">
                {JOY_SPEEDS.map(([label, v]) => (
                  <button key={label} type="button" className={joyKmh === v ? "on" : ""} aria-pressed={joyKmh === v} onClick={() => setJoyKmh(v)}>
                    {label} <span className="mono small">{v}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="dpad" onPointerUp={padUp} onPointerCancel={padUp} onPointerLeave={padUp}>
              {[315, 0, 45, 270, null, 90, 225, 180, 135].map((b, i) => b === null ? (
                <button key={i} type="button" className="dp-stop" aria-label="Stop" onClick={() => { joyPad.current = null; joyKeys.current.clear(); }}>
                  <Icon name="stop" fill />
                </button>
              ) : (
                <button key={i} type="button" aria-label={`Move ${compass(b)}`} onPointerDown={padDown(b)} onPointerUp={padUp}>
                  <svg viewBox="0 0 24 24" style={{ transform: `rotate(${b}deg)` }} aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
                </button>
              ))}
            </div>
            <p className="muted small">Keys work while this demo is on screen. Moves at {joyKmh} km/h, easing in and out.</p>
          </div>
        )}
      </aside>

      <div className="sim-map">
        <div ref={mapBox} className="map-box" aria-label="Demo map" role="region" />
        {mapError && <div className="map-error"><p>{mapError}</p></div>}
        {!mapError && <div className="map-hint mono">{hint}</div>}
        {hudOn && (
          <div className="map-hud mono" aria-hidden="true">
            <div><span className="v tnum" ref={hudSpeed}>0.0</span><span className="u">km/h</span></div>
            <div className="hd"><span className="arrow" ref={hudArrow}><svg viewBox="0 0 24 24"><path d="M12 3 19 20l-7-3.6L5 20Z" /></svg></span><span ref={hudHead}>0° N</span></div>
          </div>
        )}
        {tl.current && tab === "route" && (
          <div className="player">
            <button type="button" className="icon-btn solid" onClick={togglePlay} aria-label={play === "playing" ? "Pause" : "Play"}>
              <Icon name={play === "playing" ? "pause" : "play"} fill />
            </button>
            <button type="button" className="icon-btn" onClick={stopRoute} aria-label="Back to the start"><Icon name="stop" fill /></button>
            <div className="seek-wrap">
              <input ref={seek} className="seek" type="range" min="0" max={tl.current.duration} step="0.01" defaultValue="0" aria-label="Position along the route"
                onInput={(e) => { simT.current = Number(e.target.value); setHudOn(true); renderAt(simT.current); }} />
              <span className="time mono tnum" ref={timeLbl}>0:00 / {fmtTime(tl.current.duration)}</span>
            </div>
            <select className="input mono mult" value={mult} onChange={(e) => setMult(Number(e.target.value))} aria-label="Playback speed">
              {MULTS.map((x) => <option key={x} value={x}>{x}×</option>)}
            </select>
            <label className="check follow"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /><span>Follow</span></label>
          </div>
        )}
        {summary && tab === "route" && (
          <div className="legend mono" aria-hidden="true">
            <span>0</span><span className="ramp" /><span>{summary.top.toFixed(0)} km/h</span>
          </div>
        )}
        {toast && <div key={toast.id} className={`sim-toast ${toast.kind}`} role="status">{toast.text}</div>}
      </div>

      <DevicePanel pos={pos} spoofing={spoofing} onStop={stopSpoofing} />
    </div>
  );
}

// The iPhone side: it receives a position about once a second, and nothing else.
function DevicePanel({ pos, spoofing, onStop }) {
  const [snap, setSnap] = useState(() => pos.current);
  const [age, setAge] = useState(0);
  const last = useRef(null);
  useEffect(() => {
    const id = setInterval(() => {
      const p = pos.current;
      const changed = !last.current !== !p || (p && last.current && (p[0] !== last.current[0] || p[1] !== last.current[1]));
      if (changed) { last.current = p ? [...p] : null; setSnap(p ? [...p] : null); setAge(0); }
      else setAge((a) => a + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [pos]);
  return (
    <aside className="sim-device" aria-label="Simulated iPhone">
      <div className="phone">
        <div className="phone-screen">
          <div className="ph-status mono"><span>9:41</span><span className="ph-isle" /><span>USB</span></div>
          <div className={`ph-state ${spoofing && snap ? "on" : ""}`}>
            <Icon name="nav" fill />
            <span>{spoofing && snap ? "Simulated location" : "Real GPS"}</span>
          </div>
          <div className="ph-coords mono tnum" key={snap ? `${snap[0]}${snap[1]}` : "real"}>
            {spoofing && snap ? (<><div>{fmtCoord(snap[0])}</div><div>{fmtCoord(snap[1])}</div></>) : (<><div>—</div><div>—</div></>)}
          </div>
          <div className="ph-meta mono">{spoofing && snap ? (age === 0 ? "updated just now" : `unchanged for ${age} s`) : "no simulation"}</div>
          <dl className="ph-rows mono">
            <div><dt>Speed</dt><dd>not sent</dd></div>
            <div><dt>Course</dt><dd>not sent</dd></div>
          </dl>
        </div>
      </div>
      <p className="ph-note">iOS receives the position only. Navigation apps and games work out speed from the movement.</p>
      <button type="button" className="btn btn-ghost btn-sm" disabled={!spoofing} onClick={onStop}>
        <Icon name="crosshair" /> Stop spoofing
      </button>
    </aside>
  );
}
