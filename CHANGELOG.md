# Changelog

Releases are published separately for the two editions:
[standalone app](https://github.com/YK3D/iPhone-location-spoofer/releases?q=standalone&expanded=true) (`standalone-v…`) and
[browser edition](https://github.com/YK3D/iPhone-location-spoofer/releases?q=browser&expanded=true) (`browser-v…`).
Test builds from the `dev` branch are marked as pre-releases.

## Unreleased (dev)

### Experimental (`feature-testing` only; see [docs/testing/multiple-iphones-and-wifi.md](docs/testing/multiple-iphones-and-wifi.md))
- Several iPhones at once: phones added under *Device › More iPhones* follow the main one (teleports, routes, GPX, joystick, Stop spoofing). Each gets positions from its own queue, so a slow or lost phone never holds up the others; a lost phone is marked until removed, and removing one sends it back to its real location. The Simulator has a second phone to try it.
- Wi-Fi connections: *Device tools › Connect over* (Automatic, USB cable only, Wi-Fi only) and *Allow Wi-Fi connection*, which turns on the phone's "Show this iPhone when on Wi-Fi" setting. The device list shows how each phone can be reached (USB, Wi-Fi, or both). In the browser version, a second iOS 17+ phone or an iOS 17+ phone over Wi-Fi needs the tunnel helper. Bluetooth isn't possible.

### New
- A real dark map: the default map is now OpenFreeMap, drawn from vector data, so it is sharp at every zoom and has a true dark style (with colours tuned so water, parks, the road hierarchy and labels stand out) and a light style. Free, no account or key. Choose the map in *Settings › Appearance › Map* (OpenFreeMap, OpenStreetMap, Topographic, Satellite) or with the map's layer button; the choice is remembered. Without WebGL, or if OpenFreeMap can't be reached, the app says so and shows OpenStreetMap.
- The tutorial has an animated drawing for each step (the route being drawn, the cable and Trust prompt, the Developer Mode switch, a position moving along a route), and each step slides in.
- Dialogs (Settings, tutorial, shortcuts) fade and rise in and sink out when closed (also with Esc), and their height glides to the new size when you switch Settings pages or tutorial steps.
- Hiding the side menu slides it out to the left while the map widens with it (and back in).
- Cornering physics (tested on `feature-testing`, now standard): every bend is now taken at the speed its radius allows for the vehicle on that leg, v = √(lateral acceleration × radius), instead of a fixed slowdown. Bends are found as runs of heading change, so long curves count as one bend and S-bends as two. A junction that the map draws as a sharp corner is rounded the way drivers cut it (wider on faster roads), a curve keeps its drawn radius, and a U-turn follows the vehicle's turning circle. Comfortable lateral acceleration falls with speed and never exceeds a safe share of tyre grip. Cars, bikes, walkers and boats have their own limits; straight legs guess the vehicle from their speed, and planes are not slowed. Examples for a car: a 90° junction at about 18 km/h on a 50 km/h road (14 km/h on a 30 km/h street), a roundabout at about 22 km/h, a 300 m motorway curve at about 88 km/h.
- "Slow down for turns and U-turns" is on by default, and Route summary shows the sharpest bend (angle, radius and speed).
- Cancel a route build with the Cancel button beside the progress bar (or Esc). A build also cancels itself when you change the checkpoints or the route settings.
- Dropdowns open as an animated list (keyboard: arrows, Enter, Esc, type to jump), sections fold and unfold with an animation, and an opened section scrolls smoothly into view.
- Edit routes on the map: drag the route line to add a checkpoint at that spot (it goes into the leg you grabbed and the route rebuilds), double-click a checkpoint to delete it, and right-click one (on the map or in the list) for Delete, Insert after, Set wait and Make start.
- "Hold until Continue" checkpoints: playback stops there and waits until you press Continue (or **N**); any wait time runs after that. Set it with the Hold box in the list or Set wait in the right-click menu.
- Lap limit for looping routes (Playback options › Laps); in back-and-forth mode a lap is there and back.
- Live speed and heading on the map while playing, and the position marker points the way it is going.
- Hovering a checkpoint in the list highlights its marker (and the other way round); deleting one animates out.
- Alternative routes are labelled on the map with their extra time; hovering an option in the list highlights its line.
- Map theme setting (Dark, Light, or Match the app theme).
- Screenshot script (`docs/screenshots/capture.js`) using the default look.

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
- With a checkpoint's right-click menu open, a left click elsewhere on the map added a checkpoint. It now only closes the menu (the same for the wait popover and open dropdowns).
- Dropdowns in Settings opened behind the Settings window and could not be clicked. They now open above it.
- Roundabouts were driven at the road's speed (70 km/h and more, faster than the approach when the roundabout belongs to a bigger road). They are now recognised from the routing service's own directions and always driven at a normal roundabout speed for their size: about 20 km/h for a small one up to 40 km/h for a large gyratory by car, 10–22 km/h by bike.
- Changing the default speed now marks a built route as out of date (its legs without their own speed used the old one).
- Asking for three alternative routes often gave only one or two. The detour search now tries via points along the whole route, not just at its middle, follows the route's own direction, and if needed fills the last places with near misses that are only a little slower. A route with several legs no longer spends the search on legs that don't need it.
- Clicking a checkpoint marker added another checkpoint at the end of the route.
- The heading reported during playback now turns smoothly through corners instead of jumping at each bend of the road line.
- The standalone window no longer flashes white at start-up: it stays hidden until the page has drawn, on a background in the theme's colour.
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
- Sections are cards with an icon badge, set apart on the side menu's background; the tabs are a segmented control; the title bar is taller with a larger logo and toolbar icons.
- Route tab order: Import from Google Maps, Routing & speed, Road-aware driving, Checkpoints (then Route summary), Random wander. Every Route section starts folded; Checkpoints opens by itself when you add one.
- Shortcut letters are no longer printed on buttons (they're in the tooltips and the shortcut list, H); help icons replace the "(i)" buttons; the D-pad uses drawn arrows; the colourful themes moved under "More themes".
- Clearer layout: every section has its own header bar with an icon, sections sit apart on a darker background, field labels and dividers have more contrast, and the inputs inside the checkpoint list stay quiet until you point at them. The Route tab now lists Routing & speed, Checkpoints and Route summary first, then the extras.
- Graphite is the default theme and the map is dark by default.
- The speed colours along the route blend smoothly (OKLab colour mixing and light smoothing) instead of in visible bands.
- Bigger app icon in the title bar, made from the new artwork with its background removed (the original file is kept as `assets/icon/source.jpg`).
- "Use public speed limits" is marked as not recommended.
- "My real location" asks for a fresh, high-accuracy position. The standalone app allows its own page to ask, so the only prompt is Windows' own location permission, and the message offers Windows' location settings when access is blocked. The Microsoft Store package declares the location capability.
- The Simulator reports iOS 27.
- A quieter, denser interface: edge-to-edge panes with thin dividers instead of floating cards, 13 px text, 28 px controls, 4–6 px corners, an underlined tab bar, a translucent player bar, monochrome icons instead of emoji, and validation messages as text instead of boxed alerts.
- Both editions now live in one repository and share one interface. The standalone app is the recommended edition.
- Release names: `standalone-v…` and `browser-v…`. The browser edition's file is now `LocationSpooferBrowser.exe`.

## standalone-v0.1.1 and v1.2.2 — 1 November 2026
- First standalone (Rust) app with a native window.
- Google Maps links and optional Google routing, experimental road-aware driving, speed-coloured routes, setup guide and info buttons.
- Rebuilt GPX panel and many fixes.

## v1.1.1 — 1 November 2026
- First Windows `.exe` with automatic updates.
