import { useEffect } from "react";
import Header from "./components/Header.jsx";
import RouteRail from "./components/RouteRail.jsx";
import Hero from "./sections/Hero.jsx";
import Features from "./sections/Features.jsx";
import Engine from "./sections/Engine.jsx";
import Details from "./sections/Details.jsx";
import Demo from "./sections/Demo.jsx";
import Install from "./sections/Install.jsx";
import Faq from "./sections/Faq.jsx";
import Footer from "./sections/Footer.jsx";
import { useTheme } from "./lib/theme.js";
import { useReleases } from "./lib/releases.js";
import { ScrollTrigger, scrollToId, startSmoothScroll } from "./lib/motion.js";

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const releases = useReleases();

  useEffect(() => {
    startSmoothScroll();
    // a link with a #section opens at that section once the layout has settled
    const id = location.hash.slice(1);
    if (id) setTimeout(() => scrollToId(id), 400);
    // late layout changes (fonts, lazy demo) move the scroll triggers
    let t = 0;
    let lastH = document.body.scrollHeight;
    const ro = new ResizeObserver(() => {
      if (Math.abs(document.body.scrollHeight - lastH) < 2) return;
      lastH = document.body.scrollHeight;
      clearTimeout(t);
      t = setTimeout(() => ScrollTrigger.refresh(), 200);
    });
    ro.observe(document.body);
    return () => { ro.disconnect(); clearTimeout(t); };
  }, []);

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <Header theme={theme} onToggleTheme={toggleTheme} />
      <RouteRail />
      <main id="main">
        <Hero releases={releases} />
        <Features />
        <Engine />
        <Details />
        <Demo />
        <Install releases={releases} />
        <Faq />
      </main>
      <Footer />
    </>
  );
}
