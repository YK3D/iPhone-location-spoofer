// Road routing for the demo, from the same public OSRM servers the app uses by default
// (routing.openstreetmap.de, run by FOSSGIS). Their usage policy asks for at most one request per
// second, so requests are spaced out, and every answer is kept for the rest of the visit.
import { distance } from "./engine.js";

const BASE = {
  car: "https://routing.openstreetmap.de/routed-car",
  bike: "https://routing.openstreetmap.de/routed-bike",
  foot: "https://routing.openstreetmap.de/routed-foot",
};
const cache = new Map();
let nextSlot = 0;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(id); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
  });
}

async function reserve(signal) {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + 1000;
  if (at > now) await sleep(at - now, signal);
}

// One leg from a to b ([lat, lon]); always starts and ends exactly on the checkpoints.
export async function routeLeg(a, b, mode, signal) {
  if (!BASE[mode]) return [a, b];
  const key = `${mode}|${a[0].toFixed(5)},${a[1].toFixed(5)}|${b[0].toFixed(5)},${b[1].toFixed(5)}`;
  if (cache.has(key)) return cache.get(key);
  await reserve(signal);
  const url = `${BASE[mode]}/route/v1/driving/${a[1]},${a[0]};${b[1]},${b[0]}?overview=full&geometries=geojson`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`The routing server answered ${res.status}.`);
  const json = await res.json();
  if (json.code !== "Ok" || !json.routes?.length) throw new Error(json.message || "No route between these points.");
  const pts = json.routes[0].geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  if (distance(pts[0], a) > 1) pts.unshift(a);
  if (distance(pts[pts.length - 1], b) > 1) pts.push(b);
  cache.set(key, pts);
  return pts;
}
