import { useId, useState } from "react";
import Icon from "../components/Icon.jsx";
import { REPO_URL } from "../lib/releases.js";

const QA = [
  [
    "Will it work in my game or app?",
    <>Location simulation is meant for testing apps, demos and privacy. Many games, dating, banking, school, work and delivery apps forbid fake locations and may suspend your account. Apps can also detect simulation or use Wi-Fi, IP address and motion sensors, which this tool does not change. See the <a href="/terms">Terms of Use</a>.</>,
  ],
  [
    "Why does a speedometer app on the iPhone show 0?",
    <>Apple's location simulation only carries a position, so iOS reports no speed or course for it. Apps that work out speed from movement (navigation apps, most games) are fine. The app's own map shows the simulated speed and heading.</>,
  ],
  [
    "Which iPhones and iOS versions work?",
    <>Any iPhone or iPad with Developer Mode. The Standalone app supports iOS 17.4 and newer, and iOS 16 and older. iOS 17.0–17.3 needs the Browser edition, which asks for administrator permission once per session.</>,
  ],
  [
    "Does it send my data anywhere?",
    <>There are no accounts, analytics or telemetry. Favourites, routes and settings stay on your computer. Maps, searches and routes are requested directly from the services listed in the <a href="/privacy">Privacy Policy</a>.</>,
  ],
  [
    "How do I get my real location back?",
    <>Press <b>Stop spoofing</b>. If the location still looks wrong, restart the iPhone.</>,
  ],
  [
    "Why does Windows warn me when I open it?",
    <>The app is not code-signed yet, so SmartScreen shows “Windows protected your PC”. Choose <b>More info → Run anyway</b>. Each update is checked against its SHA-256 checksum before it installs, and the source code is public on GitHub.</>,
  ],
];

function Item({ q, a }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className={`faq-item${open ? " open" : ""}`}>
      <h3>
        <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
          <span>{q}</span>
          <Icon name="chevronDown" className="chev" />
        </button>
      </h3>
      <div className="faq-a" id={id} role="region" aria-hidden={!open}>
        <div><p>{a}</p></div>
      </div>
    </div>
  );
}

export default function Faq() {
  return (
    <section className="section band faq" id="faq" aria-labelledby="faq-title">
      <div className="container faq-grid">
        <header className="sec-head">
          <p className="kicker"><span className="idx">09</span> Questions</p>
          <h2 id="faq-title">Before you plug anything in.</h2>
          <p>More answers in the <a href={`${REPO_URL}#troubleshooting`} target="_blank" rel="noreferrer">troubleshooting table</a>.</p>
        </header>
        <div className="faq-list">
          {QA.map(([q, a]) => <Item key={q} q={q} a={a} />)}
        </div>
      </div>
    </section>
  );
}
