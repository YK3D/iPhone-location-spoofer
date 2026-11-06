import { useEffect, useRef, useState } from "react";
import { onScroll, scrollTargetFor, scrollToId } from "../lib/motion.js";

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
const WIDE = "(min-width: 1360px)";

function Rail() {
  const [stops, setStops] = useState([]);
  const [active, setActive] = useState(0);
  const track = useRef(null);
  const fill = useRef(null);
  const dot = useRef(null);
  const speed = useRef(null);
  const head = useRef(null);
  const odo = useRef(null);
  const stopsRef = useRef(stops);
  stopsRef.current = stops;
  const trackH = useRef(0);

  useEffect(() => {
    let t = 0;
    const measure = () => {
      const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      trackH.current = track.current ? track.current.clientHeight : 0;
      setStops(STOPS.map(([id, label]) => ({ id, label, f: Math.min(1, Math.max(0, scrollTargetFor(id) / max)) })));
    };
    measure();
    const ro = new ResizeObserver(() => { clearTimeout(t); t = setTimeout(measure, 150); });
    ro.observe(document.body);
    return () => { ro.disconnect(); clearTimeout(t); };
  }, []);

  useEffect(() => {
    let shown = 0;
    let target = 0;
    let raf = 0;
    let dir = 1;
    let lastIdx = -1;
    const tick = () => {
      shown += (target - shown) * 0.12;
      if (Math.abs(target - shown) < 0.05) shown = target;
      if (speed.current) speed.current.textContent = shown.toFixed(shown < 10 ? 1 : 0);
      raf = shown === target ? 0 : requestAnimationFrame(tick);
    };
    const off = onScroll(({ scroll, velocity, direction }) => {
      const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      const f = Math.min(1, Math.max(0, scroll / max));
      // transforms only: moving the marker never triggers layout
      if (fill.current) fill.current.style.transform = `scaleY(${f})`;
      if (direction) dir = direction;
      if (dot.current) dot.current.style.transform = `translate3d(0, ${(f * trackH.current).toFixed(1)}px, 0) rotate(${dir > 0 ? 180 : 0}deg)`;
      if (head.current) head.current.textContent = dir > 0 ? "180° S" : "0° N";
      if (odo.current) odo.current.textContent = (scroll / 100).toFixed(0);
      target = Math.min(999, (Math.abs(velocity) / 100) * 3.6);
      if (!raf) raf = requestAnimationFrame(tick);
      let idx = 0;
      stopsRef.current.forEach((s, i) => { if (f + 0.002 >= s.f) idx = i; });
      if (idx !== lastIdx) { lastIdx = idx; setActive(idx); }
    });
    return () => { off(); cancelAnimationFrame(raf); };
  }, []);

  return (
    <aside className="rail" aria-label="Page outline">
      <div className="rail-track" ref={track}>
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

// Only mounted (with its listeners) where there is room for it beside the content.
export default function RouteRail() {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide ? <Rail /> : null;
}
