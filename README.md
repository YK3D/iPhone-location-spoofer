# iPhone Location Spoofer — browser version

> This is the **Browser application** branch (Python, the app's window is your web browser).
> The **Standalone application** branch is a Rust rewrite that runs as a native Windows app.

A local desktop app (it runs in your browser) for setting your iPhone's location from a Windows, macOS or Linux computer over a USB cable. It sends the location through [pymobiledevice3](https://github.com/doronz88/pymobiledevice3), the same tool used in the step-by-step guide *"Changing Your iPhone Location from a Windows Laptop"*. The app replaces typing commands with a map.

> Only use it where it is allowed, for example when testing your own apps or for privacy. Games, dating, school and work apps often ban fake locations and can suspend your account. Some apps also check Wi-Fi, IP address or motion sensors, and this tool does not change any of those.

## Features

| Area | What you can do |
|---|---|
| **Map** | Street, satellite and topographic layers. Click to pick a point; right-click to teleport there at once. |
| **Manual coordinates** | Paste `19.0761, 72.8775`, `40.7128 -74.0060` or DMS (`40°42'46"N 74°00'21"W`). |
| **Place search** | Search by place name with OpenStreetMap Nominatim. Typing coordinates in the search box also works. |
| **Route builder** | Click to add checkpoints, drag them to move, and reorder or reverse them. Each leg between two checkpoints follows its own path: **roads (car)**, **cycle paths**, **footpaths**, **sea lanes** or a **straight line**. |
| **Speed control** | Set a default speed and per-leg cruise speeds. A checkpoint can have an exact **"speed here"** (a speed checkpoint) and a **wait time** (stop for *n* seconds). |
| **Uniform acceleration** | Every speed change uses constant acceleration. **Accel rate** mode uses your m/s² values: it speeds up as early as possible and brakes as late as possible. **Even ramp** mode spreads one constant acceleration over the whole leg, from the speed at its start checkpoint to the speed at its end checkpoint. A speed-vs-time chart shows the result. |
| **GPX upload** | Reads tracks, routes and waypoints (GPX 1.0/1.1). It can replay the file's own timestamps, re-time the track with your speed and acceleration, play it in reverse, or turn it into editable checkpoints. |
| **GPX export** | Saves any route as a timed GPX file (0.5–10 s between points). The file plays with `pymobiledevice3 … simulate-location play`. |
| **Player** | Play, pause, resume, stop and seek. Time speed runs from 0.25× to 30×. When a route ends it can stop, loop, or go back and forth (ping-pong). Optional GPS jitter and a configurable update interval. A live marker and trail show the spoofed position. |
| **Joystick** | Walk or drive live with W A S D, the arrow keys or the on-screen pad, at any speed. |
| **Google Maps** | Paste any Google Maps link (place, pin, search, `maps.app.goo.gl` short link or a directions link with stops) to jump there or import the stops as a route. With your own API key (⚙ Settings), routes can come from the **Google Routes API**; they are then shown on Google's own map tiles, as Google's terms require, and cannot be exported as GPX. |
| **Road-aware driving (experimental)** | Follows each road's typical speed from the routing service, optionally capped by public **OpenStreetMap speed limits** (Overpass). It slows down for sharp bends, roundabouts and **U-turns** (from turn radius) and for private, gated or unmapped access roads. It can tune the driving style so the trip time lands near the **Google Maps / OSRM ETA**, shown side by side as a reference. |
| **Speed colours** | The route line is coloured by speed (blue = slow, red = fast) with a legend; hover a stretch to see its speed range. |
| **Help built in** | A first-run setup guide (reopen with **?**) and grey **(i)** buttons that explain every device tool and option. |
| **Extras** | Random-wander generator (random checkpoints with short pauses), return-to-start loops, and speed presets (walk, jog, cycle, car, highway, boat, train, plane). A jump-distance warning shows the real travel time for a teleport. Favourites, saved routes, JSON backup and restore, and a Simulator mode for trying everything without an iPhone. |

## Install and run

### Windows: the .exe (recommended)

1. Install the **Apple Devices** app from the Microsoft Store (Part 1, Step 1 of the guide). You do **not** need Python.
2. Download **`LocationSpoofer.exe`** from the [latest release](https://github.com/YK3D/iPhone-location-spoofer/releases/latest). Put it in a folder you own, such as your Desktop or `Documents`, not `Program Files`, so it can update itself.
3. Double-click it. The first start takes 10 to 20 seconds while it unpacks. A console window opens (this is the app; closing it quits) and the map opens in your browser.
4. Connect the iPhone, tap **Trust**, and turn on Developer Mode with *Device tools → Reveal Developer Mode* (Part 2 of the guide). Then pick **Direct** and press **Connect**.

**iOS 17.0–17.3 only:** press *Device tools → Start tunnel helper (admin)*, accept the Windows prompt and leave the new window open. iOS 17.4 and newer, and iOS 16 and older, do not need it.

Windows SmartScreen may warn that the app is from an unknown publisher, because the exe is not code-signed. Choose *More info → Run anyway*.

### Automatic updates

* Every push to `main` that changes code runs the tests, builds a new exe on GitHub Actions, checks that the exe starts and contains everything it needs, then publishes it as the latest [release](https://github.com/YK3D/iPhone-location-spoofer/releases) with a SHA-256 checksum.
* The exe checks for a new release when it starts and every 6 hours after that. It downloads the update in the background and checks the SHA-256.
* A banner then offers **Restart now**. If you ignore it, the update installs the next time you open the app. Your favourites and routes are kept.
* To turn update checks off, start the app with `LocationSpoofer.exe --no-update`. *Device tools → Check for updates* checks on demand.

### Windows from source (the guide's Python setup)

1. Install Python 3.12 (Part 1 of the guide).
2. Double-click **`run_windows.bat`**. The first run creates a private `.venv` folder and installs the requirements.
3. To update, run `git pull`. Source copies do not update themselves.

### macOS / Linux

```bash
./run_mac_linux.sh
```

Linux also needs `usbmuxd` installed and running.

### Command-line options

```bash
python -m spoofer --port 8765 --no-browser --host 127.0.0.1 --no-update
LocationSpoofer.exe --version
```

## Google Maps API key (optional)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and an API key.
2. Enable **Routes API** and **Map Tiles API** for the project. Google bills per request after its monthly free usage.
3. Restrict the key to those two APIs. Paste it in **⚙ Settings** and press **Test key**.

Without a key, routing uses the free OpenStreetMap services and Google Maps *links* still work.

## Connection methods

| Method | How it works | Use it when |
|---|---|---|
| **Direct** (default) | Keeps one pymobiledevice3 connection open inside the app. On iOS 17+ it opens the no-admin userspace tunnel and mounts the Developer Disk Image when needed. | Always try this first. You need it for smooth routes, pause and resume, and the joystick. |
| **Guide commands** | Runs the exact CLI commands from the guide (`developer dvt simulate-location set/play/clear`). Routes are written to a temporary GPX file and played with `play`. | Direct fails with your pymobiledevice3 version. Each change takes a few seconds, and the joystick is disabled. |
| **Simulator** | Sends nothing to a phone. | Trying the app or building GPX files with no iPhone. |

**Stop spoofing — back to real location** sends `clear`. If the location still looks wrong, restart the iPhone (Part 5 of the guide).

## How the speed profile works

1. Each leg is routed: road, cycle and foot paths come from OSRM servers on OpenStreetMap data (`routing.openstreetmap.de`), and sea lanes come from the offline `searoute` marine network. The result is split into steps of at most 2 m.
2. Every point gets a speed cap: the leg's cruise speed, a checkpoint's exact speed, 0 at a wait, and optionally 0 at the start and end.
3. A forward pass applies the acceleration limit and a backward pass applies the deceleration limit (`v² = v₀² + 2·a·d`). The result is the fastest profile that keeps every limit, with constant acceleration inside each step.
4. Time for each step is `2·d / (v₀ + v₁)`, and position at any moment uses the closed form `s = v₀·t + ½·a·t²`.

If a checkpoint's speed cannot be reached with your acceleration settings, the route summary shows a warning saying so. The app never silently ignores it.

## Limitations

* **Not yet tested against a physical iPhone.** The geometry, GPX and API code has automated tests (`pytest`), and the Simulator mode and full UI were exercised in a browser. The Direct driver was written against the pymobiledevice3 11.49 API, which changed a lot between major versions; hence the `<12` pin and the CLI fallback.
* **Route-finding needs internet** (OSRM and place search). Straight and sea legs work offline. The public OSRM and Nominatim servers are free community services with fair-use limits. Set `SPOOFER_OSRM_CAR`, `SPOOFER_OSRM_BIKE`, `SPOOFER_OSRM_FOOT` or `SPOOFER_NOMINATIM` to use your own servers.
* **Road-aware driving is experimental.** Typical road speeds and ETAs come from the routing service; speed limits come from OpenStreetMap, which is incomplete in many areas. The public Overpass server is often busy, and when it fails the route is still built without speed limits. Google's own speed-limit data needs a special Asset Tracking licence and is not used.
* **Sea routes** follow a coarse global shipping-lane network. They are good for ocean crossings but not for harbours or small lakes; use straight legs there.
* **What happens after you stop.** iOS may keep showing the simulated location after the app stops sending it. Always use **Stop spoofing** when you finish.
* **How far the update check reaches.** The checksum proves the download arrived intact from this repository's release. It does **not** prove who wrote the code: anyone who can push to `main` can ship code to every installed copy. Protect the branch (and your GitHub account with 2FA) accordingly. The exe is not code-signed.
* **Size and start time.** The single-file exe is about 90 MB and unpacks to a temporary folder on each start. The *Guide commands* connection method starts a second copy of the exe for each command, which is slow; use *Direct*.
* **Server address.** The app only listens on `127.0.0.1` by default. If you expose it with `--host 0.0.0.0`, anyone on your network can move your phone.

## Development

```bash
pip install -r requirements-dev.txt
python -m pytest -q
# build the exe locally (on Windows for a .exe)
pip install pyinstaller==6.22.3
python packaging/build_exe.py --version 1.1.0
dist/LocationSpoofer --self-test
```

Project layout:

```
spoofer/
  profile.py      speed-profile engine (accel/decel, checkpoints, waits)
  routing.py      OSRM, Google, searoute and straight-line routing; place search
  google_api.py   Google Routes API, Map Tiles sessions, polyline decoding
  gmaps_links.py  Google Maps link parsing (incl. short links and directions)
  road_speed.py   OpenStreetMap speed limits / road classes (Overpass)
  gpx_io.py       GPX parsing (defusedxml) and writing
  player.py       playback, loop/ping-pong, jitter, joystick
  device/         pmd3 (direct API), cli (guide commands), mock (simulator)
  server.py       FastAPI app and JSON API
  updater.py      self-update from GitHub Releases (exe build only)
  static/         Leaflet map UI (no build step)
packaging/        PyInstaller build script for the exe
.github/workflows release.yml: test, build, self-test and publish on every push to main
tests/            pytest suite
```

Your data (favourites, saved routes, settings) is stored in `%APPDATA%\iPhoneLocationSpoofer\data.json` on Windows and `~/.iphone-location-spoofer/data.json` on macOS and Linux.
