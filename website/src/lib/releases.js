import { useEffect, useState } from "react";

export const REPO = "YK3D/iPhone-location-spoofer";
export const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES = {
  standalone: `${REPO_URL}/releases?q=standalone&expanded=true`,
  browser: `${REPO_URL}/releases?q=browser&expanded=true`,
};

const CACHE_KEY = "ls-site-releases";
const CACHE_MS = 10 * 60 * 1000;

function pick(list, prefix) {
  const rel = list.find((r) => !r.prerelease && !r.draft && r.tag_name.startsWith(prefix));
  if (!rel) return null;
  const exe = rel.assets.find((a) => a.name.endsWith(".exe"));
  const sha = rel.assets.find((a) => a.name.endsWith(".sha256"));
  return {
    version: rel.tag_name.slice(prefix.length),
    tag: rel.tag_name,
    published: rel.published_at,
    page: rel.html_url,
    url: exe?.browser_download_url,
    file: exe?.name,
    size: exe?.size,
    shaUrl: sha?.browser_download_url,
  };
}

// Latest stable release of each edition, straight from GitHub (no server of ours in between).
// Falls back to the release pages if GitHub can't be reached or rate-limits the visitor.
export function useReleases() {
  const [state, setState] = useState({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    try {
      const hit = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null");
      if (hit && Date.now() - hit.at < CACHE_MS) {
        setState({ status: "ok", ...hit.data });
        return undefined;
      }
    } catch { /* storage unavailable */ }
    const ctrl = new AbortController();
    fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: ctrl.signal,
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`GitHub answered ${r.status}`))))
      .then((list) => {
        const data = { standalone: pick(list, "standalone-v"), browser: pick(list, "browser-v") };
        if (cancelled) return;
        setState({ status: "ok", ...data });
        try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data })); } catch { /* ignore */ }
      })
      .catch((e) => { if (!cancelled && e.name !== "AbortError") setState({ status: "error" }); });
    return () => { cancelled = true; ctrl.abort(); };
  }, []);
  return state;
}

export function formatSize(bytes) {
  if (!bytes) return "";
  return `${(bytes / 1024 / 1024).toFixed(bytes > 50e6 ? 0 : 1)} MB`;
}

export function formatDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function detectPlatform() {
  const ua = navigator.userAgent || "";
  const p = navigator.userAgentData?.platform || navigator.platform || "";
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return "mobile";
  if (/Win/i.test(p) || /Windows/i.test(ua)) return "windows";
  if (/Mac/i.test(p)) return "mac";
  if (/Linux|X11/i.test(p)) return "linux";
  return "other";
}
