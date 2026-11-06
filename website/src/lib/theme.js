import { useEffect, useState } from "react";

const KEY = "ls-site-theme";

function current() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

// Dark by default. The choice is remembered on this device when storage is available.
export function useTheme() {
  const [theme, setTheme] = useState(current);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(KEY, theme); } catch { /* private mode: still works for this visit */ }
    window.dispatchEvent(new CustomEvent("site-theme", { detail: theme }));
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}

// For components that only need to follow the theme (the demo map).
export function useThemeValue() {
  const [theme, setTheme] = useState(current);
  useEffect(() => {
    const on = (e) => setTheme(e.detail);
    window.addEventListener("site-theme", on);
    return () => window.removeEventListener("site-theme", on);
  }, []);
  return theme;
}
