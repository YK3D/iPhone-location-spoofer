# Contributing

Thanks for helping. Bug reports and ideas are welcome as GitHub issues.

## Branches

- **`main`**: stable releases. Changes reach it from `dev` through a release pull request.
- **`dev`**: standard features and fixes. Open pull requests against `dev`. Every push to `dev` publishes test builds (pre-releases), which installed apps receive only when *Settings › Updates* is set to *Test builds*.
- **`feature-testing`**: risky or experimental work, such as changes to the speed or physics engine, the playback engine or the way the app talks to the iPhone. Pull requests into `feature-testing` use auto-merge, so experiments land quickly where they can be tried; they move on to `dev` once they have been tested.

## Before you open a pull request

- Both editions share the interface in `ui/`. A change to the server API or the speed engine needs the same change in `browser/` (Python) and `standalone/` (Rust), with tests in both.
- Run the tests:

  ```bash
  cd browser && python -m pytest -q
  cd standalone && cargo test --locked
  ```

- Keep `assets/icon/source.jpg` as it is; regenerate icons with `python assets/icon/make_icons.py`.
- Update `CHANGELOG.md` under *Unreleased*.

## Trying the `feature-testing` branch

`feature-testing` publishes no downloads, so run it from source:

```bash
git clone https://github.com/YK3D/iPhone-location-spoofer.git
cd iPhone-location-spoofer
git checkout feature-testing      # later: git pull to get new experiments

# browser edition (Python 3.12)
cd browser
pip install -r requirements.txt
python -m spoofer                  # opens http://127.0.0.1:8765

# or the standalone app (Rust)
cd standalone
cargo run --release
```

Use a separate data folder if you don't want experiments to touch your saved routes and settings: set `SPOOFER_DATA_DIR` to an empty folder before starting. Switch back with `git checkout dev` (or `main`).
