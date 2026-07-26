import websiteIconUrl from "../assets/website-icon.png";

// Shared UI brand mark used by the sidebar, authentication screens, loading
// state, and About panel. Importing the asset gives it a content-hashed URL so
// a new deployment cannot keep serving a stale cached logo.
export function BrandLogo({ className, size = 32 }: { className?: string; size?: number }) {
  return (
    <img
      className={className}
      src={websiteIconUrl}
      alt="NginUX"
      width={size}
      height={size}
      style={{ width: size, height: size }}
      draggable={false}
    />
  );
}
