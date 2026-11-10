import { Component, Suspense, lazy, useEffect, useRef, useState } from "react";
import { prefetchMap } from "../sim/prefetch.js";

const loadSimulator = () => import("../sim/Simulator.jsx");
const Simulator = lazy(loadSimulator);

class Boundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) {
      return <div className="sim-fallback"><p>The demo couldn't start in this browser. The recordings above show the real app.</p></div>;
    }
    return this.props.children;
  }
}

// The map is the heaviest thing on the page, so it gets ready in the background in three steps:
//  1. as soon as the visitor starts scrolling, the map's data for its first view (style, tiles, fonts)
//     downloads into the browser cache: network only, nothing for the page to draw;
//  2. its code (a 1 MB library) loads the next time the browser is idle;
//  3. the map itself is created at a pause in the scrolling within about a screen of the demo, from
//     the cache, so it appears almost at once and never costs frames mid-flick (a link or a jump to
//     the demo ends in such a pause, so it starts straight away).
export default function Demo() {
  const ref = useRef(null);
  const [mount, setMount] = useState(false);

  useEffect(() => {
    const ric = "requestIdleCallback" in window;
    let near = false;
    let started = false;
    let quiet = 0;
    let idle = 0;
    const create = () => {
      if (started) return;
      started = true;
      loadSimulator().then(() => setMount(true)).catch(() => setMount(true));
    };
    const onScroll = () => {
      prefetchMap();
      if (!idle) idle = ric ? requestIdleCallback(() => loadSimulator().catch(() => {})) : setTimeout(() => loadSimulator().catch(() => {}), 1500);
      clearTimeout(quiet);
      if (near) quiet = setTimeout(create, 120);
    };
    // within about a screen of the demo: create it at the next pause in the scrolling
    const ioNear = new IntersectionObserver(([e]) => { near = e.isIntersecting; if (near) { clearTimeout(quiet); quiet = setTimeout(create, 120); } }, { rootMargin: "100% 0px" });
    if (ref.current) ioNear.observe(ref.current);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      ioNear.disconnect();
      clearTimeout(quiet);
      if (idle) { if (ric) cancelIdleCallback(idle); else clearTimeout(idle); }
    };
  }, []);

  return (
    <section className="section demo" id="simulator">
      <div className="container">
        <header className="sec-head">
          <p className="kicker"><span className="idx">07</span> Try it</p>
          <h2>Test out a demo!</h2>
          <p>
            Pick a place and teleport, build a route on real roads and play it back, or take the joystick. The speed
            engine and the routing service are the app's; the iPhone in the demo is simulated, so nothing is sent to a phone.
          </p>
        </header>
        <div ref={ref}>
          <Boundary>
            {mount ? (
              <Suspense fallback={<div className="sim sim-skeleton" aria-busy="true"><span className="mono">Loading the map…</span></div>}>
                <Simulator />
              </Suspense>
            ) : (
              <div className="sim sim-skeleton" aria-hidden="true"><span className="mono">Loading the map…</span></div>
            )}
          </Boundary>
        </div>
      </div>
    </section>
  );
}
