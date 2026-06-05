import { resolve, sep } from "node:path";

// Input validation shared by the API and the nginx generator. The generator
// emits user-supplied strings into real nginx config and onto the filesystem
// (cert paths keyed by domain), so these guards are a security boundary, not
// cosmetic: they block config-directive injection and path traversal.

/** A DNS hostname or wildcard domain. No slashes, spaces, or nginx metacharacters. */
const HOSTNAME_RE = /^(\*\.)?(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
/** A bare label like "localhost" or a single-segment internal name. */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6_RE = /^[0-9a-f:]+$/i; // permissive; only used after rejecting metacharacters

export function isHostname(s: string): boolean {
  return HOSTNAME_RE.test(s) || LABEL_RE.test(s);
}

function isIpv4(s: string): boolean {
  return IPV4_RE.test(s);
}

/** Host portion of a forward/upstream target: hostname or IP (no port). */
export function isHost(s: string): boolean {
  if (!s || /[\s;{}'"\\]/.test(s)) return false;
  if (isIpv4(s) || isHostname(s)) return true;
  // bracketed or bare IPv6
  const v6 = s.replace(/^\[|\]$/g, "");
  return v6.includes(":") && IPV6_RE.test(v6);
}

/** "host:port" upstream target. */
export function isHostPort(s: string): boolean {
  const m = s.match(/^(.+):(\d{1,5})$/);
  if (!m) return false;
  const port = Number(m[2]);
  return port >= 1 && port <= 65535 && isHost(m[1]);
}

/** An IPv4/IPv6 address or CIDR (for allow/deny lists and bans). */
export function isIpOrCidr(s: string): boolean {
  if (!s || /[\s;{}'"\\]/.test(s)) return false;
  const [addr, cidr, extra] = s.split("/");
  if (extra !== undefined) return false;
  if (cidr !== undefined) {
    const bits = Number(cidr);
    const max = addr.includes(":") ? 128 : 32;
    if (!Number.isInteger(bits) || bits < 0 || bits > max) return false;
  }
  if (isIpv4(addr)) return true;
  return addr.includes(":") && IPV6_RE.test(addr);
}

/** HTTP header name (custom response headers). */
export function isHeaderName(s: string): boolean {
  return /^[A-Za-z0-9-]{1,128}$/.test(s);
}

/** A URL path prefix for per-path routing (no nginx metacharacters). */
export function isLocationPath(s: string): boolean {
  return /^[A-Za-z0-9/_.~%-]{1,512}$/.test(s) && s.startsWith("/");
}

/** Reject any string that could break out of an nginx directive/block. */
export function hasNginxMetachars(s: string): boolean {
  return /[;{}\n\r]/.test(s);
}

// ---- SSRF guard for OUTBOUND requests (webhooks, notification channels) ----
// This is a homelab proxy, so private LAN targets are legitimate (a self-hosted
// gotify/ntfy on 192.168.x). The genuinely dangerous target with no legitimate
// use is the cloud-metadata / link-local range and the unspecified address.
const LINK_LOCAL_V4 = /^169\.254\./;          // includes 169.254.169.254 (cloud metadata)
const UNSPEC_V4 = /^0\./;

export function isDangerousHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "metadata.google.internal") return true;
  if (LINK_LOCAL_V4.test(h) || UNSPEC_V4.test(h)) return true;
  if (h === "fe80::" || h.startsWith("fe80:") || h === "::" ) return true; // IPv6 link-local / unspecified
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
