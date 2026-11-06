// The document pages (rendered from the repository by scripts/repo-data.mjs). Kept in its own tiny module
// so the home page can route without loading the page component. Vercel rewrites these paths to the app
// (vercel.json "rewrites").
export const DOC_SLUGS = ["terms", "privacy", "licence", "third-party-notices", "changelog"];
