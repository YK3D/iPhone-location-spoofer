import { Component, Suspense, lazy, useEffect, useRef, useState } from "react";

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

// The map is the heaviest thing on the page (a 1 MB library and a WebGL canvas), so:
// its code downloads and is parsed while the browser is idle, and the map itself is only created
// once the demo is on screen and the page has stopped scrolling, so it never costs frames mid-scroll.
export default function Demo() {
  const ref = useRef(null);
  const [mount, setMount] = useState(false);

  useEffect(() => {
    const ric = "requestIdleCallback" in window;
    const prefetch = () => { loadSimulator().catch(() => {}); };
    const idle = ric ? requestIdleCallback(prefetch) : setTimeout(prefetch, 2500);

    let visible = false;
    let quiet = 0;
    const settle = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => { if (visible) setMount(true); }, 160);
    };
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) settle(); }, { rootMargin: "0px 0px -15% 0px" });
    if (ref.current) io.observe(ref.current);
    window.addEventListener("scroll", settle, { passive: true });
    return () => {
      if (ric) cancelIdleCallback(idle); else clearTimeout(idle);
      clearTimeout(quiet);
      io.disconnect();
      window.removeEventListener("scroll", settle);
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
