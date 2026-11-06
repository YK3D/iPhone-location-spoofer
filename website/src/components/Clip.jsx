import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "../lib/motion.js";

// A recording of the real app (website/scripts/record-clips.cjs). Loads nothing until it is near
// the screen, plays only while visible, and shows controls instead of autoplaying when the visitor
// asked for reduced motion. `startDelay` (ms) holds the first play back, so the video decoder doesn't
// start up during the page's intro animation.
export default function Clip({ name, label, active = true, className = "", startDelay = 0, preload = "none" }) {
  const ref = useRef(null);
  const reduce = prefersReducedMotion();

  useEffect(() => {
    const v = ref.current;
    if (!v || reduce) return undefined;
    let visible = false;
    let ready = startDelay <= 0;
    const sync = () => {
      if (visible && active && ready) v.play().catch(() => {});
      else v.pause();
    };
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; sync(); }, { threshold: 0.2 });
    io.observe(v);
    const t = ready ? 0 : setTimeout(() => { ready = true; sync(); }, startDelay);
    sync();
    return () => { io.disconnect(); clearTimeout(t); };
  }, [active, reduce, startDelay]);

  return (
    <video
      ref={ref}
      className={`clip ${className}`}
      muted
      loop
      playsInline
      preload={preload}
      controls={reduce}
      poster={`/media/${name}-poster.webp`}
      aria-label={label}
      width="1280"
      height="800"
    >
      <source src={`/media/${name}.webm`} type="video/webm" />
      <source src={`/media/${name}.mp4`} type="video/mp4" />
    </video>
  );
}
