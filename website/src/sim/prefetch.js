// Downloads what the demo map needs for its first view (style, sprite, the label fonts and the vector
// tiles around the starting point) into the browser's HTTP cache, without loading the map library or
// drawing anything. Network only, so it can run while the visitor scrolls; when the map is created
// later, MapLibre finds everything cached and the first view appears almost at once.
export const MAP_STYLE = "https://tiles.openfreemap.org/styles/dark";
export const MAP_START = { center: [51.5007, -0.1246], zoom: 15 };

let started = null;
const get = (url) => fetch(url, { mode: "cors", credentials: "omit" });

export function prefetchMap({ center: [lat, lon], zoom } = MAP_START) {
  if (started) return started;
  started = (async () => {
    const style = await (await get(MAP_STYLE)).json();
    const urls = [];
    const sprite = Array.isArray(style.sprite) ? style.sprite[0]?.url : style.sprite;
    if (sprite) urls.push(`${sprite}.json`, `${sprite}.png`, `${sprite}@2x.json`, `${sprite}@2x.png`);
    if (style.glyphs) {
      const stacks = new Set();
      for (const l of style.layers || []) {
        const f = l.layout && l.layout["text-font"];
        if (Array.isArray(f) && f.every((x) => typeof x === "string")) stacks.add(f.join(","));
      }
      for (const s of stacks) urls.push(style.glyphs.replace("{fontstack}", encodeURIComponent(s)).replace("{range}", "0-255"));
    }
    for (const src of Object.values(style.sources || {})) {
      if (src.type !== "vector" || !src.url) continue;
      const tj = await (await get(src.url)).json();
      const tpl = tj.tiles && tj.tiles[0];
      if (!tpl) continue;
      const z = Math.min(Math.floor(zoom), tj.maxzoom ?? 14);
      const n = 2 ** z;
      const x = Math.floor(((lon + 180) / 360) * n);
      const r = (lat * Math.PI) / 180;
      const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          urls.push(tpl.replace("{z}", z).replace("{x}", (x + dx + n) % n).replace("{y}", y + dy));
        }
      }
    }
    await Promise.all(urls.map((u) => get(u).then((r) => r.arrayBuffer()).catch(() => {})));
  })().catch(() => {});
  return started;
}
