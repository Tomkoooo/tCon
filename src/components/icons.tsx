// The app's one icon set: 16px grid, 1.3 stroke, round caps, currentColor.
// Use <Icon name="…" /> everywhere instead of unicode glyphs so every icon has the same weight.

const P = {
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  minus: <path d="M3.5 8h9" />,
  close: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  chevronDown: <path d="M4.5 6.5L8 10l3.5-3.5" />,
  chevronUp: <path d="M4.5 9.5L8 6l3.5 3.5" />,
  chevronRight: <path d="M6.5 4.5L10 8l-3.5 3.5" />,
  arrowUp: <path d="M8 13V3.5M4.5 7L8 3.5 11.5 7" />,
  arrowDown: <path d="M8 3v9.5M4.5 9L8 12.5 11.5 9" />,
  arrowLeft: <path d="M13 8H3.5M7 4.5L3.5 8 7 11.5" />,
  refresh: <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" />,
  discard: <path d="M3.5 6.5h6.5a3 3 0 0 1 0 6H7M3.5 6.5L6 4M3.5 6.5L6 9" />,
  file: <><path d="M9.5 2H4.5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5z" /><path d="M9.5 2v3h3" /></>,
  diff: <><path d="M5 2.5v6M2 5.5h6M2 12h6" /><path d="M10.5 3.5h1.5a1 1 0 0 1 1 1v9" /></>,
  branch: <><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="5" r="1.5" /><path d="M4.5 5v6M11.5 6.5c0 3-7 2.2-7 4.5" /></>,
  eye: <><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></>,
  eyeOff: <><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /><path d="M2.5 13.5l11-11" /></>,
  collapse: <path d="M4.5 9.5L8 6l3.5 3.5M3 3h10" />,
  board: <><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M6 2.5v11M10 2.5v6" /></>,
  splitRight: <><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M8 2.5v11" /></>,
  splitDown: <><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M2 8h12" /></>,
  layout: <><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M6 2.5v11M6 9.5h8" /></>,
  terminal: <><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M4.5 6l2 2-2 2M8.5 10.5h3" /></>,
  search: <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L13.5 13.5" /></>,
  notes: <path d="M3 4h10M3 8h10M3 12h6" />,
  commit: <><circle cx="8" cy="8" r="2.5" /><path d="M1.5 8h4M10.5 8h4" /></>,
  star: <path d="M8 2l1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3 4.3 13.3l.8-4.1L2 6.3l4.2-.5z" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1" />,
  play: <path d="M5 3.5v9l7-4.5z" />,
  pause: <path d="M5.5 3.5v9M10.5 3.5v9" />,
  queue: <path d="M2.5 4h8M2.5 8h8M2.5 12h5M12.5 10.5l2 1.5-2 1.5" />,
  gear: <><path d="M12.86 6.82L14.54 7.15V8.85L12.86 9.18L12.27 10.6L13.23 12.02L12.02 13.23L10.6 12.27L9.18 12.86L8.85 14.54H7.15L6.82 12.86L5.4 12.27L3.98 13.23L2.77 12.02L3.73 10.6L3.14 9.18L1.46 8.85V7.15L3.14 6.82L3.73 5.4L2.77 3.98L3.98 2.77L5.4 3.73L6.82 3.14L7.15 1.46H8.85L9.18 3.14L10.6 3.73L12.02 2.77L13.23 3.98L12.27 5.4Z" /><circle cx="8" cy="8" r="2" /></>,
  files: <><path d="M10 2H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5z" /><path d="M10 2v3h3" /></>,
  arrowRight: <path d="M3 8h9.5M9 4.5L12.5 8 9 11.5" />,
  globe: <><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c1.7 1.7 2.5 3.7 2.5 6S9.7 12.3 8 14C6.3 12.3 5.5 10.3 5.5 8S6.3 3.7 8 2z" /></>,
  external: <><path d="M9.5 2.5h4v4M13.5 2.5L8 8" /><path d="M12 9.5V13a.5.5 0 0 1-.5.5h-8A.5.5 0 0 1 3 13V5a.5.5 0 0 1 .5-.5H7" /></>,
  inspect: <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" />,
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></>,
  target: <><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="2.5" /></>,
  cloud: <path d="M4.5 12.5h7a2.75 2.75 0 0 0 .4-5.47A4 4 0 0 0 4.2 7.6 2.5 2.5 0 0 0 4.5 12.5z" />,
  tag: <><path d="M2.5 3.5v4l6 6 5-5-6-6h-4a1 1 0 0 0-1 1z" /><circle cx="5.5" cy="5.5" r="1" /></>,
  fetch: <path d="M8 2.5v7.5M4.5 6.5L8 10l3.5-3.5M3 13.5h10" />,
  help: <><circle cx="8" cy="8" r="6" /><path d="M6.2 6.3a1.9 1.9 0 0 1 3.7.5c0 1.3-1.9 1.6-1.9 2.7" /><circle cx="8" cy="11.4" r=".35" /></>,
  history: <><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v3h3" /><path d="M8 5v3l2 1.5" /></>,
  database: <><ellipse cx="8" cy="3.75" rx="5" ry="1.75" /><path d="M3 3.75v8.5c0 1 2.2 1.75 5 1.75s5-.75 5-1.75v-8.5M3 8c0 1 2.2 1.75 5 1.75S13 9 13 8" /></>,
  server: <><rect x="2.5" y="2.5" width="11" height="4.5" rx="1" /><rect x="2.5" y="9" width="11" height="4.5" rx="1" /><path d="M5 4.75h.01M5 11.25h.01" /></>,
  chart: <path d="M2.5 2.5v11h11M5.5 10.5V8M8.5 10.5V5.5M11.5 10.5V7" />,
  book: <path d="M3 3.5a1 1 0 0 1 1-1h8.5v9.5H4a1 1 0 0 0-1 1zM3 12.5a1 1 0 0 0 1 1h8.5" />,
  folder: <path d="M2 4.5a1 1 0 0 1 1-1h3.25l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />,
  mail: <><rect x="2" y="3.5" width="12" height="9" rx="1.5" /><path d="M2.5 4.5L8 9l5.5-4.5" /></>,
} as const;

/** Filled glyphs (rendered with fill instead of stroke). */
const F = {
  more: <><circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" /></>,
  starFilled: <path d="M8 2l1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3 4.3 13.3l.8-4.1L2 6.3l4.2-.5z" />,
  dot: <circle cx="8" cy="8" r="3" />,
} as const;

export type IconName = keyof typeof P | keyof typeof F;

export function Icon({ name, size = 16, className, title }: { name: IconName; size?: number; className?: string; title?: string }) {
  const filled = name in F;
  return (
    <svg
      className={`icon${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title && <title>{title}</title>}
      {filled ? F[name as keyof typeof F] : P[name as keyof typeof P]}
    </svg>
  );
}

/** Claude's spark mark (used for "Claude" actions and Claude terminals). */
export function ClaudeMark({ size = 12, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className={`claude-mark${className ? ` ${className}` : ""}`}>
      <path
        d="M8 1.2l1.2 4.1 4.1-1.9-2.6 3.6 4.1 1.2-4.3.6 2.3 3.7-3.6-2.4L8 14.8l-1.2-4.7-3.6 2.4 2.3-3.7-4.3-.6 4.1-1.2-2.6-3.6 4.1 1.9z"
        fill="currentColor"
      />
    </svg>
  );
}
