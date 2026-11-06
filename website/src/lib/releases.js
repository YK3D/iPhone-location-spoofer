import { createContext, createElement, useContext, useEffect, useState } from "react";
import repo from "../generated/repo.json";
import { RELEASES_API, pickReleases } from "./release-pick.js";

export const REPO = "YK3D/iPhone-location-spoofer";
export const REPO_URL = `https://github.com/${REPO}`;
export const SITE_URL = "https://iphone-spoofer.vercel.app";
export const RELEASES = {
  standalone: `${REPO_URL}/releases?q=standalone&expanded=true`,
  browser: `${REPO_URL}/releases?q=browser&expanded=true`,
};
// The standalone app is the release GitHub marks "latest", so this always downloads its newest version,
// even when the version data below couldn't be loaded.
export const LATEST_STANDALONE_EXE = `${REPO_URL}/releases/latest/download/LocationSpooferStandalone.exe`;

// Facts read from the repository when the site was built (scripts/repo-data.mjs).
export const REPO_FACTS = { themes: repo.themes };

const CACHE_KEY = "ls-site-releases-v2";
const CACHE_MS = 5 * 60 * 1000;

async function load(signal) {
  // 1. our cached endpoint (Vercel function); 2. GitHub directly, for local previews or an outage
  try {
    const r = await fetch("/api/releases", { signal });
    if (r.ok) {
      const data = await r.json();
      if (data && (data.standalone || data.browser)) return data;
    }
  } catch (e) {
    if (e.name === "AbortError") throw e;
  }
  const r = await fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" }, signal });
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  return pickReleases(await r.json());
}

function initial() {
  try {
    const hit = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null");
    if (hit && Date.now() - hit.at < CACHE_MS) return { status: "ok", fresh: true, ...hit.data };
  } catch { /* storage unavailable */ }
  // the build's snapshot shows real numbers straight away; live data replaces it moments later
  return repo.releases ? { status: "ok", fresh: false, ...repo.releases } : { status: "loading" };
}

function useReleaseData() {
  const [state, setState] = useState(initial);
  useEffect(() => {
    if (state.fresh) return undefined;
    const ctrl = new AbortController();
    load(ctrl.signal)
      .then((data) => {
        setState({ status: "ok", fresh: true, ...data });
        try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data })); } catch { /* ignore */ }
      })
      .catch((e) => {
        if (e.name === "AbortError") return;
        setState((s) => (s.status === "ok" ? s : { status: "error" })); // keep the snapshot if there is one
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return state;
}

const Ctx = createContext({ status: "loading" });
export function ReleasesProvider({ children }) {
  return createElement(Ctx.Provider, { value: useReleaseData() }, children);
}
export const useReleases = () => useContext(Ctx);

export function formatSize(bytes) {
  if (!bytes) return "";
  return `${(bytes / 1024 / 1024).toFixed(bytes > 50e6 ? 0 : 1)} MB`;
}

export function formatDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

// "a 14 MB download" when the size is known, otherwise a neutral phrase
export function sizePhrase(rel, fallback) {
  return rel?.size ? `a ${formatSize(rel.size)} download` : fallback;
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
