# Location Spoofer — standalone application (Rust)

> This is the **Standalone application** branch: a native Windows app written in Rust, no Python and no browser needed.
> The original Python app, whose window is your web browser, lives on the **Browser application** branch.
> Both share the same interface, so they look and work the same.

Set your iPhone's GPS location from your computer over a USB cable. You can jump to any place, follow roads, footpaths or sea lanes at realistic speeds, replay GPX files, or walk around live with the keyboard.

> Only use it where it is allowed, for example when testing your own apps. Games, dating, school and work apps often ban fake locations and can suspend accounts. Apps can also check Wi-Fi, IP address and motion sensors, which this tool does not change.

## Download and run (Windows 10/11)

1. Install **Apple Devices** from the Microsoft Store (or iTunes). It provides the Apple service that lets Windows talk to an iPhone. Leave it running in the background.
2. Download **`LocationSpooferStandalone.exe`** from the [releases tagged `standalone-v…`](https://github.com/YK3D/iPhone-location-spoofer/releases). Put it in a folder you own, such as your Desktop or Documents.
3. Double-click it. A normal app window opens. The first-run guide walks you through **Trust**, **Developer Mode** and **Connect**.

The window uses Microsoft's WebView2, which is built into Windows 11 and present on up-to-date Windows 10. Windows SmartScreen may warn about an unknown publisher until the app is code-signed; choose *More info → Run anyway*.

## What is different from the browser version

| | Standalone (this branch) | Browser version |
|---|---|---|
| Language | Rust, one small exe | Python packaged into a ~80 MB exe |
| Window | Native app window (WebView2) | Your web browser plus a console window |
| Start-up | Instant | 10–20 s (unpacks Python) |
| iPhone library | [idevice](https://github.com/jkcoxson/idevice) (MIT) | pymobiledevice3 (GPL-3.0) |
| iOS 17.4+ | Userspace tunnel, no admin | Userspace tunnel, no admin |
| iOS 17.0–17.3 | **Not supported** | Supported with the admin tunnel helper |
| iOS 16 and older | Supported | Supported |
| Connection methods | Direct, Simulator | Direct, Guide commands (CLI), Simulator |
| Updates | GitHub releases `standalone-v*`; disabled in the Store build | GitHub releases `v*` |

Both apps still need Apple's Mobile Device Service from the Apple Devices app. See `docs/research/standalone-native-app.md` on the research branch for the untested route to removing that dependency (Windows Update driver plus netmuxd). The app honours `USBMUXD_SOCKET_ADDRESS`, so a replacement service can be tried without code changes.

## Features

* **Map:** street, satellite and topographic layers. Click to pick a point; right-click to teleport there.
* **Input:** coordinates in decimal or degrees-minutes-seconds, place search, and **Google Maps links** (places, pins, `maps.app.goo.gl` short links, and directions links with several stops).
* **Routes:** checkpoints connected by roads, cycle paths or footpaths (OpenStreetMap, or **Google Routes** with your own API key), sea lanes (offline), or straight lines.
* **Speeds:**
  * per-leg cruise speeds, exact speeds at chosen checkpoints, and wait times;
  * steady (uniform) acceleration and braking, either at a set rate or evenly spread over a leg;
  * the route line is coloured by speed.
* **Road-aware driving (experimental):**
  * follows each road's typical speed, capped by public speed limits from OpenStreetMap;
  * slows down for bends, roundabouts and U-turns, and for private or gated access roads;
  * tunes the driving style towards the Google Maps or OpenStreetMap trip time (ETA), shown side by side.
* **GPX:** drop in a file to replay it, re-time it, reverse it, or turn it into checkpoints. Routes can also be exported as GPX, except Google routes, whose terms forbid storing them.
* **Playback:** play, pause, seek, 0.25×–30× time speed, loop or back-and-forth, GPS jitter, and a live joystick (W A S D keys).
* **Help built in:** a setup guide on first run, grey **(i)** buttons that explain every tool, favourites, saved routes and backups.

## Build from source

```bash
# Linux needs: libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev
cargo run --release                 # native window
cargo run --release -- --no-window  # opens your browser instead
cargo test
./target/release/location-spoofer --self-test
```

Options:

| Option | Effect |
|---|---|
| `--port 8766` | Port for the app's local server (default 8766) |
| `--no-window` | Open in the browser instead of an app window |
| `--no-update` | Don't check GitHub for updates |
| `--self-test` | Check the build and exit |
| `--version` | Print the version and exit |

Environment variables:

| Variable | Effect |
|---|---|
| `SPOOFER_DATA_DIR` | Where favourites, routes and settings are stored |
| `USBMUXD_SOCKET_ADDRESS` | Use a different device service instead of Apple's |
| `SPOOFER_OSRM_CAR`, `SPOOFER_OSRM_BIKE`, `SPOOFER_OSRM_FOOT` | Your own routing servers |
| `SPOOFER_NOMINATIM` | Your own place-search server |
| `SPOOFER_OVERPASS` | Your own speed-limit (Overpass) server |

Every code push to this branch builds, self-tests and publishes the Windows exe (`.github/workflows/standalone.yml`).

## Publishing to the Microsoft Store

1. Build the Store flavour without the self-updater: `cargo build --release --features store`.
2. Fill in `packaging/msix/AppxManifest.xml` with the identity from Partner Center, add the logo images, then pack it with `makeappx pack` (Windows SDK). The Store signs the package.
3. The listing must:
   * disclose the dependency on Apple's device software (Store policy 10.2.4);
   * link a privacy policy, because routes and searches go to OpenStreetMap or Google (policy 10.5);
   * use a name without "iPhone", because of Apple's trademark rules. "for iPhone" in the description is generally acceptable. The manifest uses "GPS Route Simulator" as a placeholder.

Review of a location-simulation app is not guaranteed. Presenting it as a developer and testing tool is the safer framing.

## Limitations

* **Not yet tested with a physical iPhone.** The device code follows `idevice`'s own location-simulation example. Everything else was checked with automated tests and the built-in Simulator.
* **iOS 17.0–17.3** cannot open the developer tunnel without administrator rights, which this app does not use. Update the iPhone or use the browser version.
* **iOS 27 and later** install the developer disk image as a "cryptex", which isn't implemented yet. If the image is already mounted, for example by Xcode, the app works.
* Speed limits come from OpenStreetMap, which is incomplete, and the public Overpass server is often busy. The route still builds without them.

See `THIRD_PARTY_NOTICES.md` for licences and online services.
