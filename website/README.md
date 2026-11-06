# Website

The project's showcase site: features, a download section that reads the latest releases from GitHub,
and a smaller version of the app that runs in the browser (teleport, road routes with the app's speed
engine, playback and a joystick, with a simulated iPhone). Vite + React, Lenis smooth scrolling, GSAP
ScrollTrigger animations, two React Bits components (`src/components/reactbits`). Dark by default, with a
light mode.

```bash
cd website
npm install
npm run dev        # http://localhost:5173
npm test           # the speed-engine port against the app's documented numbers
npm run build      # static site in dist/
```

## Layout

| Path | Contents |
|---|---|
| `src/sections/` | Page sections, top to bottom |
| `src/sim/engine.js` | A compact port of the app's speed engine (`browser/spoofer/profile.py`): cornering limits, acceleration and braking. Keep its constants in step with the app |
| `src/sim/routing.js` | Routes from the same public OSRM servers the app uses, at most one request per second |
| `src/sim/Simulator.jsx` | The in-browser demo (MapLibre with OpenFreeMap tiles), loaded only when its section comes near |
| `public/media/` | Clips of the real app made by `scripts/record-clips.cjs` |
| `scripts/make-contours.py` | Draws the topographic lines behind the hero (`src/assets/contours.svg`) |

## Clips

`scripts/record-clips.cjs` records the real app with its simulated iPhone (Graphite theme, dark map), the
same way `docs/screenshots/capture.js` takes the README screenshots. Start the browser edition first:

```bash
cd browser && SPOOFER_DATA_DIR=$(mktemp -d) python -m spoofer --port 8765 --no-browser --no-update
node website/scripts/record-clips.cjs     # needs Playwright and ffmpeg
```

## Hosting

Deployed on Vercel with `website` as the project's root directory (`vercel.json` holds the build settings,
caching and security headers). The site sets no cookies and loads no analytics; it talks only to
OpenFreeMap (map tiles), routing.openstreetmap.de (demo routes) and api.github.com (release versions).
Pushes that only touch `website/` don't publish app test builds (see `paths-ignore` in
`.github/workflows/release.yml`).
