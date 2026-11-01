# Testing: using the app without the Apple Devices app

This guide is for people helping to test an **experimental** feature: a built-in device service that lets the standalone app talk to an iPhone **without installing Apple Devices or iTunes**. Test builds are not regular releases. Please don't rely on them for anything important.

## Background

Windows needs two Apple components to talk to an iPhone:

1. **Apple's USB driver.** It makes Windows recognise the phone. Windows Update can install it automatically when an iPhone is plugged in.
2. **Apple Mobile Device Service.** This background service relays the connection to apps. It comes only with the Apple Devices app or iTunes.

The test build includes **netmuxd**, an open-source replacement for part 2 (LGPL-2.1, shipped as a separate program next to the app). If it works, only part 1 is needed.

The test checks:

* whether Windows installs a suitable Apple USB driver on its own;
* whether netmuxd can reach the iPhone through it;
* whether pairing, Developer Mode, the developer disk image and location simulation all work that way.

## Get the test build

1. Open the repository's **Actions** tab and choose the latest successful **"Feature test build (no Apple Devices app)"** run. Downloading artifacts requires a GitHub account.
2. Download the artifact `LocationSpoofer-no-apple-devices-test-…` and unzip it into its own folder. It contains:
   * `LocationSpooferStandalone.exe` (test build, does not auto-update);
   * `netmuxd.exe`;
   * licence files, a source notice, `SHA256SUMS.txt` and this guide.
3. Keep `netmuxd.exe` in the same folder as the app.

## Test A: clean PC without Apple software (the main test)

1. In **Settings › Apps › Installed apps**, uninstall **Apple Devices**, **iTunes**, **Apple Mobile Device Support** and **Apple Software Update** if present. Restart Windows.
2. Plug in the iPhone and unlock it. Wait a minute.
3. Open **Device Manager** and look for the iPhone. Note what you see, for example "Apple Mobile Device USB Composite Device", "Apple iPhone", or an unknown device.
   * If there's no Apple driver, open **Settings › Windows Update › Advanced options › Optional updates › Driver updates**, install any Apple entry, and note its name and version.
4. Start `LocationSpooferStandalone.exe`. Skip the first step of the setup guide.
5. Open **Device tools**, set **Device service** to **Built-in service**, then press **Run device diagnostics** and **Copy report**.
6. Press **Look for devices** (⟳). On the iPhone, tap **Trust** if asked.
7. Press **Reveal Developer Mode**, turn on Developer Mode on the iPhone, and restart it if needed.
8. Press **Connect**. Note any message.
9. **Teleport** to a place and check Apple Maps on the iPhone. Then build a short **route**, play it, and press **Stop spoofing**.
10. Run the diagnostics again and copy the report.

## Test B: PC with Apple Devices installed

1. With Apple Devices installed, set **Device service** to **Automatic**. The app should use Apple's service as usual: connect, teleport, stop spoofing.
2. Set it to **Built-in service** and press **Connect**. The built-in service then runs on port 27016 next to Apple's. Note whether it can reach the phone; Apple's service may keep it. For a cleaner test, stop "Apple Mobile Device Service" in **Services** (`services.msc`) and try again.

## What to report

Open an issue titled "No Apple Devices test result" with:

* Windows version (`winver`), iPhone model and iOS version;
* the result of each step (works / error message);
* the Device Manager entries from step A3, and any driver installed from Windows Update;
* both diagnostics reports;
* the contents of `netmuxd.log`, found in `%APPDATA%\LocationSpooferStandalone\`.

## Undo

* Set **Device service** back to **Automatic** or **Apple's service only**.
* Reinstall Apple Devices from the Microsoft Store if you removed it.
* The built-in service stores its pairing records in `%APPDATA%\LocationSpooferStandalone\pairing`. Delete that folder to remove them.
