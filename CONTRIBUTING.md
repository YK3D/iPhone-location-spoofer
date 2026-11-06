# Contributing

Bug reports and ideas are welcome as [GitHub issues](https://github.com/YK3D/iPhone-location-spoofer/issues). You don't need to know how to code: describe what you did, what you expected and what happened, and include the app's version (*Settings › About*).

## Licence of contributions

Location Spoofer is source-available, not open source (see [LICENSE](LICENSE)). By opening a pull request you confirm that you have the right to submit the change, and you grant YK3D the licence described in section 4 of [LICENSE](LICENSE), so the change can be included and relicensed with the app. You keep the copyright in your contribution and are credited in the history.

## Feature tests

Feature tests are experiments in pull requests. For every pull request from this repository into the `feature-testing` branch, `.github/workflows/feature-tests.yml` builds the standalone app, encrypts it with the developer password and uploads it, with an encrypted list of builds, to the `feature-tests` pre-release. Any other pull request (open or merged) can be built from the *Actions* tab: *Feature-test builds › Run workflow*, with its number.

In the app, click the *About* tab in Settings 7 times to turn on developer mode. *Settings › Updates › Developer access* then unlocks the list with the password and downloads every build in the background; *Open* checks a build and starts it as a separate app in its own window (own data folder, own port, no self-update). The builds are Windows apps.

**Setup (once):** add a repository secret named `FEATURE_TEST_PASSWORD` (GitHub › Settings › Secrets and variables › Actions) with a long password. Without it the workflow builds nothing. Changing it later makes older builds unreadable with the new password; push to the pull requests again to rebuild them.

What this protects: the builds and the list of builds. The pull requests and their source code stay public, like the rest of the repository.

To try a feature test from source instead:

```bash
git clone https://github.com/YK3D/iPhone-location-spoofer.git
cd iPhone-location-spoofer
git fetch origin pull/<number>/head:test && git checkout test

# standalone app (needs Rust: https://rustup.rs)
cd standalone
cargo run --release

# or the browser edition (needs Python 3.12): double-click browser/run_windows.bat, or
cd browser
pip install -r requirements.txt
python -m spoofer                  # opens http://127.0.0.1:8765
```

Set `SPOOFER_DATA_DIR` to an empty folder first if you don't want the experiment to touch your saved routes and settings.

## Branches

- **`main`**: stable releases. Changes reach it from `dev` through a release pull request.
- **`dev`**: standard features and fixes. Open pull requests against `dev`. Every push to `dev` publishes test builds (pre-releases), which installed apps receive only when *Settings › Updates* is set to *Test builds*.
- **`feature-testing`**: risky or experimental work, such as changes to the speed or physics engine, the playback engine or the way the app talks to the iPhone. Pull requests into `feature-testing` use auto-merge; they move on to `dev` once they have been tried.

## Repository layout

| Folder | Contents |
|---|---|
| `standalone/` | Standalone app (Rust): local server, iPhone driver, routing, speed engine, native window |
| `browser/` | Browser edition (Python, FastAPI) |
| `ui/` | The interface both editions serve (HTML, CSS, JavaScript; no build step) |
| `assets/icon/` | Icon artwork; `make_icons.py` regenerates every icon file from `source.jpg` |
| `docs/screenshots/` | README screenshots; `capture.js` makes them, and `website/scripts/record-clips.cjs` makes the animation (`demo.webp`) with the website's clips |
| `website/` | The showcase website with an in-browser demo (Vite + React, hosted on Vercel); see `website/README.md` |

## Before you open a pull request

- Both editions share the interface in `ui/`. A change to the server API or the speed engine needs the same change in `browser/` and `standalone/`, with tests in both.
- Run the tests:

  ```bash
  cd browser && pip install -r requirements-dev.txt && python -m pytest -q
  cd standalone && cargo test --locked
  ```

  On Linux the standalone app needs `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev`.
- Keep `assets/icon/source.jpg` as it is; regenerate icons with `python assets/icon/make_icons.py`.
- Describe user-visible changes in `CHANGELOG.md` under *Unreleased*, in plain language.
