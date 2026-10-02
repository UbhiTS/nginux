import { isIP } from "node:net";
import { resolve, sep } from "node:path";

// Input validation shared by the API and the nginx generator. The generator
// emits user-supplied strings into real nginx config and onto the filesystem
// (cert paths keyed by domain), so these guards are a security boundary, not
// cosmetic: they block config-directive injection and path traversal.

/** A DNS hostname or wildcard domain. No slashes, spaces, or nginx metacharacters. */
const HOSTNAME_RE = /^(\*\.)?(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
/** A bare label like "localhost" or a single-segment internal name. */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export function isHostname(s: string): boolean {
  return HOSTNAME_RE.test(s) || LABEL_RE.test(s);
}

function isIpv4(s: string): boolean {
  return isIP(s) === 4;
}

/** Host portion of a forward/upstream target: hostname or IP (no port). */
export function isHost(s: string): boolean {
  if (!s || /[\s;{}'"\\]/.test(s)) return false;
  if (isIpv4(s)) return true;
  // Reject legacy inet_aton forms (integer/hex/octal) that URL stacks can
  // reinterpret as an IPv4 address after validation.
  if (/^(?:\d+|0x[0-9a-f]+)$/i.test(s)) return false;
  if (isHostname(s)) return true;
  // bracketed or bare IPv6
  const v6 = s.replace(/^\[|\]$/g, "");
  return isIP(v6) === 6;
}

/** "host:port" upstream target. */
export function isHostPort(s: string): boolean {
  const m = s.match(/^(.+):(\d{1,5})$/);
  if (!m) return false;
  const port = Number(m[2]);
  return port >= 1 && port <= 65535 && isHost(m[1]);
}

/** An IPv4/IPv6 address or CIDR (for allow/deny lists and bans). The mask must be
 *  plain decimal digits: `Number()` would also accept `""`, `1e1`, `0x8`, `+8`, all
 *  of which nginx rejects - and a rejected ban entry wedges `nginx -t` for every
 *  later apply. IPv6 zone ids (`fe80::1%eth0`) are likewise refused. */
export function isIpOrCidr(s: string): boolean {
  if (!s || /[\s;{}'"\\%]/.test(s)) return false;
  const [addr, cidr, extra] = s.split("/");
  if (extra !== undefined) return false;
  if (cidr !== undefined) {
    if (!/^\d{1,3}$/.test(cidr)) return false;
    const bits = Number(cidr);
    const max = addr.includes(":") ? 128 : 32;
    if (!Number.isInteger(bits) || bits < 0 || bits > max) return false;
  }
  const kind = isIP(addr);
  if (!kind) return false;
  if (cidr !== undefined && Number(cidr) > (kind === 6 ? 128 : 32)) return false;
  return true;
}

/** HTTP header name (custom response headers). */
export function isHeaderName(s: string): boolean {
  return /^[A-Za-z0-9-]{1,128}$/.test(s);
}

/** A URL path prefix for per-path routing (no nginx metacharacters, no `..`
 *  segments, and `%` only as a well-formed percent-escape). */
export function isLocationPath(s: string): boolean {
  return /^[A-Za-z0-9/_.~%-]{1,512}$/.test(s) && s.startsWith("/")
    && !/(^|\/)\.\.(\/|$)/.test(s) && !/%(?![0-9A-Fa-f]{2})/.test(s);
}

/** Reject any string that could break out of an nginx directive/block, or that
 *  nginx would expand per request inside a quoted "complex value" (`$var`) or
 *  treat as an escape (`\`). */
export function hasNginxMetachars(s: string): boolean {
  return /[;{}\n\r$\\]/.test(s);
}

// ---- canonical splitters (ONE definition; the validators AND the nginx
// generator must tokenise identically, or a value could validate one way and
// generate another). Previously copy-pasted in index.ts, tools.ts and nginx.ts. ----

/** Newline-separated, trimmed, non-empty lines (custom headers, path rules, upstreams). */
export function splitLines(s: string): string[] {
  return String(s).split("\n").map((x) => x.trim()).filter(Boolean);
}
/** Whitespace/comma-separated, trimmed, non-empty entries (IP allow/deny lists). */
export function splitEntries(s: string): string[] {
  return String(s).split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
}

// ---- SSRF guard for OUTBOUND requests (webhooks, notification channels) ----
// This is a homelab proxy, so private LAN targets are legitimate (a self-hosted
// gotify/ntfy on 192.168.x). The genuinely dangerous target with no legitimate
// use is the cloud-metadata / link-local range and the unspecified address.
const LINK_LOCAL_V4 = /^169\.254\./;          // includes 169.254.169.254 (cloud metadata)
const UNSPEC_V4 = /^0\./;
const CLOUD_METADATA_V4 = new Set([
  "100.100.100.200", // Alibaba Cloud
]);

export function isDangerousHost(host: string): boolean {
  let h = host.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  // Canonicalize EVERY host through the same WHATWG parser used by fetch(). This
  // closes mixed/legacy IPv4 spellings such as 0xa9.0xfe.0xa9.0xfe and 127.1,
  // not just the all-integer forms the old branch handled.
  try {
    const authority = isIP(h) === 6 ? `[${h}]` : h;
    h = new URL(`http://${authority}/`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch { /* leave invalid input for the caller's syntax validator */ }
  if (h === "metadata.google.internal" || h === "metadata.goog") return true;
  // Normalise IPv4-mapped/-compatible/SIIT/NAT64 IPv6 to the embedded IPv4 so the v4
  // rules below still catch it - otherwise `::ffff:169.254.169.254`, `::ffff:a9fe:a9fe`,
  // SIIT `::ffff:0:a9fe:a9fe`, or NAT64 `64:ff9b::a9fe:a9fe` reaches cloud metadata.
  const dotted = h.match(/^(?:::(?:ffff:(?:0:(?:0:)?)?)?|64:ff9b::)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (dotted) h = dotted[1];
  const hex = h.match(/^(?:::(?:ffff:(?:0:(?:0:)?)?)?|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const a = parseInt(hex[1], 16), b = parseInt(hex[2], 16);
    h = `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  // RFC 8215 local-use NAT64 prefix (64:ff9b:1::/48): any address under it is a
  // translator-side alias for some IPv4 host, so never let it be an outbound target.
  if (/^64:ff9b:1:/.test(h)) return true;
  const nat64Zero = h.match(/^64:ff9b::([0-9a-f]{1,4})?$/);
  if (nat64Zero) {
    const b = parseInt(nat64Zero[1] || "0", 16);
    h = `0.0.${b >> 8}.${b & 255}`;
  }
  if (LINK_LOCAL_V4.test(h) || UNSPEC_V4.test(h) || CLOUD_METADATA_V4.has(h)) return true;
  // IPv6 link-local is fe80::/10 (fe80 through febf), not only the fe80: prefix.
  const firstV6 = isIP(h) === 6 ? parseInt(h.split(":")[0] || "0", 16) : -1;
  if ((firstV6 & 0xffc0) === 0xfe80 || h === "::") return true;
  if (h === "fd00:ec2::254") return true; // AWS IMDS IPv6 endpoint
  if (h === "[::]" || h === "0.0.0.0") return true;
  return false;
}

/** Assert `targetPath` resolves inside `baseDir` (path-traversal defense). */
export function assertWithin(baseDir: string, targetPath: string): string {
  const base = resolve(baseDir);
  const target = resolve(targetPath);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error("Path escapes the allowed directory.");
  }
  return target;
}

/** Throw if the URL is not an http(s) URL to a non-dangerous host. */
export function assertSafeOutboundUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Invalid URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed.");
  }
  if (isDangerousHost(u.hostname)) {
    throw new Error("That destination host is not allowed.");
  }
  return u;
}
