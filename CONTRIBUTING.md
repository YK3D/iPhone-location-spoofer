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
