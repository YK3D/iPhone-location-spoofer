import { useEffect, useId, useMemo, useRef, useState } from "react";
import { VEHICLES, drivenRadius, turnSpeed } from "../sim/engine.js";
import { gsap, prefersReducedMotion, whenIdle } from "../lib/motion.js";

const VEH = [
  { key: "car", label: "Car", road: 50, width: 7 },
  { key: "bike", label: "Bike", road: 20, width: 2.5 },
  { key: "foot", label: "Walk", road: 5, width: 2 },
  { key: "sea", label: "Boat", road: 30, width: 40 },
];
const RAD = Math.PI / 180;
const ROOM = 150; // metres of straight road either side of the bend

function compute({ veh, angle, drawn, drawnR, roadKmh }) {
  const v = VEHICLES[veh];
  const vRef = roadKmh / 3.6;
  const length = drawn === "curve" ? drawnR * angle * RAD : 0;
  const r = drivenRadius(v, angle, length, vRef, ROOM);
  const vTurn = turnSpeed(v, r);
  const speed = Math.min(vTurn, vRef);
  return { r, speed, slowed: vTurn < vRef - 1e-9, aLat: (speed * speed) / r, length };
}

const niceStep = (x) => {
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  return steps.find((s) => s >= x) || 1000;
};

// The bend in metres, then fitted into the drawing. The vehicle drives exactly along the road's centre
// line, as in the app (positions always follow the route geometry); the wider arc a driver would cut
// through the corner is only used to plan the speed, so it is reported in the readout, not drawn.
function geometry({ angle, drawn, drawnR, width }) {
  const th = Math.min(angle, 170) * RAD;
  const uIn = [0, -1];
  const uOut = [Math.sin(th), -Math.cos(th)];
  const tDrawn = drawn === "curve" ? drawnR * Math.tan(th / 2) : 0;
  const L = Math.max(tDrawn * 1.6, width * 4, 14);
  const C = [0, 0];
  const at = (p, u, k) => [p[0] + u[0] * k, p[1] + u[1] * k];
  const A = at(C, uIn, -L);
  const B = at(C, uOut, L);
  const arcPts = (t, rad) => {
    const P1 = at(C, uIn, -t);
    const O = [P1[0] + rad, P1[1]]; // centre is to the right of the incoming direction
    const pts = [];
    for (let i = 0; i <= 32; i++) {
      const a = Math.PI + (th * i) / 32; // starts pointing west of the centre
      pts.push([O[0] + rad * Math.cos(a), O[1] + rad * Math.sin(a)]);
    }
    return pts;
  };
  const centre = drawn === "curve" ? arcPts(tDrawn, drawnR) : [C];
  // bounds of the whole road band (round joins, so nothing pokes out past half the width)
  const all = [A, B, ...centre];
  const pad = width / 2 + 1.5;
  const minX = Math.min(...all.map((p) => p[0])) - pad, maxX = Math.max(...all.map((p) => p[0])) + pad;
  const minY = Math.min(...all.map((p) => p[1])) - pad, maxY = Math.max(...all.map((p) => p[1])) + pad;
  const VW = 420, VH = 320, M = 26;
  const s = Math.min((VW - 2 * M) / (maxX - minX), (VH - 2 * M - 22) / (maxY - minY)); // 22 px kept for the scale bar
  const ox = (VW - (maxX - minX) * s) / 2 - minX * s;
  const oy = (VH - 22 - (maxY - minY) * s) / 2 - minY * s;
  const X = (p) => `${(p[0] * s + ox).toFixed(1)} ${(p[1] * s + oy).toFixed(1)}`;
  const road = `M${X(A)} L${centre.map(X).join(" L")} L${X(B)}`;
  const len = drawn === "curve" ? 2 * L - 2 * tDrawn + drawnR * th : 2 * L; // metres along the centre line
  const bar = niceStep(70 / s);
  return { road, s, width, VW, VH, bar, barPx: bar * s, len };
}

function Segmented({ label, value, options, onChange }) {
  const id = useId();
  return (
    <div className="seg-field" role="radiogroup" aria-labelledby={id}>
      <span className="field-label" id={id}>{label}</span>
      <div className="seg">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            className={value === o.value ? "on" : ""}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Slider({ label, value, min, max, step = 1, unit, onChange, format = (v) => v }) {
  const id = useId();
  return (
    <div className="slider-field">
      <label htmlFor={id} className="field-label">
        {label} <output className="mono tnum">{format(value)}{unit === "°" ? "" : " "}{unit}</output>
      </label>
      <input id={id} type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ "--p": `${((value - min) / (max - min)) * 100}%` }} />
    </div>
  );
}

