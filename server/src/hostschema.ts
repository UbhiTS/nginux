import { z } from "zod";
import { getSettings } from "./db.ts";
import {
  hasNginxMetachars, isDangerousHost, isHeaderName, isHost, isHostname, isHostPort,
  isIpOrCidr, isLocationPath, splitEntries, splitLines,
} from "./validate.ts";

// ---------------------------------------------------------------------------
// SINGLE SOURCE OF TRUTH for host-write validation.
//
// Both the REST boundary (index.ts, via `hostInput`) and the agent/MCP tool
// path (tools.ts, via `hostInput.partial()` + the field predicates below) run
// through THIS module, so the two can no longer drift - a field rule added here
// applies to every write path at once. Every predicate that emits a value into
// generated nginx config (or onto the filesystem) is a config-injection /
// traversal boundary, not cosmetic.
// ---------------------------------------------------------------------------

// ---- per-line / per-field predicates (shared by the zod schema AND the agent path) ----

/** One "Header-Name: value" line: a token name and a value with no CR/LF or `"`
 *  (either would let the value close the quoted add_header string / split the
 *  response and inject a directive). */
export function isCustomHeaderLine(line: string): boolean {
  const i = line.indexOf(":");
  return i > 0 && isHeaderName(line.slice(0, i).trim()) && !/[\n\r"]/.test(line.slice(i + 1));
}
export const validCustomHeaders = (s: string): boolean => splitLines(s).every(isCustomHeaderLine);

/** One "/path host:port" line - both parts strictly validated (config sink). */
export function isPathRuleLine(line: string): boolean {
  const [p, t, ...rest] = line.split(/\s+/);
  return rest.length === 0 && isLocationPath(p) && safeHostPort(t);
}
export const validPathRules = (s: string): boolean => splitLines(s).every(isPathRuleLine);

/** Extra upstream targets, "host:port" per line. */
function safeHostPort(value: string): boolean {
  if (!isHostPort(value)) return false;
  const colon = value.lastIndexOf(":");
  return colon > 0 && !isDangerousHost(value.slice(0, colon));
}
export const validUpstreams = (s: string): boolean => splitLines(s).every(safeHostPort);

/** Each IP allow/deny entry is a valid IP or CIDR. */
export const validIpList = (s: string): boolean => splitEntries(s).every(isIpOrCidr);

/** certDomain becomes a cert-dir path segment: safe charset, no traversal. */
export const validCertDomain = (s: string): boolean =>
  s === "" || (/^[a-z0-9.*_-]+$/i.test(s) && !s.includes(".."));

/** Raw nginx directives may never carry block braces (would break out of the
 *  location block). Admin-only is enforced at the route, not here. */
export const validCustomNginx = (s: string): boolean => !/[{}]/.test(s);

/** A service name safe to reflect into config comments + the maintenance page. */
export const validName = (s: string): boolean => !hasNginxMetachars(s);

/** iconUrl is rendered as an <img src>: only a pinned CDN or an uploaded data: image. */
export const validIconUrl = (s: string): boolean =>
  s === "" || /^https:\/\/cdn\.jsdelivr\.net\//.test(s) || /^data:image\//.test(s);

// ---- zod field builders (thin wrappers so REST error messages stay put) ----
// Length caps on the free-text/list fields — every one reaches the generated nginx
// config verbatim and every applyConfig() then runs `nginx -t` + reload over it. Without
// a cap a single write could be ~2 MB (the global bodyLimit), bloating the config on
// every reload. (Security audit 2026-07-12.)
const ipListField = z.string().max(4096).default("").refine(validIpList, "IP allow/deny entries must be valid IPv4/IPv6 addresses or CIDRs.");
const customHeadersField = z.string().max(8192).default("").refine(validCustomHeaders, 'Custom headers must be "Header-Name: value" per line (no quotes).');
const pathRulesField = z.string().max(8192).default("").refine(validPathRules, 'Path rules must be "/path host:port" per line.');
const upstreamsField = z.string().max(8192).default("").refine(validUpstreams, 'Upstream targets must be "host:port" per line.');
const customNginxField = z.string().max(8192).default("").refine(validCustomNginx, "Custom nginx directives may not contain { or }.");

export const hostInput = z.object({
  name: z.string().min(1).max(100).refine(validName, "Name may not contain ; { } or line breaks."),
  iconUrl: z.string().max(4096).refine(validIconUrl, "Icon must be a dashboard-icons URL or an uploaded image.").default(""),
  domain: z.string().min(1).max(253).refine(isHostname, "Invalid domain/hostname."),
  forwardScheme: z.enum(["http", "https"]).default("http"),
  forwardHost: z.string().min(1).max(253)
    .refine(isHost, "Invalid forward host (must be a hostname or IP).")
    .refine((s) => !isDangerousHost(s), "Cloud metadata, link-local, and unspecified proxy targets are not allowed."),
  forwardPort: z.number().int().min(1).max(65535),
  preset: z.string().max(64).default("custom"),
  websockets: z.boolean().default(false),
  http2: z.boolean().default(true),
  ssl: z.boolean().default(true),
  requireLogin: z.boolean().default(false),
  require2fa: z.boolean().default(false),
  countryLock: z.boolean().default(false),
  serverGroup: z.string().max(64).default("default"),
  serverIp: z.string().max(64).default("").refine((s) => s === "" || isHost(s), "Invalid server IP."),
  enabled: z.boolean().default(true),
  // Which certificate to serve (empty = per-domain). Used as a cert-dir path
  // segment, so constrain to a safe charset and forbid traversal.
  certDomain: z.string().max(253).default("").refine(validCertDomain, "Invalid certificate selection."),
  maintenanceMode: z.boolean().default(false),
  securityHeaders: z.boolean().default(true),
  hsts: z.boolean().default(false),
  rateLimit: z.boolean().default(false),
  rateLimitRps: z.number().int().min(1).max(10000).default(10),
  rateLimitBurst: z.number().int().min(0).max(100000).default(20),
  blockExploits: z.boolean().default(true), // secure-by-default for new services
  ipAllow: ipListField,
  ipDeny: ipListField,
  customHeaders: customHeadersField,
  customNginx: customNginxField,
  upstreams: upstreamsField,
  lbMethod: z.enum(["round_robin", "least_conn", "ip_hash"]).default("round_robin"),
  protocol: z.enum(["http", "tcp", "udp", "grpc", "sni"]).default("http"),
  listenPort: z.number().int().min(0).max(65535).default(0),
  pathRules: pathRulesField,
  mtls: z.boolean().default(false),
  rateLimitKbps: z.number().int().min(0).max(1_000_000).default(0),
  maxConns: z.number().int().min(0).max(100_000).default(0),
  healthCheckType: z.enum(["tcp", "http"]).default("tcp"),
  // Only used for the server's own uptime probe (not emitted into nginx config).
  healthCheckPath: z.string().max(512).default("/").refine((s) => s === "" || /^\/[A-Za-z0-9/_.~%?=&:@!$'()*+,;-]*$/.test(s), "Health-check path must start with / and be a valid URL path."),
  healthCheckStatus: z.number().int().min(0).max(599).default(0),
});

export type HostInput = z.infer<typeof hostInput>;

function normalizedHost(host: string): string {
  return host.replace(/^\[|\]$/g, "").toLowerCase();
}

/** The one exact upstream target that may receive the NginUX session cookie. */
export function isControlPlaneTarget(
  forwardHost: string,
  forwardPort: number,
  forwardScheme: "http" | "https" = "http",
): boolean {
  try {
    const u = new URL(process.env.NGINUX_CONTROL_URL ?? "http://127.0.0.1:6767");
    const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    return u.protocol === `${forwardScheme}:`
      && normalizedHost(u.hostname) === normalizedHost(forwardHost)
      && port === forwardPort;
  } catch {
    return false; // invalid deployment configuration fails closed
  }
}

/** Would this service claim the public portal while forwarding somewhere other
 * than the exact control-plane target? Shared by REST and agent write paths. */
export function isControlPlaneDomain(
  domain: string,
  forwardHost: string,
  forwardPort: number,
  forwardScheme: "http" | "https" = "http",
): boolean {
  const raw = getSettings().ssoLoginUrl?.trim();
  if (!raw) return false;
  let h: string;
  try {
    h = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch { return false; }
  if (h !== domain.toLowerCase()) return false;
  return !isControlPlaneTarget(forwardHost, forwardPort, forwardScheme);
}
