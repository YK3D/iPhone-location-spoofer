import { useEffect, useMemo, useRef } from "react";
import Icon from "../components/Icon.jsx";
import { gsap, prefersReducedMotion } from "../lib/motion.js";
import { RELEASES, REPO_URL, detectPlatform, formatDate, formatSize } from "../lib/releases.js";

const STEPS = [
  ["Install Apple's iPhone software", <>Get <b>Apple Devices</b> from the Microsoft Store (iTunes also works). It provides the driver Windows needs to talk to an iPhone. You don't need to keep it open.</>],
  ["Download and save the app", <>Save <span className="mono">LocationSpooferStandalone.exe</span> in a folder you own, such as Desktop or Documents, so it can update itself.</>],
  ["Run it", <>The app isn't code-signed yet, so Windows may say “Windows protected your PC”. Choose <b>More info → Run anyway</b>.</>],
  ["Follow the setup guide", <>Plug in the iPhone, unlock it and tap <b>Trust</b>. Press <b>Reveal Developer Mode</b>, turn it on in <i>Settings › Privacy &amp; Security</i>, restart the iPhone, then press <b>Connect</b>.</>],
  ["Pick a place", <>Press <b>Teleport here</b>, or build a route and press <b>Play</b>. Press <b>Stop spoofing</b> when you're done.</>],
];

const PLATFORM_NOTE = {
  mac: "You're on a Mac. The downloads are Windows apps; the Browser edition can also run from source on macOS.",
  linux: "You're on Linux. The downloads are Windows apps; the Browser edition can also run from source on Linux.",
  mobile: "You're on a phone. The app runs on a Windows 10 or 11 PC, with the iPhone plugged into it.",
};

export default function Install({ releases }) {
  const root = useRef(null);
  const platform = useMemo(detectPlatform, []);
  const ok = releases.status === "ok";
  const s = ok ? releases.standalone : null;
  const b = ok ? releases.browser : null;

  useEffect(() => {
    if (prefersReducedMotion()) return undefined;
    const ctx = gsap.context(() => {
      gsap.fromTo(".steps-line-fill", { scaleY: 0 }, { scaleY: 1, ease: "none", scrollTrigger: { trigger: ".steps", start: "top 70%", end: "bottom 60%", scrub: 0.5 } });
      gsap.utils.toArray(".step").forEach((el) => {
        gsap.from(el, { x: -16, opacity: 0, duration: 0.7, ease: "power3.out", scrollTrigger: { trigger: el, start: "top 80%", once: true } });
      });
      gsap.from(".dl-card", { y: 30, opacity: 0, duration: 0.9, stagger: 0.1, ease: "power3.out", scrollTrigger: { trigger: ".dl-cards", start: "top 85%", once: true } });
    }, root);
    return () => ctx.revert();
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
                <p>Its own window, under 20 MB, starts instantly. iOS 17.4 and newer, and iOS 16 and older.</p>
              </div>
              <dl className="dl-meta mono">
                <div><dt>Version</dt><dd>{s ? s.version : releases.status === "loading" ? "…" : "see GitHub"}</dd></div>
                <div><dt>Size</dt><dd>{s ? formatSize(s.size) : "–"}</dd></div>
                <div><dt>Released</dt><dd>{s ? formatDate(s.published) : "–"}</dd></div>
              </dl>
              <div className="dl-actions">
                <a className="btn btn-primary" href={s?.url || RELEASES.standalone} {...(s?.url ? {} : { target: "_blank", rel: "noreferrer" })}>
                  <Icon name="download" /> {s?.file || "Download from GitHub"}
                </a>
                {s?.shaUrl && <a className="text-link mono" href={s.shaUrl}>SHA-256</a>}
                <a className="text-link mono" href={s?.page || RELEASES.standalone} target="_blank" rel="noreferrer">Release notes</a>
              </div>
            </article>

            <article className="dl-card">
              <div className="dl-top">
                <h3>Browser edition</h3>
                <p>Opens in your web browser. About 80 MB and 10–20 s to start, and adds iOS 17.0–17.3 with an administrator “tunnel helper”.</p>
              </div>
              <dl className="dl-meta mono">
                <div><dt>Version</dt><dd>{b ? b.version : releases.status === "loading" ? "…" : "see GitHub"}</dd></div>
                <div><dt>Size</dt><dd>{b ? formatSize(b.size) : "–"}</dd></div>
              </dl>
              <div className="dl-actions">
                <a className="btn btn-ghost" href={b?.url || RELEASES.browser} {...(b?.url ? {} : { target: "_blank", rel: "noreferrer" })}>
                  <Icon name="download" /> {b?.file || "Browser edition"}
                </a>
                <a className="text-link mono" href={`${REPO_URL}#building-from-source`} target="_blank" rel="noreferrer">Run from source</a>
              </div>
            </article>
            {PLATFORM_NOTE[platform] && <p className="platform-note">{PLATFORM_NOTE[platform]}</p>}
            {releases.status === "error" && <p className="platform-note">Couldn't reach GitHub for the latest version, so the buttons open the release pages instead.</p>}
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