export default function Engine() {
  const [veh, setVeh] = useState("car");
  const [angle, setAngle] = useState(90);
  const [drawn, setDrawn] = useState("junction");
  const [drawnR, setDrawnR] = useState(60);
  const [roadKmh, setRoadKmh] = useState(50);
  const root = useRef(null);
  const vdef = VEH.find((v) => v.key === veh);
  const res = useMemo(() => compute({ veh, angle, drawn, drawnR, roadKmh }), [veh, angle, drawn, drawnR, roadKmh]);
  const geo = useMemo(() => geometry({ angle, drawn, drawnR, width: vdef.width }), [angle, drawn, drawnR, vdef.width]);
  const examples = useMemo(() => {
    const car = VEHICLES.car;
    const j = (kmh) => turnSpeed(car, drivenRadius(car, 90, 0, kmh / 3.6, ROOM)) * 3.6;
    return [
      ["90° junction, 50 km/h road", j(50)],
      ["90° junction, 30 km/h street", j(30)],
      ["300 m motorway curve", turnSpeed(car, 300) * 3.6],
    ];
  }, []);
  const kmh = res.speed * 3.6;
  const dur = Math.min(6, Math.max(1.8, geo.len / Math.max(0.5, res.speed) / 3));
  const reduce = prefersReducedMotion();

  useEffect(() => {
    if (reduce) return undefined;
    return whenIdle(() => gsap.context(() => {
      gsap.from(".lab", { y: 28, opacity: 0, duration: 0.6, ease: "power3.out", scrollTrigger: { trigger: ".lab", start: "top 82%", once: true } });
      gsap.from(".lab-examples li", { y: 12, opacity: 0, duration: 0.45, stagger: 0.05, ease: "power3.out", scrollTrigger: { trigger: ".lab-examples", start: "top 92%", once: true } });
    }, root));
  }, [reduce]);

  return (
    <section className="section band engine" id="engine" ref={root}>
      <div className="container">
        <header className="sec-head">
          <p className="kicker"><span className="idx">05</span> Speed engine</p>
          <h2>It slows down for bends, the way a driver would.</h2>
          <p>
            Each bend is taken at the speed its radius allows for the vehicle on that leg, v = √(a·R). A junction that
            the map draws as a sharp corner is rounded the way drivers cut it, and speed changes at a steady
            acceleration and braking rate. These are the app's own numbers, running in your browser.
          </p>
        </header>

        <div className="lab">
          <div className="lab-controls">
            <Segmented label="Vehicle" value={veh} options={VEH.map((v) => ({ value: v.key, label: v.label }))}
              onChange={(k) => { setVeh(k); setRoadKmh(VEH.find((v) => v.key === k).road); }} />
            <Slider label="Turn" value={angle} min={10} max={180} unit="°" onChange={setAngle} />
            <Segmented label="Drawn on the map as" value={drawn}
              options={[{ value: "junction", label: "Sharp corner" }, { value: "curve", label: "A curve" }]} onChange={setDrawn} />
            {drawn === "curve" && (
              <Slider label="Curve radius" value={drawnR} min={5} max={500} step={5} unit="m" onChange={setDrawnR} />
            )}
            <Slider label="Road speed" value={roadKmh} min={veh === "foot" ? 2 : 5} max={veh === "foot" ? 12 : 130} unit="km/h" onChange={setRoadKmh} />
          </div>

          <div className="lab-view">
            <svg viewBox={`0 0 ${geo.VW} ${geo.VH}`} className="lab-svg" role="img"
              aria-label={`A ${angle} degree bend. The vehicle follows the road's centre line at ${kmh.toFixed(0)} km/h.`}>
              <path d={geo.road} className="lab-road" style={{ strokeWidth: Math.max(2, geo.width * geo.s) }} />
              <path d={geo.road} className="lab-centre" />
              <g key={`${geo.road}${dur}`}>
                <path d={geo.road} className="lab-line" pathLength="1" strokeDasharray="1 1" strokeDashoffset={reduce ? 0 : 1}>
                  {!reduce && <animate attributeName="stroke-dashoffset" from="1" to="0" dur={`${dur.toFixed(2)}s`} repeatCount="indefinite" />}
                </path>
                <g className="lab-car">
                  <circle r="11" className="halo" />
                  <circle r="6.5" />
                  {!reduce && <animateMotion dur={`${dur.toFixed(2)}s`} repeatCount="indefinite" path={geo.road} rotate="auto" />}
                </g>
              </g>
              <g className="lab-scale" transform={`translate(${geo.VW - 24 - geo.barPx} ${geo.VH - 18})`}>
                <path d={`M0 -4 V0 H${geo.barPx.toFixed(1)} V-4`} />
                <text x={geo.barPx / 2} y="-8" textAnchor="middle">{geo.bar} m</text>
              </g>
            </svg>
            <div className="lab-readout">
              <div className="lab-speed">
                <span className="mono tnum big">{kmh < 10 ? kmh.toFixed(1) : kmh.toFixed(0)}</span>
                <span className="unit">km/h through the bend</span>
              </div>
              <p className={`lab-verdict ${res.slowed ? "slow" : "ok"}`}>
                {res.slowed ? `Brakes from ${roadKmh} km/h before it, speeds up after it.` : `No need to slow down from ${roadKmh} km/h.`}
              </p>
              <p className="lab-note">The car stays on the road's centre line. Its speed is planned for the wider arc a driver would cut through the bend.</p>
              <dl className="lab-facts mono">
                <div><dt>Arc for speed</dt><dd className="tnum">{res.r.toFixed(1)} m radius</dd></div>
                <div><dt>Sideways accel.</dt><dd className="tnum">{res.aLat.toFixed(2)} m/s²</dd></div>
                <div><dt>v = √(a·R)</dt><dd className="tnum">√({res.aLat.toFixed(2)}×{res.r.toFixed(1)}) = {res.speed.toFixed(2)} m/s</dd></div>
              </dl>
            </div>
          </div>
        </div>

        <ul className="lab-examples">
          {examples.map(([label, v]) => (
            <li key={label}><span>{label}</span><span className="mono tnum">≈ {v.toFixed(0)} km/h</span></li>
          ))}
          <li><span>Roundabouts, by size</span><span className="mono tnum">20–40 km/h</span></li>
        </ul>
      </div>
    </section>
  );
}
