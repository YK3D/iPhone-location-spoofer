import { REPO_URL } from "../lib/releases.js";

export default function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="foot-top">
          <div className="foot-brand">
            <img src="/icon-64.png" alt="" width="36" height="36" />
            <div>
              <strong>Location Spoofer</strong>
              <p>Set your iPhone's GPS location from Windows over USB.</p>
            </div>
          </div>
          <nav className="foot-links" aria-label="Project">
            <a href={REPO_URL} target="_blank" rel="noreferrer">GitHub</a>
            <a href={`${REPO_URL}/releases`} target="_blank" rel="noreferrer">Releases</a>
            <a href="/changelog">Changelog</a>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
            <a href="/licence">Licence</a>
            <a href="/third-party-notices">Third-party notices</a>
          </nav>
        </div>
        <div className="foot-notes">
          <p><b>Use it responsibly.</b> Location simulation is meant for testing apps, demos and privacy. Many apps forbid fake locations and may suspend your account.</p>
          <p>This site sets no cookies and loads no analytics. The demo map uses <a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> (© OpenMapTiles, © OpenStreetMap contributors) and routes from the <a href="https://routing.openstreetmap.de/about.html" target="_blank" rel="noreferrer">FOSSGIS</a> OSRM servers; version numbers come from GitHub.</p>
          <p>Location Spoofer is free to download and use, but it is not open source. Location Spoofer is an independent project and is not affiliated with, endorsed by or sponsored by Apple Inc. or Google LLC. iPhone and iPad are trademarks of Apple Inc.; Google Maps is a trademark of Google LLC.</p>
          <p className="mono">© {year} YK3D. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}
