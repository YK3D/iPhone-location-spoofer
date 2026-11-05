# Contributing

Bug reports and ideas are welcome as [GitHub issues](https://github.com/YK3D/iPhone-location-spoofer/issues). You don't need to know how to code: describe what you did, what you expected and what happened, and include the app's version (*Settings › About*).

## Licence of contributions

Location Spoofer is source-available, not open source (see [LICENSE](LICENSE)). By opening a pull request you confirm that you have the right to submit the change, and you grant YK3D the licence described in section 4 of [LICENSE](LICENSE), so the change can be included and relicensed with the app. You keep the copyright in your contribution and are credited in the history.

## Trying a feature test

Feature tests are experiments in pull requests into the `feature-testing` branch. *Settings › Updates › Show feature tests* in the app lists them and opens one on GitHub. They have no download yet, so they are run from the source code:

```bash
git clone https://github.com/YK3D/iPhone-location-spoofer.git
cd iPhone-location-spoofer
git checkout feature-testing      # or one pull request: git fetch origin pull/<number>/head:test && git checkout test

# standalone app (needs Rust: https://rustup.rs)
cd standalone
cargo run --release

# or the browser edition (needs Python 3.12): double-click browser/run_windows.bat, or
cd browser
pip install -r requirements.txt
python -m spoofer                  # opens http://127.0.0.1:8765
```

Set `SPOOFER_DATA_DIR` to an empty folder first if you don't want the experiment to touch your saved routes and settings. Comment on the pull request with what worked and what didn't.

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
| `docs/screenshots/` | README screenshots; `capture.js` makes them |

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
