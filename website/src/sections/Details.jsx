import { useEffect, useRef } from "react";
import Icon from "../components/Icon.jsx";
import { gsap, prefersReducedMotion } from "../lib/motion.js";

const ROWS = [
  ["map", "Offline maps", "Save the area on screen, about a city per download, and the map keeps working without internet."],
  ["file", "GPX files", "Drop a file in to replay it with its own timing, re-time it, reverse it, or edit it as checkpoints. Routes export as GPX."],
  ["joystick", "Joystick", "Walk or drive live with W A S D, the arrow keys or the on-screen pad, at any speed you set."],
  ["crosshair", "Stop spoofing", "One click gives the iPhone its real GPS back and shows your computer's real location on the map."],
  ["pin", "Google Maps, if you want it", "Add your own API key for Google routes and map tiles. Without one, routing uses free OpenStreetMap services."],
  ["route", "Road-aware driving", "Experimental: follows each road's typical speed and aims for the same trip time as Google Maps or OpenStreetMap."],
  ["shield", "Private by design", "No accounts, no analytics, no telemetry. Favourites, routes and settings stay on your computer."],
  ["refresh", "Two editions", "The Standalone app (under 20 MB, starts instantly) for most people, or the Browser edition for iOS 17.0–17.3."],
];

export default function Details() {
  const root = useRef(null);
  useEffect(() => {
    if (prefersReducedMotion()) return undefined;
    const ctx = gsap.context(() => {
      gsap.from(".spec-row", {
        y: 22, opacity: 0, duration: 0.7, ease: "power3.out", stagger: { each: 0.05, grid: "auto" },
        scrollTrigger: { trigger: ".spec-grid", start: "top 82%", once: true },
      });
    }, root);
    return () => ctx.revert();
  }, []);
  return (
    <section className="section details" ref={root} aria-labelledby="details-title">
      <div className="container">
        <header className="sec-head">
          <p className="kicker"><span className="idx">06</span> And the rest</p>
          <h2 id="details-title">The small things you'd otherwise miss.</h2>
        </header>
        <dl className="spec-grid">
          {ROWS.map(([icon, title, text]) => (
            <div className="spec-row" key={title}>
              <dt><Icon name={icon} /> {title}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
