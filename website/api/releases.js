// GET /api/releases: the latest stable release of each edition, cached at Vercel's edge for 5 minutes
// (and served stale for up to a day if GitHub is unreachable), so visitors never hit GitHub's per-IP
// rate limit and the page always shows the current version and file size. An optional GITHUB_TOKEN
// environment variable raises GitHub's limit for this function; none is needed.
import { fetchReleaseList, pickReleases } from "../src/lib/release-pick.js";

export default async function handler(req, res) {
  try {
    const data = pickReleases(await fetchReleaseList(process.env.GITHUB_TOKEN, "location-spoofer-website"));
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=86400");
    res.status(200).json(data);
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: String(e && e.message ? e.message : e) });
  }
}
