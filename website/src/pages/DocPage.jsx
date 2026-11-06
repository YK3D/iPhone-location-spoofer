import { useEffect, useMemo, useState } from "react";
import { REPO_URL } from "../lib/releases.js";
import { getLenis } from "../lib/motion.js";

// The repository's Terms, Privacy Policy, Licence, Third-party notices and Changelog as pages of the site.
// The HTML is rendered from the files in the repository at build time (scripts/repo-data.mjs), so each
// deployment shows the current text.
function headingsOf(html) {
  return [...html.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)].map(([, id, inner]) => ({ id, text: inner.replace(/<[^>]+>/g, "") }));
}

export default function DocPage({ slug }) {
  const [docs, setDocs] = useState(null);
  useEffect(() => {
    import("../generated/docs.json").then((m) => setDocs(m.default)).catch(() => setDocs([]));
  }, []);
  const doc = docs?.find((d) => d.slug === slug);
  const toc = useMemo(() => (doc ? headingsOf(doc.html) : []), [doc]);

  useEffect(() => {
    if (doc) document.title = `${doc.title} · Location Spoofer`;
    if (!doc || !location.hash) return;
    // open at the linked heading once the text is in the page
    requestAnimationFrame(() => {
      const el = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 84);
    });
  }, [doc]);

  const jump = (id) => (e) => {
    e.preventDefault();
    const el = document.getElementById(id);
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - 84;
    const lenis = getLenis();
    if (lenis) lenis.scrollTo(top, { duration: 0.9 }); else window.scrollTo({ top, behavior: "smooth" });
    history.replaceState(null, "", `#${id}`);
  };

  if (docs && !doc) {
    return (
      <main id="main" className="doc container">
        <h1>Page not found</h1>
        <p><a href="/">Back to the home page</a></p>
      </main>
    );
  }

  return (
    <main id="main" className="doc">
      <div className="container doc-grid">
        {toc.length >= 3 && (
          <nav className="doc-toc" aria-label="On this page">
            <p className="kicker">On this page</p>
            <ul>{toc.map((h) => <li key={h.id}><a href={`#${h.id}`} onClick={jump(h.id)}>{h.text}</a></li>)}</ul>
          </nav>
        )}
        <article className="doc-body">
          <p className="kicker"><a href="/">Location Spoofer</a></p>
          <h1>{doc ? doc.title : " "}</h1>
          {doc && (
            <p className="doc-meta">
              From <a href={`${REPO_URL}/blob/main/${doc.file}`} target="_blank" rel="noreferrer"><span className="mono">{doc.file}</span> in the repository</a>.
            </p>
          )}
          {slug === "privacy" && (
            <aside className="doc-note">
              This policy is about the app. This website sets no cookies, loads no analytics and keeps nothing about you.
              Its demo loads map tiles from OpenFreeMap and routes from routing.openstreetmap.de, and it reads the latest
              version numbers from GitHub.
            </aside>
          )}
          {/* the document text is our own repository's, rendered at build time */}
          {doc ? <div className="prose" dangerouslySetInnerHTML={{ __html: doc.html }} /> : <p className="muted">Loading…</p>}
        </article>
      </div>
    </main>
  );
}
