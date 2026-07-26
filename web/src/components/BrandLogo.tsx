// Shared UI brand mark used by the sidebar, authentication screens, loading
// state, and About panel. The browser favicon and installable-app icons remain
// separate assets so each surface can use its own approved artwork.
export function BrandLogo({ className, size = 32 }: { className?: string; size?: number }) {
  return (
    <img
      className={className}
      src="/website-icon.png"
      alt="NginUX"
      width={size}
      height={size}
      style={{ width: size, height: size }}
      draggable={false}
    />
  );
}
