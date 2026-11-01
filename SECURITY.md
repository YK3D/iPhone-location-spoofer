# Security Policy

## Supported versions

Only the latest release of each edition receives fixes:

| Edition | Supported |
|---|---|
| Standalone app, latest `standalone-v…` release | ✅ |
| Browser version, latest `browser-v…` release | ✅ |
| Test builds (pre-releases from the `dev` branch) | Best effort |
| Older releases | ❌ (update first) |

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private vulnerability reporting instead: open the repository's **Security** tab and choose **Report a vulnerability**. Include:

* the edition and version;
* the steps to reproduce;
* what an attacker could achieve.

You should get an acknowledgement within 7 days. Fixed issues are credited in the release notes unless you prefer otherwise.

## How the app protects you

* **Local only.** The app's server listens on `127.0.0.1` (this computer only). Do not expose it to your network with `--host 0.0.0.0`: anyone who can reach it could move your phone.
* **Update integrity.** Updates are downloaded only from GitHub over HTTPS. The download host is checked, and the file's SHA-256 checksum must match the one published with the release before the update is installed.
* **Untrusted files.** GPX files are parsed with document type definitions (DTDs) disabled, which blocks XML entity-expansion attacks. Uploads are limited to 20 MB.
* **Links.** Google Maps short links are followed only to Google hosts.

## Known limitations

* Releases are **not code-signed** yet, so Windows SmartScreen shows an "unknown publisher" warning. A checksum proves the file came intact from this repository's release, not who wrote it. Download only from this repository's Releases page.
* The optional Google API key is stored unencrypted on your computer. Restrict the key in Google Cloud to the Routes API and Map Tiles API.
