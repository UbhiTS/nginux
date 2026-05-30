import qrcode from "qrcode-generator";

/**
 * Renders a QR code for `value` as a self-contained SVG, generated entirely in
 * the browser (no external QR service) — so secrets like a TOTP otpauth URI
 * never leave the device. Black modules on a white field with a quiet-zone
 * border so it scans reliably regardless of the app theme.
 */
export function QrCode({ value, size = 188 }: { value: string; size?: number }) {
  const qr = qrcode(0, "M"); // auto version, medium error correction
  qr.addData(value); // Byte mode (default) — otpauth URIs are ASCII
  qr.make();

  const count = qr.getModuleCount();
  const margin = 4; // quiet zone in modules (QR spec recommends 4)
  const dim = count + margin * 2;

  let path = "";
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) path += `M${c + margin},${r + margin}h1v1h-1z`;
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${dim} ${dim}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="Two-factor authentication QR code"
      style={{ display: "block" }}
    >
      <rect width={dim} height={dim} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
