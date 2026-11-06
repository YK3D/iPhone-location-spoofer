import { Component, Suspense, lazy, useEffect, useRef, useState } from "react";

const Simulator = lazy(() => import("../sim/Simulator.jsx"));

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

export default function Demo() {
  const ref = useRef(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setNear(true); io.disconnect(); } }, { rootMargin: "900px 0px" });
    if (ref.current) io.observe(ref.current);
    return () => io.disconnect();
  }, []);
  return (
    <section className="section demo" id="simulator" ref={ref}>
      <div className="container">
        <header className="sec-head">
          <p className="kicker"><span className="idx">07</span> Try it</p>
          <h2>A smaller version of the app, in your browser.</h2>
          <p>
            Pick a place and teleport, build a route on real roads and play it back, or take the joystick. The speed
            engine and the routing service are the app's; the iPhone in the demo is simulated, so nothing is sent to a phone.
          </p>
        </header>
        <Boundary>
          {near ? (
            <Suspense fallback={<div className="sim sim-skeleton" aria-busy="true"><span className="mono">Loading the map…</span></div>}>
              <Simulator />
            </Suspense>
          ) : (
            <div className="sim sim-skeleton" aria-hidden="true" />
          )}
        </Boundary>
      </div>
    </section>
  );
}
