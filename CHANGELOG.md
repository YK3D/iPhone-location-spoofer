# Changelog

Releases are published separately for the two editions:
[standalone app](https://github.com/YK3D/iPhone-location-spoofer/releases?q=standalone&expanded=true) (`standalone-v…`) and
[browser edition](https://github.com/YK3D/iPhone-location-spoofer/releases?q=browser&expanded=true) (`browser-v…`).
Test builds from the `dev` branch are marked as pre-releases.

## Unreleased (dev)

### New
- App icon, also shown on the window and the `.exe`.
- 17 colour themes, a compact layout and an optional darker map for dark themes.
- Folding sections that stay as you left them, a side menu you can resize (drag its edge) or hide (**M**), and equal-width buttons.
- Single-key keyboard shortcuts for common actions, customisable in Settings › Shortcuts (press **H** for the list).
- "Stop spoofing" and "Show my real location" now show your computer's real location on the map.
- Undo after clearing checkpoints or deleting favourites and saved routes.
- Settings window with Appearance, Shortcuts, Google Maps, Updates and About pages; links to the Terms of Use and Privacy Policy.
- Update channels: stable releases, or opt-in test builds.

### Fixed
- After clearing a route, the player at the bottom kept showing the old route. Clearing now unloads it, and the player hides its controls until something is loaded.
- Removing a GPX file now also unloads its track from the player.
- Opening a new version of the standalone app could show an older copy that was still running in the background (for example, always showing v0.1.1). A new version now closes an older running copy, or runs on its own if it can't; closing the window always ends the app.
- The local server now only answers the app itself, so other websites open in your browser can't send it commands or read your settings (both editions).

### Changed
- Both editions now live in one repository and share one interface. The standalone app is the recommended edition.
- Release names: `standalone-v…` and `browser-v…`. The browser edition's file is now `LocationSpooferBrowser.exe`.

## standalone-v0.1.1 and v1.2.2 — 1 November 2026
- First standalone (Rust) app with a native window.
- Google Maps links and optional Google routing, experimental road-aware driving, speed-coloured routes, setup guide and info buttons.
- Rebuilt GPX panel and many fixes.

## v1.1.1 — 1 November 2026
- First Windows `.exe` with automatic updates.
