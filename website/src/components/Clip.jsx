import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "../lib/motion.js";

// A recording of the real app (website/scripts/record-clips.cjs). Loads nothing until it is near
// the screen, plays only while visible, and shows controls instead of autoplaying when the visitor
// asked for reduced motion.
export default function Clip({ name, label, active = true, className = "" }) {
  const ref = useRef(null);
  const reduce = prefersReducedMotion();

  useEffect(() => {
    const v = ref.current;
    if (!v || reduce) return undefined;
    let visible = false;
    const sync = () => {
      if (visible && active) v.play().catch(() => {});
      else v.pause();
    };
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; sync(); }, { threshold: 0.2 });
    io.observe(v);
    sync();
    return () => io.disconnect();
  }, [active, reduce]);

  return (
    <video
      ref={ref}
      className={`clip ${className}`}
      muted
      loop
      playsInline
      preload="none"
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
