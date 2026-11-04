# Testing several iPhones at once and Wi-Fi connections

These features are on the `feature-testing` branch only. Run that branch from source (see [CONTRIBUTING.md](../../CONTRIBUTING.md#trying-the-feature-testing-branch)), ideally with an empty data folder (`SPOOFER_DATA_DIR`).

## What they do

- **More iPhones** (Device section, after connecting): every iPhone added there follows the main one. Teleports, routes, GPX tracks, the joystick and *Stop spoofing* reach all of them. Each extra phone gets positions from its own queue, so a slow phone or one that drops out never holds up the main phone or the others. A phone that stops answering is marked in red until you remove it. *Remove* sends it back to its real location. Up to 8 extra phones.
- **Connect over** (Device tools): *Automatic* uses the cable when the phone is plugged in and Wi-Fi otherwise. *USB cable only* and *Wi-Fi only* force one of them. The choice also applies to phones added under More iPhones.
- **Allow Wi-Fi connection** (Device tools): turns on the phone's "Show this iPhone when on Wi-Fi" setting over the cable, so it can be reached without the cable afterwards.

## Without an iPhone

1. Choose *Simulator (no iPhone)* as the Connection and press **Connect**. The Simulator now has two phones.
2. Under **More iPhones**, *Simulated iPhone 2* appears. Press **Add**.
3. Teleport, play a route or use the joystick. The status shows both phones; nothing is sent to real hardware.
4. Press **Remove**, then **Stop spoofing**.

## With real iPhones

1. Connect the first iPhone as usual (cable, unlocked, trusted, Developer Mode on).
2. Plug in the second iPhone, unlock it and trust the computer. Press the refresh button next to *Device*.
3. Under **More iPhones**, pick it and press **Add**. iOS 17+ can take up to 30 s.
4. Teleport and play a short route. Check that both phones follow. Unplug one phone while a route plays: the other must keep going, and the unplugged one must turn red.
5. Wi-Fi: with the phone plugged in, press **Allow Wi-Fi connection**. Then set **Connect over** to *Wi-Fi only*, unplug the phone, keep it unlocked on the same network, and connect.

## Known limits

- **Browser version, iOS 17+:** pymobiledevice3 allows only one no-admin tunnel per app. A second iOS 17+ phone, and any iOS 17+ phone over Wi-Fi, therefore needs the tunnel helper: *Device tools › Start tunnel helper (admin)*. The standalone app has no such limit, because it opens one tunnel per phone itself.
- **Wi-Fi with iOS 17+:** whether Apple's developer tunnel accepts a Wi-Fi connection depends on the iOS version and on how the phone was paired. This hasn't been verified on hardware yet; the error message says what failed.
- **Wi-Fi needs Apple's device service to see the phone on the network.** On Windows that is the Apple Devices app or iTunes, and the computer and phone must be on the same network (no client isolation).
- **Bluetooth isn't possible.** iPhones only offer the location-simulation service over a cable or the network (usbmuxd and lockdown). No Apple protocol carries it over Bluetooth.
