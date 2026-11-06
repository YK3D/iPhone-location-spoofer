// A Windows-style window frame around recordings and screenshots of the app.
export default function AppWindow({ title = "Location Spoofer", children, className = "", style }) {
  return (
    <figure className={`app-window ${className}`} style={style}>
      <div className="aw-bar" aria-hidden="true">
        <img src="/icon-32.png" alt="" width="16" height="16" />
        <span className="aw-title">{title}</span>
        <span className="aw-ctrls">
          <svg viewBox="0 0 10 10"><path d="M1 5h8" /></svg>
          <svg viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7" /></svg>
          <svg viewBox="0 0 10 10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" /></svg>
        </span>
      </div>
      <div className="aw-body">{children}</div>
    </figure>
  );
}
