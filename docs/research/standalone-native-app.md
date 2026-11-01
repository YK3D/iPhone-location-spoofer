# Design notes: standalone app, Microsoft Store, and running without the Apple Devices app

Date: 2026-11-01. These notes record the research behind the standalone app.

**Current state:**
* The standalone (Rust) app now exists. It took the "Tauri-style" route: a native window around the shared interface, with the `idevice` library talking to the iPhone.
* Running without the Apple Devices app (options B/C below) is being tested on the `feature/no-apple-devices` branch.
* Microsoft Store publishing is postponed until the standalone app is mature.

## Questions

1. Can the app talk to an iPhone on Windows **without the Apple Devices app (or iTunes)** installed?
2. How do we turn the browser UI into a **standalone native desktop application** (its own window, no browser)?
3. What would block publishing it on the **Microsoft Store**?

## Short answers

1. **Probably yes, but not yet proven on hardware.** Two separate Apple pieces are involved, and only one of them is hard to replace:
   - The **USB kernel driver** ("Apple Mobile Device USB Driver") is published by Apple through Microsoft's Update Catalog and Windows Update, independently of the Apple Devices app.
   - The **Apple Mobile Device Service** (the `usbmuxd` service on `127.0.0.1:27015`) only comes with the Apple Devices app or iTunes. An open-source replacement, **netmuxd** (LGPL-2.1), can talk to Apple's kernel driver directly and take the service's place.

   Driver from Windows Update plus netmuxd is the candidate route. It needs a test on a real Windows PC with an iPhone before any implementation work starts.
2. **Wrap the existing UI in a native window using WebView2.** The map has to be a web map (Leaflet) in any framework, so a full native rewrite of the UI gains little. The quickest route is pywebview with the WebView2 control. The long-term Store route might be Tauri with a Rust backend (see option C).
3. **Store blockers exist but look solvable:**
   - a dependency on Apple's NT service (Policy 10.2.4)
   - the self-updater (Store packages must update through the Store)
   - "iPhone" in the app name (Apple trademark)
   - a mandatory privacy policy
   - the GPL licence of pymobiledevice3
   - review risk for a "location spoofing" app

## 1. Running without the Apple Devices app

### How the current app reaches the phone

`pymobiledevice3` talks to a usbmuxd service. On Windows that is Apple's `AppleMobileDeviceService.exe`, listening on TCP `127.0.0.1:27015` (`ITUNES_HOST` in `pymobiledevice3/usbmux.py`).

pymobiledevice3 11.49 also has a `pymobiledevice3.usb` package with libusb support. Its docstring describes it as "Host-side USB access that does not go through usbmuxd". I checked where it is used: only for recovery/DFU restore, diagnostics (`doctor`) and power delivery. It **cannot** reach a normally booted iPhone for lockdown or developer services. So pymobiledevice3 on its own still needs some usbmuxd.

It can, however, use **any** usbmuxd: the `--usbmux HOST:PORT` option and the `USBMUXD_SOCKET_ADDRESS` environment variable let us point it at a replacement.

### The two Apple components

| Component | What it does | Where it comes from |
|---|---|---|
| Apple Mobile Device USB Driver (kernel, `usbaapl64.sys`) | Binds the iPhone's USB interfaces in Windows Plug and Play | Microsoft Update Catalog lists **"Apple, Inc. USBDevice Driver Update (552.0.0.0)"**, last updated 24 Apr 2025, for Windows 10 and later. Earlier versions are 538, 486 and 423. Community guides say Windows installs it automatically when an iPhone is plugged in; that is unverified here. |
| Apple Mobile Device Service (user-mode NT service) | The usbmuxd implementation: lists devices, stores pair records, relays connections | Only in the Apple Devices app, iTunes, or the "Apple Mobile Device Support" MSI extracted from the iTunes installer |

### Options

