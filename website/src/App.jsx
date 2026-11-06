import { Suspense, lazy, useEffect } from "react";
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
import { DOC_SLUGS } from "./pages/doc-slugs.js";
import { ReleasesProvider } from "./lib/releases.js";
import { ScrollTrigger, scrollToId, startSmoothScroll } from "./lib/motion.js";

const DocPage = lazy(() => import("./pages/DocPage.jsx"));

// "/terms" and the other document pages; everything else is the home page.
const slug = location.pathname.replace(/^\/+|\/+$/g, "").toLowerCase().replace(/^license$/, "licence");
const docSlug = DOC_SLUGS.includes(slug) ? slug : null;

function Home() {
  useEffect(() => {
    // a link with a #section opens at that section once the layout has settled
    const id = location.hash.slice(1);
    if (id) setTimeout(() => scrollToId(id), 400);
    // late layout changes (fonts, the demo) move the scroll triggers
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
      <RouteRail />
      <main id="main">
        <Hero />
        <Features />
        <Engine />
        <Details />
        <Demo />
        <Install />
        <Faq />
      </main>
    </>
  );
}

export default function App() {
  useEffect(() => { startSmoothScroll(); }, []);
  return (
    <ReleasesProvider>
      <a className="skip" href="#main">Skip to content</a>
      <Header home={!docSlug} />
      {docSlug ? (
        <Suspense fallback={<main id="main" className="doc" />}>
          <DocPage slug={docSlug} />
        </Suspense>
      ) : (
        <Home />
      )}
      <Footer />
    </ReleasesProvider>
  );
}
