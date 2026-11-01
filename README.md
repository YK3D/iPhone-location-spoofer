# iPhone Location Spoofer

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
| **Extras** | Random-wander generator (random checkpoints with short pauses), return-to-start loops, and speed presets (walk, jog, cycle, car, highway, boat, train, plane). A jump-distance warning shows the real travel time for a teleport. Favourites, saved routes, JSON backup and restore, and a Simulator mode for trying everything without an iPhone. |

## Install and run

### Windows (matches the guide)

1. Do Part 1 of the guide once: install the **Apple Devices** app and **Python 3.12** (tick *Add python.exe to PATH*).
2. Do Part 2 once: connect the iPhone, tap **Trust** and switch on **Developer Mode**. The app's *Device tools → Reveal Developer Mode* button does the same as the guide's `amfi reveal-developer-mode` command.
3. Double-click **`run_windows.bat`**. The first run creates a private `.venv` folder and installs the requirements (a few minutes). The app then opens at <http://127.0.0.1:8765/>.
4. Keep the Apple Devices app open and the iPhone unlocked. Pick **Direct** and press **Connect**.

**iOS 17.0–17.3 only:** right-click **`start_tunneld.bat`**, choose *Run as administrator* and leave that window open while you use the app. iOS 17.4 and newer, and iOS 16 and older, do not need it.

### macOS / Linux

```bash
./run_mac_linux.sh
```

Linux also needs `usbmuxd` installed and running.

### Command-line options

```bash
python -m spoofer --port 8765 --no-browser --host 127.0.0.1
```

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
* **Sea routes** follow a coarse global shipping-lane network. They are good for ocean crossings but not for harbours or small lakes; use straight legs there.
* **What happens after you stop.** iOS may keep showing the simulated location after the app stops sending it. Always use **Stop spoofing** when you finish.
* **Server address.** The app only listens on `127.0.0.1` by default. If you expose it with `--host 0.0.0.0`, anyone on your network can move your phone.

## Development

```bash
pip install -r requirements-dev.txt
python -m pytest -q
```

Project layout:

```
spoofer/
  profile.py      speed-profile engine (accel/decel, checkpoints, waits)
  routing.py      OSRM, searoute and straight-line routing; place search
  gpx_io.py       GPX parsing (defusedxml) and writing
  player.py       playback, loop/ping-pong, jitter, joystick
  device/         pmd3 (direct API), cli (guide commands), mock (simulator)
  server.py       FastAPI app and JSON API
  static/         Leaflet map UI (no build step)
tests/            pytest suite
```

Your data (favourites, saved routes, settings) is stored in `%APPDATA%\iPhoneLocationSpoofer\data.json` on Windows and `~/.iphone-location-spoofer/data.json` on macOS and Linux.
