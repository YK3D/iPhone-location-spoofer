# Roadmap

Ideas being considered for future versions. None of them is promised; suggestions are welcome as GitHub issues.

## Next up
- **No Apple Devices app needed:** a built-in device service, being tested on the `feature/no-apple-devices` branch.
- **Code-signed releases**, so Windows stops showing the "unknown publisher" warning.
- **Microsoft Store edition**, once the standalone app is mature.

## Routes and movement
- Speed profiles you can save and reuse ("cautious driver", "cyclist", "commuter").
- Traffic-light and stop-sign pauses from OpenStreetMap data.
- Altitude from elevation data, and a slower climb uphill for walking and cycling.
- Public-transport style routes: dwell at stations, a timetable mode.
- Schedule a route to start at a set time, or repeat it every day.
- Multi-stop optimisation (best order to visit several places).
- Snap a hand-drawn line to the nearest roads.
- Import KML/KMZ and GeoJSON in addition to GPX.

## Realism
- Realistic GPS noise models (urban canyon, open sky), and a slow drift when standing still.
- Heading and speed values that apps reading course and speed would see. Apple's location simulation only carries a position; this needs a different way of setting the location (see the discussion in the pull request that added the live HUD).
- "Rest stops" that are inserted automatically on long drives.

## Comfort
- Several iPhones at once, each with its own route.
- Wi-Fi connection after the first USB pairing.
- Map layer with live position history and a route timeline scrubber.
- Search history and recent places.
- More languages for the interface.
- Portable mode (settings stored next to the `.exe`).

## For developers
- A small local HTTP API and command line, so test scripts can drive the app.
- Record and replay test sessions for app QA.