| Option | Needs Apple Devices app? | Needs admin / driver install? | Store-friendly? | Maturity / risk |
|---|---|---|---|---|
| **A. Current setup:** Apple Devices app + pymobiledevice3 | Yes | No | Dependency must be disclosed, and it relies on a non-Microsoft NT service (10.2.4, "generally not allowed", decided case by case) | Works today |
| **B. Windows Update driver + netmuxd ("Apple's mux" mode) + pymobiledevice3** | **No** | No driver install. netmuxd says it evicts Apple's service if one is running; without that service installed, whether admin is needed is unknown | Good if netmuxd runs inside the app, not as an NT service | **Unproven:** netmuxd lists no releases; its README marks the service-takeover mode "Untested" |
| **C. Windows Update driver + netmuxd + `idevice` (Rust, MIT) in a Tauri app** | No | Same as B | Best fit: no Python and no GPL, and a smaller binary | Full backend rewrite. idevice has location simulation, DVT, CoreDeviceProxy tunnels, image mounting and pairing (README), but its README does not mention Windows |
| **D. netmuxd libusb mode** (binds the libusb0 driver with libwdi) | No | **Yes:** admin install of a self-signed driver; Apple Devices / Apple Mobile Device Support must be uninstalled; breaks iTunes and Photos import; rejected on Windows ARM64 | **No** (installs a non-WHCP driver) | Invasive; not recommended |
| **E. Wi-Fi only** (pymobiledevice3 mobdev2 for iOS 16 and older; RemotePairing tunnel for iOS 17+) | Only for the **first** pairing, which needs USB and a usbmuxd | No | Yes | Pair records must exist first. `lockdown remotepairing --pair` can create the iOS 17+ record over USB without a prompt. Discovery depends on the network (mDNS, firewalls) |
| **F. Bundle Apple Mobile Device Support MSI** (what tools like iMazing do: their installer "will automatically reinstall all required components and drivers") | No (but installs Apple's service) | Yes (installer) | No: redistributing Apple's MSI needs Apple's permission, and it installs a non-Microsoft NT service | Legal risk |

**Recommendation:** run a hardware spike for **option B** first. It keeps all current code. If it works, the app needs neither the Apple Devices app nor any driver install.

### Spike plan (manual, about 1 hour, needs a Windows 11 PC and an iPhone)

1. Use a clean Windows 11 install or VM with USB passthrough. Uninstall Apple Devices and iTunes, and reboot.
2. Plug in the iPhone and check in Device Manager whether "Apple Mobile Device USB Driver" installs from Windows Update. If not, install the 552.0.0.0 CAB from the Update Catalog with `pnputil /add-driver *.inf /install`.
3. Build or download netmuxd for Windows, run it without admin, and note whether it starts and serves on `127.0.0.1:27015`.
4. Run `LocationSpoofer.exe pmd3-cli usbmux list`, then `lockdown info`, then `developer dvt simulate-location set -- 51.5 -0.12`. Repeat for an iOS 17.4+ and an iOS 16 device if available.
5. Note where pair records are stored, whether the Trust prompt appears, and whether the developer disk image mounts.

The spike passes if step 4 sets a location with no Apple software installed and no admin rights.

## 2. Standalone native window

Any choice still needs a web map: Leaflet with OpenStreetMap tiles. Native map controls on Windows are deprecated (the UWP/WinUI MapControl depended on Bing Maps) or need paid keys. So every realistic option puts the map in a web view.

| Option | Effort | Size | Notes |
|---|---|---|---|
| **pywebview (WebView2 / EdgeChromium backend) + current Python backend** | Low: replace "open browser" with a native window; the API stays on a private localhost port or moves to pywebview's JS bridge | About 90 MB (PyInstaller, as now) plus the WebView2 runtime, which ships with Windows 11 | Keeps all tested code. The console window is replaced by the app window and an optional tray icon |
| PySide6 / Qt + QtWebEngine | Medium | +150 MB (bundles Chromium) | Native widgets for panels, but the map is still web. LGPL obligations |
| **Tauri (Rust) + WebView2 + idevice + netmuxd** | High: port the speed-profile engine, routing, GPX and player to Rust | About 10–20 MB | Best Store fit: MIT/LGPL licences only; no Python start-up unpacking; fast start. Sea routing needs a Rust replacement for `searoute` (its data is Apache-2.0 and could be reused) |
| Electron + Python sidecar | Medium | +150 MB | No advantage over pywebview here |
| WinUI 3 / .NET + WebView2 + idevice FFI | High | Medium | Most "Windows-native" result, but the largest rewrite |

**Recommendation:** first ship **pywebview + WebView2** (small change, same backend). Revisit Tauri plus Rust only if the Store review or the GPL licence becomes a problem.

## 3. Microsoft Store: requirements and blockers

Policy references are to the Microsoft Store Policies, version 7.20 (updated 2026-09-15).

| Topic | Policy | Impact | Mitigation |
|---|---|---|---|
| Account cost | n/a | Registration has been free for individuals since 2025 (ID and selfie check required) | None needed |
| Package type | 10.2.5 / 10.2.9 | **MSIX:** Microsoft signs it and it must be "installed and updated only through the Store". **EXE/MSI by URL (10.2.9):** must be code-signed by a CA in Microsoft's trusted root program (a purchased certificate), install silently, use a versioned URL, and not be a web installer | Prefer **MSIX**: no certificate cost, Store-handled updates |
| Self-updater | 10.2.2, 10.2.5 | The GitHub updater conflicts with Store-delivered packages | Build flavour without the updater for the Store; keep it for the GitHub exe |
| Apple service dependency | 10.2.4 | "dependency on non-Microsoft provided drivers or NT services is not allowed but may be considered case by case for WHCP certified drivers"; it must be disclosed in certification notes and at the start of the description | Option B removes the NT service. The Apple USB driver is distributed through Windows Update (WHCP-signed), which supports the case-by-case route |
| Installing other software | 10.2.3 | Must not offer to install secondary software not developed by you | Do not bundle or launch Apple's or third-party installers |
| Trademark | 11.2, plus Apple's trademark guidelines | Apple forbids its marks inside third-party product names; referential use ("for iPhone", "compatible with iPhone") is generally allowed | Rename, e.g. "GPS Route Simulator", and use "for iPhone" only in the description |
| Accurate description | 10.1 | Must not mislead about function or its relationship to Apple | State clearly: requires Developer Mode, USB cable, not affiliated with Apple |
| Privacy policy | 10.5 | Mandatory for Win32 / Desktop Bridge apps; the app sends coordinates and searches to OSRM and Nominatim | Publish a privacy policy page; add an "offline only" option |
| Content / review risk | 11.8, 10.1 | Location spoofing is not illegal, but it is used to break game and app terms. The review outcome is **unknown**; no precedent was found | Position as a developer/testing tool (GPX playback, route testing) and keep the in-app warnings |
| Licences | n/a | pymobiledevice3, pmd-pytcp, pytun-pmd3, developer-disk-image and ipsw-parser are **GPL-3.0-or-later**. Distributing the exe makes the app GPL-3 | Add a GPL-3.0 `LICENSE` and keep source public. Check the Store's App Developer Agreement for GPL compatibility (not verified here). Or choose option C (MIT + LGPL) |
| Admin elevation | n/a | The iOS 17.0–17.3 tunnel helper needs admin | Drop iOS 17.0–17.3 support in the Store build; the userspace tunnel (iOS 17.4+) needs no admin |
| Developer Disk Image | n/a | pymobiledevice3 downloads Apple's DDI at runtime from a third-party GitHub repository; these images are Apple-copyrighted | Legal grey area. Document it, or require Xcode-sourced images. Ask for legal advice before Store submission |

## Open questions

1. Hardware test of option B/C: does the Apple USB driver from Windows Update, plus netmuxd, work with no Apple software installed?
2. Microsoft Store: a store name without "iPhone", the review outcome for a location-simulation app, and code signing.

## Sources

- netmuxd README (Windows modes, libusb installer, LGPL-2.1): <https://github.com/jkcoxson/netmuxd>
- idevice README (features, MIT licence): <https://github.com/jkcoxson/idevice>
- Microsoft Update Catalog, Apple USB driver entries: <https://www.catalog.update.microsoft.com/Search.aspx?q=Apple%20Mobile%20Device%20USB>
- Apple Mobile Device drivers on Windows (CAB and pnputil install; service comes from the iTunes MSI): <https://www.technotes.me/2026/02/apple-mobile-device-drivers-on-windows>
- iMazing, "Fully reinstall Apple components on Windows": <https://imazing.com/guides/fully-reinstall-apple-components-on-windows-pc>
- Installing Apple Mobile Device Support without iTunes: <https://www.addictivetips.com/windows-tips/apple-mobile-device-support-windows-10/>
- libimobiledevice (usbmuxd not fully supported on Windows): <https://libimobiledevice.org/>
- Microsoft Store Policies 7.20: <https://learn.microsoft.com/en-us/windows/apps/publish/store-policies>
- Free Microsoft Store developer registration: <https://blogs.windows.com/windowsdeveloper/2025/09/10/free-developer-registration-for-individual-developers-on-microsoft-store/>
- Apple trademark guidelines for third parties: <https://www.apple.com/legal/intellectual-property/guidelinesfor3rdparties.html>
- Developer report of an App Review rejection for an Apple mark in an app name: <https://developer.apple.com/forums/thread/129822>
- pymobiledevice3 11.49.1 source (usbmux.py, usb/, licences), inspected locally.
