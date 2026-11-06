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
            <a href={REPO_URL} target="_blank" rel="noreferrer">Source code</a>
            <a href={`${REPO_URL}/releases`} target="_blank" rel="noreferrer">Releases</a>
            <a href={`${REPO_URL}/blob/main/CHANGELOG.md`} target="_blank" rel="noreferrer">Changelog</a>
            <a href={`${REPO_URL}/blob/main/PRIVACY.md`} target="_blank" rel="noreferrer">Privacy</a>
            <a href={`${REPO_URL}/blob/main/TERMS.md`} target="_blank" rel="noreferrer">Terms</a>
            <a href={`${REPO_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer">MIT licence</a>
          </nav>
        </div>
        <div className="foot-notes">
          <p><b>Use it responsibly.</b> Location simulation is for testing your own apps, demos and privacy. Many apps forbid fake locations and may suspend your account.</p>
          <p>This site sets no cookies and loads no analytics. The demo map uses <a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> (© OpenMapTiles, © OpenStreetMap contributors) and routes from the <a href="https://routing.openstreetmap.de/about.html" target="_blank" rel="noreferrer">FOSSGIS</a> OSRM servers; version numbers come from GitHub.</p>
          <p className="mono">© {year} YK3D and Location Spoofer contributors. iPhone and iPad are trademarks of Apple Inc.; this project is not affiliated with Apple.</p>
        </div>
      </div>
    </footer>
  );
}
