# Third-party components

| Component | Use | Licence |
|---|---|---|
| [idevice](https://github.com/jkcoxson/idevice) and [jktcp](https://crates.io/crates/jktcp) | Talking to the iPhone (usbmuxd, lockdown, CoreDevice tunnel, DVT) | MIT |
| [Leaflet](https://leafletjs.com/) 1.9.4 (`ui/vendor/leaflet`) | Map display | BSD-2-Clause |
| Marine network `data/marnet_searoute.geojson` from [searoute](https://github.com/genthalili/searoute-py) | Sea-lane routing | Apache-2.0 (searoute); the network derives from Eurostat's [SeaRoute](https://github.com/eurostat/searoute) |
| [wry](https://github.com/tauri-apps/wry) / [tao](https://github.com/tauri-apps/tao) | Native window and WebView2 | Apache-2.0 / MIT |
| axum, tokio, reqwest, serde, roxmltree and other crates in `Cargo.lock` | Server, networking, parsing | MIT and/or Apache-2.0 |

## Online services used at run time

| Service | Used for | Terms |
|---|---|---|
| OpenStreetMap tiles, Nominatim, routing.openstreetmap.de (FOSSGIS), Overpass API | Map, place search, routing, speed limits | OpenStreetMap / FOSSGIS usage policies (fair use, attribution) |
| Esri World Imagery, OpenTopoMap | Satellite and topographic layers | Provider terms |
| Google Routes API and Map Tiles API (optional, user's own key) | Google routing and Google basemap | Google Maps Platform Terms |
| github.com/doronz88/DeveloperDiskImage | Apple Developer Disk Image when the iPhone has none mounted | Images are Apple's; see that repository |
