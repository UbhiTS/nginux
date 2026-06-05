import { useEffect, useState } from "react";

const ICON_CDN = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons";
/** Full logo URL for a dashboard-icons slug (empty slug -> no logo / generic). */
export const iconUrlForSlug = (slug?: string) => (slug ? `${ICON_CDN}/svg/${slug}.svg` : "");

/** Neutral app glyph for services without a logo (or whose logo fails to load). */
function GenericIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}
      style={{ display: "inline-block", verticalAlign: "middle", opacity: 0.7 }}>
      <rect x="3" y="3" width="18" height="18" rx="4.5" />
      <path d="M3 9h18M9 9v12" />
    </svg>
  );
}

/** A service's icon: its dashboard-icons logo (or any image URL) when set, else a
 *  neutral generic glyph. Falls back to the glyph if the image fails to load, so
 *  the UI never shows a broken image. */
export function ServiceIcon({ iconUrl, size = 20 }: { iconUrl?: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [iconUrl]); // retry when the URL changes
  if (!iconUrl || failed) return <GenericIcon size={size} />;
  return (
    <img
      src={iconUrl}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size, objectFit: "contain", display: "inline-block", verticalAlign: "middle", borderRadius: 4 }}
      onError={() => setFailed(true)}
    />
  );
}
