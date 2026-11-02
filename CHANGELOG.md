# Changelog

Releases are published separately for the two editions:
[standalone app](https://github.com/YK3D/iPhone-location-spoofer/releases?q=standalone&expanded=true) (`standalone-v…`) and
[browser edition](https://github.com/YK3D/iPhone-location-spoofer/releases?q=browser&expanded=true) (`browser-v…`).
Test builds from the `dev` branch are marked as pre-releases.

## Unreleased (dev)

### New
- Alternative routes: choose "Up to 1/2/3" in Routing & speed, then pick a route in Route summary or click a grey line on the map. OpenStreetMap usually offers one alternative, so the app also looks for detours either side of the main route and keeps only sensible ones (no U-turns, no driving a road twice, no more than 50 % slower). Google offers up to three.
- The Build route button now fills the whole row and works as a progress bar: it shows each step the app is working on (routing each leg, speed limits, turns, ETA) and how far along it is. Reverse and Clear sit underneath.
- Drag checkpoints by their handle to reorder them; the other rows slide out of the way, and a checkpoint shrinks slightly when pressed, lifts while dragged and settles when dropped (on the map too). The arrow keys move a focused handle.
- The route line has a dark outline and a light halo, so it stands out from roads on every map layer.
- App icon, also shown on the window and the `.exe`.
- Screenshots in the README.
- 17 colour themes, a compact layout and an optional darker map for dark themes.
- Folding sections that stay as you left them, a side menu you can resize (drag its edge) or hide (**M**), and equal-width buttons.
- Single-key keyboard shortcuts for common actions, customisable in Settings › Shortcuts (press **H** for the list).
- "Stop spoofing" and "Show my real location" now show your computer's real location on the map.
- Undo after clearing checkpoints or deleting favourites and saved routes.
- Settings window with Appearance, Shortcuts, Google Maps, Updates and About pages; links to the Terms of Use and Privacy Policy.
- Update channels: stable releases, or opt-in test builds.

### Fixed
- Checkpoint, position and preview markers were drawn half a marker below and to the right of their point; they are now centred on it, exactly on the route line.
- The speed-coloured route line now follows the real road geometry (and the great circle on long straight legs), so it passes exactly through every checkpoint.
- Road speed limits: OSRM reports newer OpenStreetMap node ids (10 billion and up) as rounded numbers. The browser edition sent these to Overpass (which failed the whole lookup) and the standalone app dropped them (so the limits no longer lined up with the route). Both now skip only those nodes.
- Requests to the free OpenStreetMap routing server are spaced one second apart, as its usage policy asks. Your own server (`SPOOFER_OSRM_*`) is not throttled.
- Button tooltips no longer repeat "(shortcut K)".
- After clearing a route, the player at the bottom kept showing the old route. Clearing now unloads it, and the player hides its controls until something is loaded.
- Removing a GPX file now also unloads its track from the player.
- Opening a new version of the standalone app could show an older copy that was still running in the background (for example, always showing v0.1.1). A new version now closes an older running copy, or runs on its own if it can't; closing the window always ends the app.
- The local server now only answers the app itself, so other websites open in your browser can't send it commands or read your settings (both editions).

### Changed
- A quieter, denser interface: edge-to-edge panes with thin dividers instead of floating cards, 13 px text, 28 px controls, 4–6 px corners, an underlined tab bar, a translucent player bar, monochrome icons instead of emoji, and validation messages as text instead of boxed alerts.
- Both editions now live in one repository and share one interface. The standalone app is the recommended edition.
- Release names: `standalone-v…` and `browser-v…`. The browser edition's file is now `LocationSpooferBrowser.exe`.

## standalone-v0.1.1 and v1.2.2 — 1 November 2026
- First standalone (Rust) app with a native window.
- Google Maps links and optional Google routing, experimental road-aware driving, speed-coloured routes, setup guide and info buttons.
- Rebuilt GPX panel and many fixes.

## v1.1.1 — 1 November 2026
- First Windows `.exe` with automatic updates.
