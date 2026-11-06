import { useEffect, useRef, useState } from "react";
import AppWindow from "../components/AppWindow.jsx";
import Clip from "../components/Clip.jsx";
import { gsap, prefersReducedMotion } from "../lib/motion.js";

const ITEMS = [
  {
    key: "teleport",
    title: "Jump anywhere.",
    clip: "teleport",
    label: "Teleport tab: a point is picked near the Eiffel Tower, then the iPhone is moved there",
    body: "Pick a point and see how far the jump is before you make it. Right-click the map to jump straight away.",
    specs: [
      "Search by name, or paste coordinates as 48.8584, 2.2945 or 40°42′46″N",
      "Paste any Google Maps link, including maps.app.goo.gl short links and directions",
      "Keep favourite places and saved routes, with backup and restore",
    ],
  },
  {
    key: "routes",
    title: "Follow real roads, not straight lines.",
    clip: "route-build",
    label: "Route tab: two checkpoints in London, the route being built step by step, then three alternatives labelled with their extra time",
    body: "Add checkpoints on the map and build a route. Each leg follows roads, cycle paths, footpaths, sea lanes or a straight line, routed by OpenStreetMap, or by Google with your own key.",
    specs: [
      "Up to three alternative routes, labelled on the map with their extra time",
      "Drag the line to add a checkpoint there; drag checkpoints to reorder them",
      "The Build button shows each step as it happens, and Esc cancels it",
    ],
  },
  {
    key: "playback",
    title: "Play it back like a real trip.",
    clip: "playback",
    label: "Playback: a car leaves Westminster, speeding up from 9 to 39 km/h, with the live speed and heading on the map",
    body: "Play, pause and seek. The route line is coloured by speed, and the map shows the live speed and heading while it plays.",
    specs: [
      "0.25× to 30×, loop or back-and-forth, with an optional number of laps",
      "Checkpoints can hold until you press Continue (or N), and can wait a set time",
      "Optional GPS jitter; GPX files replay with their own timing",
    ],
  },
  {
    key: "comfort",
    title: "Made to stay open all day.",
    clip: "themes",
    label: "The app switching between several of its colour themes",
    body: "Seventeen colour themes, a dark or light vector map, folding sections, and a side menu you can resize or hide.",
    specs: [
      "Single-key shortcuts for common actions, all changeable (H shows them)",
      "A setup guide on first run, and help on every tool",
      "Updates itself in the background and checks each download's SHA-256",
    ],
  },
];

export default function Features() {
  const [active, setActive] = useState(0);
  const items = useRef([]);
  const root = useRef(null);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => { if (e.isIntersecting) setActive(Number(e.target.dataset.i)); }),
      { rootMargin: "-45% 0px -45% 0px" }
    );
    items.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (prefersReducedMotion()) return undefined;
    const ctx = gsap.context(() => {
      gsap.utils.toArray(".feat-item").forEach((el) => {
        gsap.from(el.querySelectorAll(".feat-n, h3, .feat-body, .feat-specs li, .feat-inline"), {
          y: 26, opacity: 0, duration: 0.8, ease: "power3.out", stagger: 0.06,
          scrollTrigger: { trigger: el, start: "top 78%", once: true },
        });
      });
      gsap.from(".feat-stage", {
        clipPath: "inset(8% 8% 8% 8% round 18px)", opacity: 0.4, duration: 1.2, ease: "power3.out",
        scrollTrigger: { trigger: ".feat-grid", start: "top 75%", once: true },
      });
    }, root);
    return () => ctx.revert();
  }, []);

  return (
    <section className="section features" id="features" ref={root}>
      <div className="container">
        <header className="sec-head">
          <p className="kicker"><span className="idx">01–04</span> What it does</p>
          <h2>Four ways to move a phone you aren't moving.</h2>
          <p>Every clip below is a recording of the real app, using its built-in simulated iPhone.</p>
        </header>
        <div className="feat-grid">
          <ol className="feat-list">
            {ITEMS.map((it, i) => (
              <li
                key={it.key}
                className={`feat-item${i === active ? " is-active" : ""}`}
                data-i={i}
                ref={(el) => { items.current[i] = el; }}
              >
                <span className="feat-n mono">{String(i + 1).padStart(2, "0")}</span>
                <h3>{it.title}</h3>
                <p className="feat-body">{it.body}</p>
                <ul className="feat-specs">
                  {it.specs.map((s) => <li key={s}>{s}</li>)}
                </ul>
                <AppWindow className="feat-inline">
                  <Clip name={it.clip} label={it.label} />
                </AppWindow>
              </li>
            ))}
          </ol>
          <div className="feat-sticky" aria-hidden="true">
            <AppWindow className="feat-stage" title={`Location Spoofer — ${String(active + 1).padStart(2, "0")} / 04`}>
              {ITEMS.map((it, i) => (
                <div key={it.key} className={`feat-layer${i === active ? " on" : ""}`}>
                  <Clip name={it.clip} label={it.label} active={i === active} />
                </div>
              ))}
            </AppWindow>
            <div className="feat-ticks">
              {ITEMS.map((it, i) => <span key={it.key} className={i === active ? "on" : ""} />)}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
