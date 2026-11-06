# Working on this repository

## Branches (follow these rules for every change)

| Branch | What goes there | How |
|---|---|---|
| `main` | Stable releases | Never directly. It is updated from `dev` through a pull request when a release is ready. |
| `dev` | Standard features and fixes | Push here once the tests pass. Every push publishes test builds (pre-releases for the "Test builds" channel). |
| `feature-testing` | Highly risky or experimental work: rewrites of the speed/physics engine or the playback engine, new device transports, anything that can break playback or routing for everyone | Open a pull request into `feature-testing` and **enable auto-merge** on it. It is promoted to `dev` only after it has been tried. |

- Split a change set when it mixes both kinds: push the standard part to `dev` first, then base the risky part on top of it for `feature-testing`.
- `feature-testing` publishes no public builds. Each pull request into it gets an encrypted build (`.github/workflows/feature-tests.yml`, secret `FEATURE_TEST_PASSWORD`) that the developer opens in the app under Settings › Updates › Developer access (shown after clicking the About tab 7 times); other pull requests can be built with the workflow's "Run workflow" and a PR number. Or try it from source.
- If a pull request into `feature-testing` can't use auto-merge (repository setting "Allow auto-merge" off, or no required checks so it is mergeable right away), merge it once its checks pass, which is what auto-merge would do.
- Ask before a large architectural rewrite of core systems (playback engine, timeline, device drivers): write a proposal first.

## Layout

- `ui/` is the one interface both editions serve (HTML, CSS, JS; no build step).
- `browser/` is the Python edition (FastAPI); `standalone/` is the Rust edition (axum, native window). Backend behaviour must stay the same in both: port every API or engine change to the other edition, with tests.
- `assets/icon/source.jpg` is the original icon artwork. Never edit it; `assets/icon/make_icons.py` regenerates every icon file from it.
- `docs/screenshots/capture.js` makes the README screenshots with the default look (Graphite theme, dark OpenFreeMap map).
- `website/` is the showcase site (Vite + React, deployed on Vercel, root directory `website`). `website/src/sim/engine.js` is a compact port of the speed engine for its demo: when the cornering or acceleration constants change in the app, update it too and run `cd website && npm test`. Pushes that only touch `website/` don't publish test builds.

## Checks before pushing

```bash
cd browser && python -m pytest -q
cd standalone && cargo test --locked
```

The Rust GUI code also needs to compile for Windows (`cargo check --target x86_64-pc-windows-gnu` works on Linux with mingw installed).

## Audience and licence

- The README, CHANGELOG, release notes, Terms, Privacy Policy and in-app text are for everyday users: plain language, no build details or internal branch names. Developer material goes in CONTRIBUTING.md.
- Everything except `browser/` is under the Location Spoofer License (`LICENSE`, all rights reserved). `browser/` is GPL-3.0-or-later with section 7 attribution terms (`browser/NOTICE`) because it bundles GPL libraries. Don't add open-source licence headers or change these licences.
