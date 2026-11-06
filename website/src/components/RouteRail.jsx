import { useEffect, useRef, useState } from "react";
import { onScroll, scrollToId } from "../lib/motion.js";

// The page drawn as a route: one checkpoint per section, a position marker at your scroll position,
// and a live readout of how fast you are scrolling, in the app's own HUD style
// (1 px = 1 cm, so a brisk flick is about 50 km/h). Wide screens only; decorative for the HUD.
const STOPS = [
  ["top", "Start"],
  ["features", "Features"],
  ["engine", "Speed engine"],
  ["simulator", "Try it"],
  ["install", "Install"],
  ["faq", "FAQ"],
];

export default function RouteRail() {
  const [stops, setStops] = useState([]);
  const [active, setActive] = useState(0);
  const fill = useRef(null);
  const dot = useRef(null);
  const speed = useRef(null);
  const head = useRef(null);
  const odo = useRef(null);
  const stopsRef = useRef(stops);
  stopsRef.current = stops;

  useEffect(() => {
    const measure = () => {
      const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      setStops(
        STOPS.map(([id, label]) => {
          const el = document.getElementById(id);
          const y = el ? el.getBoundingClientRect().top + window.scrollY - 60 : 0;
          return { id, label, f: Math.min(1, Math.max(0, y / max)) };
        })
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let shown = 0;
    let target = 0;
    let raf = 0;
    let dir = 1;
    const tick = () => {
      shown += (target - shown) * 0.12;
      if (Math.abs(target - shown) < 0.05) shown = target;
      if (speed.current) speed.current.textContent = shown.toFixed(shown < 10 ? 1 : 0);
      raf = shown === target ? 0 : requestAnimationFrame(tick);
    };
    const off = onScroll(({ scroll, velocity, direction }) => {
      const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      const f = Math.min(1, Math.max(0, scroll / max));
      if (fill.current) fill.current.style.transform = `scaleY(${f})`;
      if (dot.current) dot.current.style.top = `${f * 100}%`;
      if (direction) dir = direction;
      if (head.current) head.current.textContent = dir > 0 ? "180° S" : "0° N";
      if (dot.current) dot.current.style.rotate = dir > 0 ? "180deg" : "0deg";
      if (odo.current) odo.current.textContent = (scroll / 100).toFixed(0);
      target = Math.min(999, (Math.abs(velocity) / 100) * 3.6);
      if (!raf) raf = requestAnimationFrame(tick);
      setActive((prev) => {
        let idx = 0;
        stopsRef.current.forEach((s, i) => { if (f + 0.002 >= s.f) idx = i; });
        return idx === prev ? prev : idx;
      });
    });
    return () => { off(); cancelAnimationFrame(raf); };
  }, []);

  return (
    <aside className="rail" aria-label="Page outline">
      <div className="rail-track">
        <div className="rail-fill" ref={fill} />
        {stops.map((s, i) => (
          <button
            key={s.id}
            type="button"
            className={`rail-stop${i <= active ? " passed" : ""}${i === active ? " current" : ""}`}
            style={{ top: `${s.f * 100}%` }}
            onClick={() => scrollToId(s.id)}
            aria-label={`Go to ${s.label}`}
          >
            <span className="rail-label">{s.label}</span>
          </button>
        ))}
        <div className="rail-dot" ref={dot} aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M12 3 19 20l-7-3.6L5 20Z" /></svg>
        </div>
      </div>
      <div className="rail-hud mono" aria-hidden="true">
        <div><span className="v tnum" ref={speed}>0.0</span><span className="u">km/h</span></div>
        <div className="row"><span ref={head}>180° S</span><span><span className="tnum" ref={odo}>0</span> m</span></div>
        <div className="cap">scroll speed</div>
      </div>
    </aside>
  );
}
