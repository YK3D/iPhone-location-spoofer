# Privacy Policy

_Last updated: 1 November 2026_

This policy covers both editions of Location Spoofer: the standalone app (`LocationSpooferStandalone.exe`) and the browser version (`LocationSpooferBrowser.exe` or run from source). Together they are called "the app".

## The short version

* The app has **no accounts, no analytics, no advertising and no telemetry**. Its authors receive **no data** from you.
* Everything you create — favourites, saved routes, settings, an optional Google API key — is stored **only on your computer**.
* To show maps, find places and calculate routes, the app talks **directly from your computer to third-party online services** listed below. Those services receive the information needed to answer each request (for example map coordinates or a search term) and your IP address, under their own privacy policies.
* The app talks to your iPhone **only over the USB cable or your local network**; nothing about the phone is sent to the internet by the app.

## What is stored on your computer

| Data | Where | Why |
|---|---|---|
| Favourite places, saved routes, settings (theme, shortcuts, panel sizes, last map position), the update channel, the tutorial status | Standalone: `%APPDATA%\LocationSpooferStandalone\data.json` (Windows). Browser version: `%APPDATA%\iPhoneLocationSpoofer\data.json`. On macOS/Linux, under your user data folder. | So the app remembers your setup |
| Google Maps API key (only if you enter one) | The same `data.json` file | So the app can call Google on your behalf. It is never included in backup exports |
| iPhone pairing record | Managed by Apple's device service (or the built-in service in experimental builds) | Needed for the iPhone to trust this computer |
| Apple Developer Disk Image cache | `ddi` folder next to `data.json` | Avoids downloading it again |
| Downloaded updates | Next to the app's `.exe` until installed | Self-update |

You can delete all of it at any time by deleting those folders. Uninstalling the app (deleting the `.exe`) does not delete `data.json`.

## Online services the app contacts

The app sends requests **directly** to these services. No data passes through servers run by the app's authors.

| Service | When | What it receives | Policy |
|---|---|---|---|
| OpenStreetMap tile servers (`tile.openstreetmap.org`) | Showing the Streets map | Map tile coordinates, IP address | [OSMF privacy policy](https://osmfoundation.org/wiki/Privacy_Policy) |
| Esri World Imagery | Showing the Satellite map | Map tile coordinates, IP address | [Esri privacy](https://www.esri.com/en-us/privacy/overview) |
| OpenTopoMap | Showing the Topographic map | Map tile coordinates, IP address | [OpenTopoMap](https://opentopomap.org/about) |
| Nominatim (`nominatim.openstreetmap.org`) | Place search; Google Maps links that contain place names | Your search text, IP address | [OSMF privacy policy](https://osmfoundation.org/wiki/Privacy_Policy) |
| FOSSGIS OSRM routing (`routing.openstreetmap.de`) | Building road, cycle or footpath routes | Start and end coordinates of each leg, IP address | [FOSSGIS privacy policy](https://www.fossgis.de/datenschutzerkl%C3%A4rung), [service info](https://routing.openstreetmap.de/about.html) |
| Overpass API (`overpass-api.de`) | Only when "Use public speed limits" is turned on | OpenStreetMap node IDs along the route, IP address | [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) |
| Google Maps Platform (Routes API, Map Tiles API) | Only if you add your own API key and choose Google routing | Route coordinates, map tile requests, your API key, IP address | [Google Privacy Policy](https://policies.google.com/privacy) |
| Google short links (`maps.app.goo.gl`) | Only when you paste a short Google Maps link | The link, IP address | [Google Privacy Policy](https://policies.google.com/privacy) |
| GitHub (`api.github.com`, `github.com`, `release-assets.githubusercontent.com`) | Update checks (at start-up and every few hours) and update downloads | Your IP address and app version (in the request) | [GitHub Privacy Statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement) |
| GitHub raw content (`raw.githubusercontent.com/doronz88/DeveloperDiskImage`) | Only when the iPhone has no Developer Disk Image mounted | The requested file path, IP address | [GitHub Privacy Statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement) |

Straight-line and sea-lane routes, coordinate entry, GPX files and the simulator work **offline** and contact none of these services. Update checks can be turned off by starting the app with `--no-update`.

## Your real location

When you press **Show my real location** or **Stop spoofing**, the app asks your computer's operating system for its approximate position. That request is handled by Windows (or your browser) and may involve its own location services; you can deny the permission. The position is only drawn on the map and is not stored or sent anywhere by the app.

## Children

The app is not directed at children and collects no personal information from anyone.

## Changes

Changes to this policy are published in this repository with a new "Last updated" date. Significant changes are mentioned in the release notes.

## Contact

Questions about privacy can be raised as an issue on the project's GitHub page: <https://github.com/YK3D/iPhone-location-spoofer/issues>.
