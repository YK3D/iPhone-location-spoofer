# Website

The project's site, [iphone-spoofer.vercel.app](https://iphone-spoofer.vercel.app): what the app does,
the downloads, a smaller version of the app that runs in the browser (teleport, road routes with the
app's speed engine, playback and a joystick, with a simulated iPhone), and the Terms, Privacy Policy,
Licence, Third-party notices and Changelog as pages. Vite + React, Lenis smooth scrolling, GSAP
ScrollTrigger animations, two React Bits components (`src/components/reactbits`). Dark only.

```bash
cd website
npm install
npm run dev        # http://localhost:5173
npm test           # speed-engine port, document rendering, release data, the /api/releases function
npm run build      # static site in dist/
```

## What comes from the repository

Nothing on the site that the repository already says is typed in by hand:

| On the site | Comes from | Updates |
|---|---|---|
| Version numbers, file sizes, release dates, download links | GitHub's releases, through `api/releases.js` (a Vercel function cached for 5 minutes), or straight from GitHub if that fails | Live, within minutes of a release |
| `/terms`, `/privacy`, `/licence`, `/third-party-notices`, `/changelog` | `TERMS.md`, `PRIVACY.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `CHANGELOG.md` | Each deployment |
| The number of colour themes | `THEMES` in `ui/app.js` | Each deployment |

`scripts/repo-data.mjs` reads these before every build and dev start (`src/generated/`, not committed).
Links between the documents become site pages; other repository paths link to GitHub. Vercel rebuilds the
site when anything under `website/` or one of those files changes (`ignoreCommand` in `vercel.json`).

## Layout

| Path | Contents |
|---|---|
| `src/sections/` | Home page sections, top to bottom |
| `src/pages/DocPage.jsx` | The document pages (Vercel rewrites their paths to the app) |
| `src/sim/engine.js` | A compact port of the app's speed engine (`browser/spoofer/profile.py`): cornering limits, acceleration and braking. Keep its constants in step with the app |
| `src/sim/routing.js` | Routes from the same public OSRM servers the app uses, at most one request per second |
| `src/sim/Simulator.jsx` | The in-browser demo (MapLibre, OpenFreeMap tiles with the app's dark-map colours). Its code loads while the browser is idle; the map starts once the demo is on screen and scrolling has stopped |
| `api/releases.js` | Latest stable release of each edition. An optional `GITHUB_TOKEN` environment variable raises GitHub's rate limit |
| `public/media/` | Clips of the real app made by `scripts/record-clips.cjs` |
| `scripts/make-contours.py` | Draws the topographic lines behind the hero (`src/assets/contours.svg`) |

## Clips

`scripts/record-clips.cjs` records the real app with its simulated iPhone (Graphite theme, dark map), the
same way `docs/screenshots/capture.js` takes the README screenshots, and also makes the README's animation
(`docs/screenshots/demo.webp`). Start the browser edition first:

```bash
cd browser && SPOOFER_DATA_DIR=$(mktemp -d) python -m spoofer --port 8765 --no-browser --no-update
node website/scripts/record-clips.cjs                 # all clips; needs Playwright and ffmpeg
ONLY=themes node website/scripts/record-clips.cjs     # just some of them
```

## Hosting

Vercel, with `website` as the project's root directory (`vercel.json` holds the build settings, rewrites,
caching and security headers). Production deploys from `main`; `dev` deploys to
[iphone-spoofer-dev.vercel.app](https://iphone-spoofer-dev.vercel.app). The site sets no cookies and loads
no analytics; it talks only to OpenFreeMap (map tiles), routing.openstreetmap.de (demo routes) and GitHub
(release versions, through its own `/api/releases`). Pushes that only touch `website/` don't publish app
test builds (see `paths-ignore` in `.github/workflows/release.yml`).
