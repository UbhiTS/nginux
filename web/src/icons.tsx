// Minimal stroke-icon set (mirrors the SVGs used in the mockup).
type P = { className?: string };

const S = ({ children, ...p }: P & { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={p.className}>
    {children}
  </svg>
);

// Filled brand mark (fill, not stroke) - for logos like GitHub.
const Brand = ({ children, ...p }: P & { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={p.className}>
    {children}
  </svg>
);

export const Icon = {
  github: (p: P) => (
    <Brand {...p}>
      <path d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.2 3.44 9.6 8.21 11.16.6.11.82-.26.82-.58v-2.03c-3.34.71-4.04-1.6-4.04-1.6-.55-1.38-1.34-1.74-1.34-1.74-1.08-.74.08-.72.08-.72 1.2.08 1.83 1.22 1.83 1.22 1.07 1.8 2.81 1.28 3.5.98.1-.76.42-1.28.76-1.57-2.67-.3-5.47-1.31-5.47-5.83 0-1.29.47-2.34 1.24-3.17-.12-.3-.54-1.52.12-3.17 0 0 1.01-.32 3.3 1.21a11.6 11.6 0 0 1 6 0c2.29-1.53 3.3-1.21 3.3-1.21.66 1.65.24 2.87.12 3.17.77.83 1.24 1.88 1.24 3.17 0 4.53-2.81 5.53-5.49 5.82.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.83.58A12.01 12.01 0 0 0 24 12.29C24 5.78 18.63.5 12 .5z" />
    </Brand>
  ),
  menu: (p: P) => (
    <S {...p}>
      <path d="M3 6h18M3 12h18M3 18h18" strokeLinecap="round" />
    </S>
  ),
  download: (p: P) => (
    <S {...p}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" strokeLinecap="round" strokeLinejoin="round" />
    </S>
  ),
  trash: (p: P) => (
    <S {...p}>
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6M10 11v6M14 11v6" />
    </S>
  ),
  dashboard: (p: P) => (
    <S {...p}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </S>
  ),
  globe: (p: P) => (
    <S {...p}>
      <path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
      <path d="M3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
    </S>
  ),
  shield: (p: P) => (
    <S {...p}>
      <path d="M12 2 4 6v6c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6l-8-4Z" />
      <path d="m9 12 2 2 4-4" />
    </S>
  ),
  chart: (p: P) => (
    <S {...p}>
      <path d="M3 3v18h18" />
      <path d="m7 14 3-4 3 3 5-7" />
    </S>
  ),
  logs: (p: P) => (
    <S {...p}>
      <path d="M4 6h16M4 12h16M4 18h10" />
    </S>
  ),
  bot: (p: P) => (
    <S {...p}>
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 8V4M9 4h6M8.5 14h.01M15.5 14h.01M2 13v2M22 13v2" />
    </S>
  ),
  users: (p: P) => (
    <S {...p}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </S>
  ),
  gear: (p: P) => (
    <S {...p}>
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </S>
  ),
  cert: (p: P) => (
    <S {...p}>
      <path d="M12 2 4 6v6c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6l-8-4Z" />
      <path d="m9 12 2 2 4-4" />
    </S>
  ),
  plus: (p: P) => (
    <S {...p}>
      <path d="M12 5v14M5 12h14" />
    </S>
  ),
  chevron: (p: P) => (
    <S {...p}>
      <path d="m9 18 6-6-6-6" />
    </S>
  ),
  arrowRight: (p: P) => (
    <S {...p}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </S>
  ),
  arrowLeft: (p: P) => (
    <S {...p}>
      <path d="M19 12H5M11 18l-6-6 6-6" />
    </S>
  ),
  logout: (p: P) => (
    <S {...p}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" strokeLinecap="round" strokeLinejoin="round" />
    </S>
  ),
  camera: (p: P) => (
    <S {...p}>
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="13" r="4" />
    </S>
  ),
  check: (p: P) => (
    <S {...p}>
      <path d="m5 13 4 4L19 7" />
    </S>
  ),
  x: (p: P) => (
    <S {...p}>
      <path d="M18 6 6 18M6 6l12 12" />
    </S>
  ),
  search: (p: P) => (
    <S {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4-4" />
    </S>
  ),
  external: (p: P) => (
    <S {...p}>
      <path d="M7 7h10v10M7 17 17 7" />
    </S>
  ),
  bolt: (p: P) => (
    <S {...p}>
      <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z" />
    </S>
  ),
  lock: (p: P) => (
    <S {...p}>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </S>
  ),
  info: (p: P) => (
    <S {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </S>
  ),
  alert: (p: P) => (
    <S {...p}>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </S>
  ),
  moon: (p: P) => (
    <S {...p}>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </S>
  ),
  sun: (p: P) => (
    <S {...p}>
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </S>
  ),
  contrast: (p: P) => (
    <S {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 0 0 18Z" fill="currentColor" stroke="none" />
    </S>
  ),
  // A crescent moon with a small sparkle - the "less dark" step.
  moonStar: (p: P) => (
    <S {...p}>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
      <path d="M5 3.6v2.4M3.8 4.8h2.4" />
    </S>
  ),
  // A sun with short rays - the dimmer "less light" step.
  sunDim: (p: P) => (
    <S {...p}>
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 4v1.6M12 18.4V20M4 12h1.6M18.4 12H20" />
    </S>
  ),
  // Circular arrows - retry / reload.
  refresh: (p: P) => (
    <S {...p}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v5h-5" />
    </S>
  ),
  // ---- added for the icon/graphics pass (section + stat iconography) ----
  server: (p: P) => (<S {...p}><rect x="3" y="4" width="18" height="6" rx="2" /><rect x="3" y="14" width="18" height="6" rx="2" /><path d="M7 7h.01M7 17h.01" strokeLinecap="round" /></S>),
  key: (p: P) => (<S {...p}><circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.7 12.3 8.3-8.3M16 5l3 3M13.5 7.5l2 2" strokeLinecap="round" /></S>),
  activity: (p: P) => (<S {...p}><path d="M3 12h4l2.5 7 4-14L16 12h5" strokeLinecap="round" strokeLinejoin="round" /></S>),
  clock: (p: P) => (<S {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" strokeLinecap="round" /></S>),
  filter: (p: P) => (<S {...p}><path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z" strokeLinejoin="round" /></S>),
  copy: (p: P) => (<S {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></S>),
  ban: (p: P) => (<S {...p}><circle cx="12" cy="12" r="9" /><path d="m5.6 5.6 12.8 12.8" strokeLinecap="round" /></S>),
  mail: (p: P) => (<S {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></S>),
  bell: (p: P) => (<S {...p}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" strokeLinejoin="round" /><path d="M13.7 21a1.9 1.9 0 0 1-3.4 0" strokeLinecap="round" /></S>),
  database: (p: P) => (<S {...p}><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></S>),
  edit: (p: P) => (<S {...p}><path d="M12 20h9" strokeLinecap="round" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" strokeLinejoin="round" /></S>),
  flag: (p: P) => (<S {...p}><path d="M4 21V4M4 4h13l-2.5 4L17 12H4" strokeLinecap="round" strokeLinejoin="round" /></S>),
  sliders: (p: P) => (<S {...p}><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" strokeLinecap="round" /></S>),
  network: (p: P) => (<S {...p}><circle cx="12" cy="5" r="2.5" /><circle cx="5" cy="19" r="2.5" /><circle cx="19" cy="19" r="2.5" /><path d="M12 7.5v3M11 11 6.5 16.5M13 11l4.5 5.5" /></S>),
  layers: (p: P) => (<S {...p}><path d="m12 2 9 5-9 5-9-5 9-5Z" strokeLinejoin="round" /><path d="m3.5 12 8.5 4.7 8.5-4.7M3.5 16.8 12 21.5l8.5-4.7" strokeLinejoin="round" /></S>),
  eye: (p: P) => (<S {...p}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" strokeLinejoin="round" /><circle cx="12" cy="12" r="3" /></S>),
  upload: (p: P) => (<S {...p}><path d="M12 16V4M7 9l5-5 5 5M4 20h16" strokeLinecap="round" strokeLinejoin="round" /></S>),
  plug: (p: P) => (<S {...p}><path d="M9 2v6M15 2v6M7 8h10v2a5 5 0 0 1-10 0V8ZM12 15v7" strokeLinecap="round" strokeLinejoin="round" /></S>),
};

export type IconName = keyof typeof Icon;
