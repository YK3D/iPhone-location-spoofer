# Third-party notices

Location Spoofer is built on open-source software and public data services. This file lists what is included in each edition, under which licence, and which online services the app uses at run time.

## Licences of this project

| Part | Licence |
|---|---|
| Standalone app (`standalone/`), shared interface (`ui/`), icon artwork (`assets/`), documentation | Location Spoofer License, © YK3D, all rights reserved (source-available; reuse needs written permission and credit). See [LICENSE](LICENSE) |
| Browser version (`browser/`) and the `LocationSpooferBrowser.exe` build | GNU GPL v3 or later with additional attribution terms. See [browser/LICENSE](browser/LICENSE) and [browser/NOTICE](browser/NOTICE) |

The licences below belong to the third-party components and are not changed by this project's licence.

## Included in both editions

| Component | Use | Licence |
|---|---|---|
| [Leaflet](https://leafletjs.com/) 1.9.4 (`ui/vendor/leaflet`) | Interactive map | BSD-2-Clause, © 2010–2023 Volodymyr Agafonkin, © 2010–2011 CloudMade. See `ui/vendor/leaflet/LICENSE` |
| [MapLibre GL JS](https://maplibre.org/) 5.24.0 (`ui/vendor/maplibre`) | Draws the OpenFreeMap vector map | BSD-3-Clause, © MapLibre contributors, © Mapbox. See `ui/vendor/maplibre/LICENSE-maplibre-gl.txt` |
| [MapLibre GL Leaflet](https://github.com/maplibre/maplibre-gl-leaflet) 0.1.4 (`ui/vendor/maplibre`) | Shows the MapLibre map inside Leaflet | ISC, © MapLibre contributors. See `ui/vendor/maplibre/LICENSE-maplibre-gl-leaflet.txt` |
| Marine network from [searoute](https://github.com/genthalili/searoute-py) (`standalone/data/marnet_searoute.geojson`; bundled with the `searoute` package in the browser version) | Sea-lane routing | Apache-2.0 (searoute). The network derives from Eurostat's [SeaRoute](https://github.com/eurostat/searoute) (EUPL-1.2) |

## Standalone app (`LocationSpooferStandalone.exe`)

| Component | Use | Licence |
|---|---|---|
| [idevice](https://github.com/jkcoxson/idevice), [jktcp](https://crates.io/crates/jktcp) | iPhone communication (usbmuxd, lockdown, CoreDevice tunnel, DVT) | MIT |
| [wry](https://github.com/tauri-apps/wry), [tao](https://github.com/tauri-apps/tao) | Native window and Microsoft WebView2 | Apache-2.0 OR MIT |
| [axum](https://github.com/tokio-rs/axum), [tokio](https://tokio.rs/), [reqwest](https://github.com/seanmonstar/reqwest), [rustls](https://github.com/rustls/rustls), [ring](https://github.com/briansmith/ring) | Local server, networking, TLS | MIT / Apache-2.0 / ISC-style (ring) |
| [cssparser](https://github.com/servo/rust-cssparser), [selectors](https://github.com/servo/stylo), [dtoa-short](https://github.com/upsuper/dtoa-short), [option-ext](https://github.com/soc/option-ext) | Used by the window and settings-folder libraries | MPL-2.0. Included unmodified; their source code is available from [crates.io](https://crates.io/) at the versions listed in `standalone/Cargo.lock` |
| [serde](https://serde.rs/), [roxmltree](https://github.com/RazrFalcon/roxmltree), [chrono](https://github.com/chronotope/chrono), [plist](https://github.com/ebarnard/rust-plist), [png](https://github.com/image-rs/image-png) and the other crates listed in `standalone/Cargo.lock` | Parsing, data formats | MIT and/or Apache-2.0 (each crate's own licence applies) |
| Microsoft Edge WebView2 Runtime | Renders the interface; part of Windows, not redistributed | Microsoft software licence terms |

## Browser version (`LocationSpooferBrowser.exe`)

The exe bundles a Python runtime and these packages, with their dependencies, via PyInstaller:

| Component | Use | Licence |
|---|---|---|
| [pymobiledevice3](https://github.com/doronz88/pymobiledevice3), pmd-pytcp, pytun-pmd3, developer-disk-image, ipsw-parser | iPhone communication | GPL-3.0-or-later |
| [FastAPI](https://fastapi.tiangolo.com/), [Starlette](https://www.starlette.io/), [Uvicorn](https://www.uvicorn.org/), [httpx](https://www.python-httpx.org/), [Pydantic](https://docs.pydantic.dev/) | Local server, networking | MIT / BSD-3-Clause |
| [searoute](https://github.com/genthalili/searoute-py), [networkx](https://networkx.org/) | Sea routing | Apache-2.0 / BSD-3-Clause |
| [defusedxml](https://github.com/tiran/defusedxml) | Safe GPX parsing | PSF-2.0 |
| CPython | Runtime | PSF-2.0 |
| [PyInstaller](https://pyinstaller.org/) bootloader | Single-file exe | GPL-2.0 with an exception that allows bundling (the bootloader does not change the app's licence) |

Each package's full licence text is included inside the exe's bundled package metadata. The complete source of the browser version is this repository's `browser/` folder; the exact dependency versions are pinned in `browser/requirements.txt` at the release's commit.

## Apple and Google material

* **Apple Developer Disk Images** are downloaded at run time from [github.com/doronz88/DeveloperDiskImage](https://github.com/doronz88/DeveloperDiskImage) when the iPhone needs one. They are Apple's software and are not part of this repository or its releases.
* **Apple's device driver and service** (Apple Devices app, iTunes or Windows Update) are installed by the user from Apple or Microsoft and are not redistributed.
* **Google Maps** content (routes, map tiles) is used only with the user's own API key, under the Google Maps Platform Terms. Google content is not cached or exported by the app.

## Online services used at run time

See [PRIVACY.md](PRIVACY.md) for what each one receives.

| Service | Used for | Terms |
|---|---|---|
| OpenFreeMap | Default map (vector tiles, dark and light styles) | [Terms of service](https://openfreemap.org/tos/). © OpenMapTiles, map data © OpenStreetMap contributors |
| OpenStreetMap tiles, Nominatim | OpenStreetMap map, place search | [Tile policy](https://operations.osmfoundation.org/policies/tiles/), [Nominatim policy](https://operations.osmfoundation.org/policies/nominatim/). Map data © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright) |
| routing.openstreetmap.de (FOSSGIS e.V.) | Road, cycle and foot routing | [Service info](https://routing.openstreetmap.de/about.html) |
| Overpass API | Optional speed limits | [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) |
| Esri World Imagery | Satellite layer | Esri terms of use |
| OpenTopoMap | Topographic layer | CC-BY-SA, see [opentopomap.org](https://opentopomap.org/about) |
| Google Routes API, Map Tiles API (optional) | Google routing and map | [Google Maps Platform Terms](https://cloud.google.com/maps-platform/terms) |
| GitHub | Updates, Developer Disk Images | [GitHub Terms](https://docs.github.com/site-policy/github-terms/github-terms-of-service) |
