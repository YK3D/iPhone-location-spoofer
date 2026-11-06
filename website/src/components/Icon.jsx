// Small line icons drawn for this site (24 x 24 grid, 1.75 stroke). Decorative by default.
const P = {
  download: <><path d="M12 4v11" /><path d="m7 10.5 5 5 5-5" /><path d="M5 19.5h14" /></>,
  arrowRight: <><path d="M5 12h13" /><path d="m13 6.5 5.5 5.5-5.5 5.5" /></>,
  arrowUpRight: <><path d="M7 17 17 7" /><path d="M8.5 7H17v8.5" /></>,
  github: <path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" /></>,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  play: <path d="M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.3-7.2a.8.8 0 0 0 0-1.4L8.2 4.1a.8.8 0 0 0-1.2.7Z" />,
  pause: <><rect x="6" y="4.5" width="4" height="15" rx="1" /><rect x="14" y="4.5" width="4" height="15" rx="1" /></>,
  stop: <rect x="5.5" y="5.5" width="13" height="13" rx="1.5" />,
  pin: <><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" /><circle cx="12" cy="10" r="2.4" /></>,
  route: <><circle cx="6" cy="18.5" r="2.2" /><circle cx="18" cy="5.5" r="2.2" /><path d="M8.2 18.5H16a3.2 3.2 0 0 0 0-6.4H8a3.2 3.2 0 0 1 0-6.4h7.8" /></>,
  joystick: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v3M12 14v3M7 12h3M14 12h3" /></>,
  file: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5" /><path d="M8.5 16.5c1.5-3 3-3 4 0s2.5 3 3 0" /></>,
  keyboard: <><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7.5 14h9" /></>,
  shield: <><path d="M12 21s7.5-3.2 7.5-9.5V5.8L12 3 4.5 5.8v5.7C4.5 17.8 12 21 12 21Z" /><path d="m9 12 2.2 2.2L15.5 10" /></>,
  refresh: <><path d="M20 11a8 8 0 0 0-14.7-4.3L4 8.5" /><path d="M4 3.5v5h5" /><path d="M4 13a8 8 0 0 0 14.7 4.3L20 15.5" /><path d="M20 20.5v-5h-5" /></>,
  star: <path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9Z" />,
  palette: <><path d="M12 21a9 9 0 1 1 9-9c0 2.5-2 3.5-3.5 3.5H15a1.8 1.8 0 0 0-1.3 3.1A1.5 1.5 0 0 1 12 21Z" /><circle cx="7.5" cy="11" r="1" /><circle cx="10.5" cy="7" r="1" /><circle cx="15" cy="7.5" r="1" /></>,
  map: <><path d="M9 4.5 3.5 6.5v13L9 17.5l6 2 5.5-2v-13L15 6.5Z" /><path d="M9 4.5v13M15 6.5v13" /></>,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  cable: <><path d="M7 3v4M11 3v4" /><rect x="5" y="7" width="8" height="5" rx="1" /><path d="M9 12v3a4 4 0 0 0 4 4h2a4 4 0 0 0 4-4V3" /></>,
  phone: <><rect x="6.5" y="2.5" width="11" height="19" rx="2.5" /><path d="M10.5 5.5h3" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  nav: <path d="M12 3 19 20l-7-3.6L5 20Z" />,
  windows: <><path d="M3.5 5.5 10.5 4.5v7h-7ZM12.5 4.2 20.5 3v8.5h-8ZM3.5 12.5h7v7l-7-1ZM12.5 12.5h8V21l-8-1.2Z" /></>,
  toggle: <><rect x="2.5" y="7" width="19" height="10" rx="5" /><circle cx="16.5" cy="12" r="3" /></>,
  crosshair: <><circle cx="12" cy="12" r="7.5" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></>,
  copy: <><rect x="8.5" y="8.5" width="12" height="12" rx="2" /><path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" /></>,
};

export default function Icon({ name, size, label, fill = false, className, style }) {
  const solid = fill || name === "play";
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      style={style}
      fill={solid ? "currentColor" : "none"}
      stroke={solid ? "none" : "currentColor"}
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      focusable="false"
    >
      {P[name]}
    </svg>
  );
}
