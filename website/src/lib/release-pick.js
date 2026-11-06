// Shared by the browser, the /api/releases function and the build script: reduce GitHub's release list
// to the latest stable release of each edition. Pure, no imports.
export const REPO = "YK3D/iPhone-location-spoofer";
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;

function pick(list, prefix) {
  const rel = list.find((r) => !r.prerelease && !r.draft && typeof r.tag_name === "string" && r.tag_name.startsWith(prefix));
  if (!rel) return null;
  const exe = (rel.assets || []).find((a) => a.name.endsWith(".exe"));
  const sha = (rel.assets || []).find((a) => a.name.endsWith(".sha256"));
  return {
    version: rel.tag_name.slice(prefix.length),
    tag: rel.tag_name,
    published: rel.published_at,
    page: rel.html_url,
    url: exe ? exe.browser_download_url : null,
    file: exe ? exe.name : null,
    size: exe ? exe.size : null,
    shaUrl: sha ? sha.browser_download_url : null,
  };
}

// Fetch the release list, with a token if one is configured; a rejected token (401) falls back to an
// anonymous request, so a stale secret can't take the version numbers down.
export async function fetchReleaseList(token, userAgent) {
  const base = { Accept: "application/vnd.github+json", "User-Agent": userAgent };
  let r = await fetch(RELEASES_API, { headers: token ? { ...base, Authorization: `Bearer ${token}` } : base, signal: AbortSignal.timeout(8000) });
  if (r.status === 401 && token) r = await fetch(RELEASES_API, { headers: base, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  return r.json();
}

export function pickReleases(list) {
  if (!Array.isArray(list)) return null;
  return { standalone: pick(list, "standalone-v"), browser: pick(list, "browser-v") };
}
