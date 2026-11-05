# Changelog

Releases are published separately for the two editions:
[standalone app](https://github.com/YK3D/iPhone-location-spoofer/releases?q=standalone&expanded=true) (`standalone-v…`) and
[browser edition](https://github.com/YK3D/iPhone-location-spoofer/releases?q=browser&expanded=true) (`browser-v…`).
Test builds from the `dev` branch are marked as pre-releases.

## Unreleased (dev)

### New
- **Feature tests:** *Settings › Updates › Show feature tests* lists the experiments being tried on GitHub; *Open* shows one in your web browser with what it changes and how to try it.
- The setup guide and the README link straight to **Apple Devices** in the Microsoft Store.
- **A real dark map:** the default map (OpenFreeMap) is sharp at every zoom and has a true dark style and a light style. Choose the map in *Settings › Appearance › Map* or with the map's layer button. If it can't load, the app says so and shows OpenStreetMap.
- **Realistic cornering:** every bend is taken at the speed its curve allows for the vehicle (cars, bikes, walkers and boats differ). For a car: a right-angle junction at about 18 km/h, a roundabout at about 22 km/h, a gentle motorway curve at about 88 km/h. *Slow down for turns and U-turns* is on by default, and *Route summary* shows the sharpest bend.
- **Roundabouts** are always driven at a normal roundabout speed for their size (about 20–40 km/h by car), whatever the road's own speed.
- **Edit routes on the map:** drag the route line to add a checkpoint there, double-click a checkpoint to delete it, or right-click one for Delete, Insert after, Set wait and Make start.
- **Hold until Continue:** a checkpoint can stop playback until you press Continue (or **N**).
- **Alternative routes:** ask for up to three in *Routing & speed*, then pick one in *Route summary* or click a grey line on the map. Each is labelled with its extra time.
- **Build progress:** the Build route button shows each step and how far along it is. Cancel it with the Cancel button or Esc; changing the route cancels it by itself.
- **Laps** for looping routes, and live **speed and heading** on the map while playing.
- Drag checkpoints by their handle to reorder them, and hover one in the list to highlight it on the map.
- **Looks:** 17 colour themes (Graphite by default), a dark or light map, a compact layout, folding sections, a side menu you can resize or hide (**M**), animated dialogs, lists and a setup guide with small animations.
- **Keyboard shortcuts** for common actions, changeable in *Settings › Shortcuts* (press **H** for the list).
- **Settings** window with Appearance, Shortcuts, Google Maps, Updates and About pages.
- **Update channels:** stable releases, or opt-in test builds.
- *Stop spoofing* and *Show my real location* show your computer's real location on the map.
- Undo after clearing checkpoints or deleting favourites and saved routes.
- A new app icon. The taskbar shows just the red location pin, so it stays clear at small sizes.

### Fixed
- With a checkpoint's right-click menu open, a left click on the map added a checkpoint. It now only closes the menu.
- Dropdowns in Settings opened behind the Settings window.
- Roundabouts were sometimes driven at 70 km/h or more.
- Changing the default speed didn't mark a built route as out of date.
- Asking for three alternative routes often gave only one or two.
- Clicking a checkpoint marker added another checkpoint.
- The heading jumped at each bend of the road instead of turning smoothly.
- The standalone window flashed white at start-up.
- Markers were drawn slightly off their point; the speed-coloured route line didn't pass exactly through every checkpoint.
- Public speed limits could fail for a whole route, or no longer line up with it.
- After clearing a route or removing a GPX file, the player still showed the old one.
- Opening a new version could show an older copy that was still running in the background.
- Other websites open in your browser can no longer send commands to the app or read its settings.

### Changed
- **Licence:** Location Spoofer is still free to use, but its code, interface and icon may no longer be copied, redistributed or modified without written permission, and any permitted use must credit YK3D (see LICENSE). The browser edition stays under the GNU GPL, now with an attribution requirement.
- A cleaner, quieter interface: sections are cards with an icon, tabs are a segmented control, help icons explain every tool, and the Route tab starts with every section folded.
- The route line is coloured by speed in a smooth gradient and outlined so it stands out from the roads.
- "Use public speed limits" is marked as not recommended (the public service is slow and often incomplete).
- Both editions share one interface. The standalone app is the recommended edition; releases are named `standalone-v…` and `browser-v…`.

## standalone-v0.1.1 and v1.2.2 — 1 November 2026
- First standalone (Rust) app with a native window.
- Google Maps links and optional Google routing, experimental road-aware driving, speed-coloured routes, setup guide and info buttons.
- Rebuilt GPX panel and many fixes.

## v1.1.1 — 1 November 2026
- First Windows `.exe` with automatic updates.
