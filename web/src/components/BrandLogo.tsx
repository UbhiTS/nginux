// Inline, animated version of /favicon.svg (the static file stays the browser
// favicon). The orbit ring + network nodes rotate slowly and the sparkle
// twinkles - see .logo-* rules in styles.css, which honour prefers-reduced-motion.
export function BrandLogo({ className, size = 32 }: { className?: string; size?: number }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="NginUX">
      <defs>
        <linearGradient id="bl-bg" x1="4" y1="2" x2="60" y2="62" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ff2d9b" />
          <stop offset="0.5" stopColor="#7a2bff" />
          <stop offset="1" stopColor="#15e0f5" />
        </linearGradient>
        <radialGradient id="bl-glow" cx="0.3" cy="0.22" r="0.95">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.6" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="bl-spark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff7c2" />
          <stop offset="1" stopColor="#ffd000" />
        </linearGradient>
        <filter id="bl-soft" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="1.4" />
        </filter>
      </defs>

      {/* vivid badge + top sheen */}
      <rect x="2" y="2" width="60" height="60" rx="16" fill="url(#bl-bg)" />
      <rect x="2" y="2" width="60" height="60" rx="16" fill="url(#bl-glow)" />

      {/* orbit ring + network nodes, slowly rotating together (proxy/traffic motif) */}
      <g className="logo-orbit">
        <circle cx="32" cy="32" r="20.5" fill="none" stroke="#ffffff" strokeOpacity="0.4" strokeWidth="1.6" strokeDasharray="2.5 5.5" strokeLinecap="round" />
        <circle cx="12.5" cy="26" r="3.4" fill="#15e0f5" filter="url(#bl-soft)" />
        <circle cx="12.5" cy="26" r="2.4" fill="#ffffff" />
        <circle cx="50" cy="44" r="3.4" fill="#ff2d9b" filter="url(#bl-soft)" />
        <circle cx="50" cy="44" r="2.4" fill="#ffffff" />
      </g>

      {/* bold N monogram (static anchor) */}
      <g fill="none" stroke="#ffffff" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 45 V19" />
        <path d="M22 19 L42 45" />
        <path d="M42 45 V19" />
      </g>

      {/* sparkle: twinkles */}
      <g className="logo-spark">
        <g filter="url(#bl-soft)"><path d="M47 8 L49 15 L56 17 L49 19 L47 26 L45 19 L38 17 L45 15 Z" fill="#ffd000" opacity="0.9" /></g>
        <path d="M47 10 L48.4 15.6 L54 17 L48.4 18.4 L47 24 L45.6 18.4 L40 17 L45.6 15.6 Z" fill="url(#bl-spark)" />
      </g>
    </svg>
  );
}
