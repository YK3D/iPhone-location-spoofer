// Runs before every build and dev start (npm "prebuild"/"predev"). Reads what the website shows from the
// repository itself, so the site follows the repo without anyone editing it by hand:
//   * the Terms, Privacy Policy, Licence, Third-party notices and Changelog, rendered to HTML pages;
//   * the number of colour themes in the app (ui/app.js);
//   * a snapshot of the latest releases, shown until the live data arrives in the browser.
// Writes src/generated/repo.json (small, in the main bundle) and src/generated/docs.json (loaded only by
// the document pages). A missing document fails the build; an unreachable GitHub does not.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { marked } from "marked";
import { fetchReleaseList, pickReleases } from "../src/lib/release-pick.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const OUT = path.resolve(here, "../src/generated");
const BLOB = "https://github.com/YK3D/iPhone-location-spoofer/blob/main";

export const DOCS = [
  { slug: "terms", file: "TERMS.md", title: "Terms of Use" },
  { slug: "privacy", file: "PRIVACY.md", title: "Privacy Policy" },
  { slug: "licence", file: "LICENSE", title: "Licence", plain: true },
  { slug: "third-party-notices", file: "THIRD_PARTY_NOTICES.md", title: "Third-party notices" },
  { slug: "changelog", file: "CHANGELOG.md", title: "Changelog" },
];
const PAGE_FOR = Object.fromEntries(DOCS.map((d) => [d.file.toLowerCase(), `/${d.slug}`]));

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function slugify(text, used) {
  const base = text.toLowerCase().replace(/<[^>]+>/g, "").replace(/&[a-z]+;|&#\d+;/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-") || "section";
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

// Links between the documents become site pages; other repository paths go to GitHub.
export function rewriteHref(href) {
  if (/^(https?:|mailto:|#)/i.test(href)) return href;
  const [file, hash = ""] = href.replace(/^\.\//, "").split("#");
  const page = PAGE_FOR[file.toLowerCase()];
  if (page) return page + (hash ? `#${hash}` : "");
  return `${BLOB}/${file}${hash ? `#${hash}` : ""}`;
}

export function renderMarkdown(md) {
  let html = marked.parse(md, { gfm: true, async: false });
  html = html.replace(/<a href="([^"]*)"/g, (_, href) => {
    const to = rewriteHref(href.replace(/&amp;/g, "&"));
    const external = /^https?:/i.test(to);
    return `<a href="${escapeHtml(to)}"${external ? ' target="_blank" rel="noreferrer"' : ""}`;
  });
  const used = new Set();
  html = html.replace(/<h([1-4])>([\s\S]*?)<\/h\1>/g, (_, level, inner) => `<h${level} id="${slugify(inner, used)}">${inner}</h${level}>`);
  html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, "</table></div>");
  return html;
}

function renderDoc(doc) {
  const text = readFileSync(path.join(ROOT, doc.file), "utf8");
  if (doc.plain) {
    // a plain-text licence: keep its line breaks and indentation, link bare URLs and file names
    const paras = text.trim().split(/\n\s*\n/).map((p) => `<p class="plain">${escapeHtml(p)}</p>`).join("\n");
    return paras.replace(/\b(THIRD_PARTY_NOTICES\.md)\b/g, '<a href="/third-party-notices">$1</a>');
  }
  // the page shows its own title, so drop the document's first H1
  return renderMarkdown(text.replace(/^#\s+.*\n+/, ""));
}

function themeCount() {
  const src = readFileSync(path.join(ROOT, "ui/app.js"), "utf8");
  const block = src.match(/const THEMES = \[([\s\S]*?)\n\];/);
  if (!block) throw new Error("ui/app.js: THEMES list not found");
  return (block[1].match(/\[\s*"[a-z-]+",\s*"[^"]+"/g) || []).length;
}

async function releases() {
  try {
    return pickReleases(await fetchReleaseList(process.env.GITHUB_TOKEN, "location-spoofer-website-build"));
  } catch (e) {
    console.warn(`repo-data: no release snapshot (${e.message}); the page fetches it live instead`);
    return null;
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const docs = DOCS.map((d) => ({ slug: d.slug, title: d.title, file: d.file, html: renderDoc(d) }));
  const repo = { builtAt: new Date().toISOString(), themes: themeCount(), releases: await releases() };
  writeFileSync(path.join(OUT, "docs.json"), JSON.stringify(docs));
  writeFileSync(path.join(OUT, "repo.json"), JSON.stringify(repo, null, 2));
  console.log(`repo-data: ${docs.length} documents, ${repo.themes} themes, releases ${repo.releases ? "snapshotted" : "live only"}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error(`repo-data: ${e.message}`); process.exit(1); });
}
