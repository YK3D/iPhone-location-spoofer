import { useEffect, useState } from "react";
import Icon from "./Icon.jsx";
import { scrollToId } from "../lib/motion.js";
import { REPO_URL } from "../lib/releases.js";

const LINKS = [
  ["features", "Features"],
  ["engine", "Speed engine"],
  ["simulator", "Try it"],
  ["install", "Install"],
  ["faq", "FAQ"],
];

export function go(id) {
  return (e) => {
    e.preventDefault();
    scrollToId(id);
  };
}

// On the home page the links scroll to sections; on a document page they go to the home page's sections.
export default function Header({ home = true }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  return (
    <header className={`site-header${scrolled ? " scrolled" : ""}`}>
      <div className="container">
        <a className="brand" href={home ? "#top" : "/"} onClick={home ? go("top") : undefined}>
          <img src="/icon-64.png" alt="" width="28" height="28" />
          <span>Location Spoofer</span>
        </a>
        <nav className="nav" aria-label="Sections">
          {LINKS.map(([id, label]) => (
            <a key={id} href={home ? `#${id}` : `/#${id}`} onClick={home ? go(id) : undefined}>{label}</a>
          ))}
        </nav>
        <div className="header-end">
          <a className="icon-btn gh" href={REPO_URL} target="_blank" rel="noreferrer" aria-label="Source code on GitHub">
            <Icon name="github" />
          </a>
          <a className="btn btn-primary btn-sm" href={home ? "#install" : "/#install"} onClick={home ? go("install") : undefined}>
            <Icon name="download" /> Download
          </a>
        </div>
      </div>
    </header>
  );
}
