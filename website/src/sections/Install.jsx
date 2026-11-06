import { useEffect, useMemo, useRef } from "react";
import Icon from "../components/Icon.jsx";
import { gsap, prefersReducedMotion, whenIdle } from "../lib/motion.js";
import { LATEST_STANDALONE_EXE, RELEASES, REPO_URL, detectPlatform, formatDate, formatSize, sizePhrase, useReleases } from "../lib/releases.js";

const STEPS = [
  ["Install Apple's iPhone software", <>Get <a href="https://apps.microsoft.com/detail/9np83lwlpz9k" target="_blank" rel="noreferrer"><b>Apple Devices</b> from the Microsoft Store</a> (free, made by Apple; iTunes also works). It lets Windows talk to an iPhone. You don't need to keep it open.</>],
  ["Download and save the app", <>Save <span className="mono">LocationSpooferStandalone.exe</span> in a folder you own, such as Desktop or Documents, so it can update itself.</>],
  ["Run it", <>The app isn't code-signed yet, so Windows may say “Windows protected your PC”. Choose <b>More info → Run anyway</b>.</>],
  ["Follow the setup guide", <>Plug in the iPhone, unlock it and tap <b>Trust</b>. Press <b>Reveal Developer Mode</b>, turn it on in <i>Settings › Privacy &amp; Security</i>, restart the iPhone, then press <b>Connect</b>.</>],
  ["Pick a place", <>Press <b>Teleport here</b>, or build a route and press <b>Play</b>. Press <b>Stop spoofing</b> when you're done.</>],
];

const PLATFORM_NOTE = {
  mac: "You're on a Mac. Location Spoofer runs on Windows 10 and 11; you can still try the demo above.",
  linux: "You're on Linux. Location Spoofer runs on Windows 10 and 11; you can still try the demo above.",
  mobile: "You're on a phone. The app runs on a Windows 10 or 11 PC, with the iPhone plugged into it.",
};

export default function Install() {
  const releases = useReleases();
  const root = useRef(null);
  const platform = useMemo(detectPlatform, []);
  const ok = releases.status === "ok";
  const s = ok ? releases.standalone : null;
  const b = ok ? releases.browser : null;

  useEffect(() => {
    if (prefersReducedMotion()) return undefined;
    return whenIdle(() => gsap.context(() => {
      gsap.fromTo(".steps-line-fill", { scaleY: 0 }, { scaleY: 1, ease: "none", scrollTrigger: { trigger: ".steps", start: "top 70%", end: "bottom 60%", scrub: 0.5 } });
      gsap.utils.toArray(".step").forEach((el) => {
        gsap.from(el, { x: -12, opacity: 0, duration: 0.45, ease: "power3.out", scrollTrigger: { trigger: el, start: "top 82%", once: true } });
      });
      gsap.from(".dl-card", { y: 22, opacity: 0, duration: 0.55, stagger: 0.07, ease: "power3.out", scrollTrigger: { trigger: ".dl-cards", start: "top 85%", once: true } });
    }, root));
  }, []);

  return (
    <section className="section install" id="install" ref={root}>
      <div className="container">
        <header className="sec-head">
          <p className="kicker"><span className="idx">08</span> Install</p>
          <h2>Ready in about five minutes.</h2>
          <p>Windows 10 or 11 (64-bit), an iPhone or iPad with Developer Mode, a USB cable, and an internet connection for maps and routing.</p>
        </header>

        <div className="install-grid">
          <div className="dl-cards">
            <article className="dl-card primary">
              <div className="dl-top">
                <span className="tag mono">Recommended</span>
                <h3>Standalone app</h3>
                <p>Its own window, {sizePhrase(s, "a small download")}, starts instantly. iOS 17.4 and newer, and iOS 16 and older.</p>
              </div>
              <dl className="dl-meta mono">
                <div><dt>Version</dt><dd>{s ? s.version : releases.status === "loading" ? "…" : "see GitHub"}</dd></div>
                <div><dt>Size</dt><dd>{s ? formatSize(s.size) : "–"}</dd></div>
                <div><dt>Released</dt><dd>{s ? formatDate(s.published) : "–"}</dd></div>
              </dl>
              <div className="dl-actions">
                <a className="btn btn-primary" href={s?.url || LATEST_STANDALONE_EXE}>
                  <Icon name="download" /> {s?.file || "LocationSpooferStandalone.exe"}
                </a>
                {s?.shaUrl && <a className="text-link mono" href={s.shaUrl}>SHA-256</a>}
                <a className="text-link mono" href={s?.page || RELEASES.standalone} target="_blank" rel="noreferrer">Release notes</a>
              </div>
            </article>

            <article className="dl-card">
              <div className="dl-top">
                <h3>Browser edition</h3>
                <p>Opens in your web browser; {sizePhrase(b, "a larger download")}, 10–20 s to start. Needed only for iOS 17.0–17.3, where it asks for administrator permission once per session.</p>
              </div>
              <dl className="dl-meta mono">
                <div><dt>Version</dt><dd>{b ? b.version : releases.status === "loading" ? "…" : "see GitHub"}</dd></div>
                <div><dt>Size</dt><dd>{b ? formatSize(b.size) : "–"}</dd></div>
              </dl>
              <div className="dl-actions">
                <a className="btn btn-ghost" href={b?.url || RELEASES.browser} {...(b?.url ? {} : { target: "_blank", rel: "noreferrer" })}>
                  <Icon name="download" /> {b?.file || "Browser edition"}
                </a>
                <a className="text-link mono" href={`${REPO_URL}#which-download-should-i-use`} target="_blank" rel="noreferrer">Which one?</a>
              </div>
            </article>
            {PLATFORM_NOTE[platform] && <p className="platform-note">{PLATFORM_NOTE[platform]}</p>}
            {releases.status === "error" && <p className="platform-note">Couldn't reach GitHub for the version details. The Standalone button still downloads the latest version.</p>}
          </div>

          <div className="steps-wrap">
          <span className="steps-line" aria-hidden="true"><span className="steps-line-fill" /></span>
          <ol className="steps">
            {STEPS.map(([title, body], i) => (
              <li className="step" key={title}>
                <span className="step-n mono" aria-hidden="true">{i + 1}</span>
                <h3>{title}</h3>
                <p>{body}</p>
              </li>
            ))}
          </ol>
          </div>
        </div>
      </div>
    </section>
  );
}
