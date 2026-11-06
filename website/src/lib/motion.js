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
  // a higher lerp follows the wheel more closely, so fast flicks don't feel like they lag behind
  lenis = new Lenis({ lerp: 0.15, smoothWheel: true, wheelMultiplier: 1, touchMultiplier: 1.3 });
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

// Where a jump to a section lands: its title (kicker) just below the header, not the section's padded top.
export function scrollTargetFor(id) {
  if (id === "top") return 0;
  const el = document.getElementById(id);
  if (!el) return 0;
  const title = el.querySelector(".sec-head") || el;
  const header = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-h")) || 60;
  const max = document.documentElement.scrollHeight - window.innerHeight;
  return Math.max(0, Math.min(max, title.getBoundingClientRect().top + window.scrollY - header - 28));
}

export function scrollToId(id) {
  if (id !== "top" && !document.getElementById(id)) return;
  const top = scrollTargetFor(id);
  if (lenis) lenis.scrollTo(top, { duration: 1.1, easing: (t) => 1 - Math.pow(1 - t, 4) });
  else window.scrollTo({ top, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  history.replaceState(null, "", id === "top" ? location.pathname : `#${id}`);
}

// Run fn when the browser is idle (or after `timeout` ms), so set-up for content further down the page
// doesn't compete with the first paint and the intro animation. Returns a cleanup function; fn may
// return a gsap.context (or anything with revert()).
export function whenIdle(fn, timeout = 1500) {
  let result = null;
  let cancelled = false;
  const run = () => { if (!cancelled) result = fn(); };
  const ric = typeof window !== "undefined" && "requestIdleCallback" in window;
  const id = ric ? window.requestIdleCallback(run, { timeout }) : setTimeout(run, 200);
  return () => {
    cancelled = true;
    if (ric) window.cancelIdleCallback(id); else clearTimeout(id);
    result?.revert?.();
  };
}

export { gsap, ScrollTrigger };
