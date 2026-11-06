// Smooth scrolling (Lenis) driven by GSAP's ticker, so ScrollTrigger animations and the scroll
// position always agree. With "reduce motion" on, the page scrolls natively and nothing animates.
import Lenis from "lenis";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

export const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

let lenis = null;
const listeners = new Set();

export function startSmoothScroll() {
  if (lenis || prefersReducedMotion()) return lenis;
  lenis = new Lenis({ lerp: 0.11, smoothWheel: true, wheelMultiplier: 0.95, touchMultiplier: 1.4 });
  lenis.on("scroll", (e) => {
    ScrollTrigger.update();
    listeners.forEach((fn) => fn(e));
  });
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
  return lenis;
}

export const getLenis = () => lenis;

// Subscribe to scroll updates: { scroll, velocity (px per second), direction }.
// Works with or without Lenis.
export function onScroll(fn) {
  if (lenis) {
    const wrap = (e) => fn({ scroll: e.scroll, velocity: e.velocity * 60, direction: e.direction });
    listeners.add(wrap);
    return () => listeners.delete(wrap);
  }
  let last = window.scrollY;
  let lastT = performance.now();
  let raf = 0;
  const handler = () => {
    const now = performance.now();
    const y = window.scrollY;
    const dt = Math.max(1, now - lastT);
    const v = ((y - last) / dt) * 1000;
    last = y; lastT = now;
    fn({ scroll: y, velocity: v, direction: Math.sign(v) });
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => requestAnimationFrame(() => fn({ scroll: window.scrollY, velocity: 0, direction: 0 })));
  };
  window.addEventListener("scroll", handler, { passive: true });
  return () => { window.removeEventListener("scroll", handler); cancelAnimationFrame(raf); };
}

export function scrollToId(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const offset = -(parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-h")) || 60) + 1;
  if (lenis) lenis.scrollTo(el, { offset, duration: 1.3, easing: (t) => 1 - Math.pow(1 - t, 4) });
  else window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY + offset, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  history.replaceState(null, "", `#${id}`);
}

export { gsap, ScrollTrigger };
