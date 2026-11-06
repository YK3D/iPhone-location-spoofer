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

export default function Header({ theme, onToggleTheme }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <header className={`site-header${scrolled ? " scrolled" : ""}`}>
      <div className="container">
        <a className="brand" href="#top" onClick={go("top")}>
          <img src="/icon-64.png" alt="" width="28" height="28" />
          <span>Location Spoofer</span>
        </a>
        <nav className="nav" aria-label="Sections">
          {LINKS.map(([id, label]) => (
            <a key={id} href={`#${id}`} onClick={go(id)}>{label}</a>
          ))}
        </nav>
        <div className="header-end">
          <a className="icon-btn gh" href={REPO_URL} target="_blank" rel="noreferrer" aria-label="Source code on GitHub">
            <Icon name="github" />
          </a>
          <button className="icon-btn" type="button" onClick={onToggleTheme} aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`}>
            <Icon name={theme === "dark" ? "sun" : "moon"} />
          </button>
          <a className="btn btn-primary btn-sm" href="#install" onClick={go("install")}>
            <Icon name="download" /> Download
          </a>
        </div>
      </div>
    </header>
  );
}
