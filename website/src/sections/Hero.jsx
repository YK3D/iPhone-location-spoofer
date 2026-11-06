import { useEffect, useRef, useState } from "react";
import SplitText from "../components/reactbits/SplitText.jsx";
import DecryptedText from "../components/reactbits/DecryptedText.jsx";
import AppWindow from "../components/AppWindow.jsx";
import Clip from "../components/Clip.jsx";
import Icon from "../components/Icon.jsx";
import { go } from "../components/Header.jsx";
import { gsap, prefersReducedMotion } from "../lib/motion.js";
import { formatSize, useReleases } from "../lib/releases.js";

const PLACES = [
  ["Trafalgar Square, London", 51.50803, -0.12807],
  ["Eiffel Tower, Paris", 48.85837, 2.29448],
  ["Shibuya Crossing, Tokyo", 35.65952, 139.70056],
  ["Times Square, New York", 40.758, -73.98557],
  ["Opera House, Sydney", -33.85678, 151.2153],
];

const fmt = (v) => (v < 0 ? "−" : "") + Math.abs(v).toFixed(5);

function DeviceCard() {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (prefersReducedMotion()) return undefined;
    const id = setInterval(() => { if (!document.hidden) setI((n) => (n + 1) % PLACES.length); }, 3000);
    return () => clearInterval(id);
  }, []);
  const [name, lat, lon] = PLACES[i];
  return (
    <div className="device-card" aria-live="off">
      <div className="dc-head">
        <span className="dc-dot" />
        <span>Simulated iPhone</span>
        <span className="dc-usb mono">USB</span>
      </div>
      <div className="dc-coords mono tnum">
        <DecryptedText key={`a${i}`} text={fmt(lat)} animateOn="view" sequential speed={20} characters="0123456789" className="dc-real" encryptedClassName="dc-enc" />
        <DecryptedText key={`b${i}`} text={fmt(lon)} animateOn="view" sequential speed={20} characters="0123456789" className="dc-real" encryptedClassName="dc-enc" />
      </div>
      <div className="dc-place">{name}</div>
    </div>
  );
}

export default function Hero() {
  const releases = useReleases();
  const root = useRef(null);
  const s = releases.status === "ok" ? releases.standalone : null;

  useEffect(() => {
    if (prefersReducedMotion()) return undefined;
    const ctx = gsap.context(() => {
      gsap.from(".hero-lede, .cta-row, .hero-facts", { y: 14, opacity: 0, duration: 0.55, ease: "power3.out", stagger: 0.05, delay: 0.2 });
      gsap.from(".hero-visual", { y: 48, opacity: 0, duration: 0.8, ease: "power3.out", delay: 0.3 });
      gsap.fromTo(
        ".hero-window",
        { rotateX: 16, scale: 0.93, transformOrigin: "50% 0%" },
        { rotateX: 0, scale: 1, ease: "none", scrollTrigger: { trigger: ".hero-visual", start: "top 85%", end: "top 20%", scrub: 0.6 } }
      );
      gsap.to(".device-card", { y: -60, ease: "none", scrollTrigger: { trigger: ".hero-visual", start: "top 70%", end: "bottom top", scrub: true } });
      gsap.to(".hero-contours", { yPercent: 18, ease: "none", scrollTrigger: { trigger: root.current, start: "top top", end: "bottom top", scrub: true } });
    }, root);
    return () => ctx.revert();
  }, []);

  return (
    <section className="hero" id="top" ref={root}>
      <div className="hero-contours" aria-hidden="true" />
      <div className="container">
        <p className="kicker"><span className="idx">Windows → iPhone</span> over a USB cable</p>
        <SplitText
          tag="h1"
          className="hero-title"
          text="Put your iPhone anywhere on the map."
          splitType="words"
          effect="rise"
          mask
          delay={32}
          duration={0.7}
          trigger="load"
          textAlign="left"
        />
        <div className="hero-sub">
          <p className="hero-lede">
            Set the GPS location of an iPhone or iPad from your Windows PC. Jump anywhere, follow real roads at
            realistic speeds, replay GPX files, or walk around live with the keyboard.
          </p>
          <div className="hero-actions">
            <div className="cta-row">
              <a className="btn btn-primary" href="#install" onClick={go("install")}>
                <Icon name="windows" /> Download for Windows
                {s && <span className="sub">v{s.version} · {formatSize(s.size)}</span>}
              </a>
              <a className="btn btn-ghost" href="#simulator" onClick={go("simulator")}>
                Try it here <Icon name="arrowRight" />
              </a>
            </div>
            <ul className="hero-facts mono">
              <li>Free · no jailbreak</li>
              <li>No account, no telemetry</li>
              <li>Windows 10 &amp; 11</li>
            </ul>
          </div>
        </div>
        <div className="hero-visual">
          <AppWindow className="hero-window">
            <Clip name="route-build" startDelay={900} preload="metadata" label="The app building a car route across central London, with three alternative routes labelled by their extra time" />
          </AppWindow>
          <DeviceCard />
        </div>
      </div>
    </section>
  );
}
