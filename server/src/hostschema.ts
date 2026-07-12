import { z } from "zod";
import { getSettings } from "./db.ts";
import {
  hasNginxMetachars, isHeaderName, isHost, isHostname, isHostPort,
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
  return rest.length === 0 && isLocationPath(p) && isHostPort(t);
}
export const validPathRules = (s: string): boolean => splitLines(s).every(isPathRuleLine);

/** Extra upstream targets, "host:port" per line. */
export const validUpstreams = (s: string): boolean => splitLines(s).every(isHostPort);

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
const ipListField = z.string().default("").refine(validIpList, "IP allow/deny entries must be valid IPv4/IPv6 addresses or CIDRs.");
const customHeadersField = z.string().default("").refine(validCustomHeaders, 'Custom headers must be "Header-Name: value" per line (no quotes).');
const pathRulesField = z.string().default("").refine(validPathRules, 'Path rules must be "/path host:port" per line.');
const upstreamsField = z.string().default("").refine(validUpstreams, 'Upstream targets must be "host:port" per line.');
const customNginxField = z.string().default("").refine(validCustomNginx, "Custom nginx directives may not contain { or }.");

export const hostInput = z.object({
  name: z.string().min(1).max(100).refine(validName, "Name may not contain ; { } or line breaks."),
  iconUrl: z.string().max(4096).refine(validIconUrl, "Icon must be a dashboard-icons URL or an uploaded image.").default(""),
  domain: z.string().min(1).max(253).refine(isHostname, "Invalid domain/hostname."),
  forwardScheme: z.enum(["http", "https"]).default("http"),
  forwardHost: z.string().min(1).refine(isHost, "Invalid forward host (must be a hostname or IP)."),
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
});

export type HostInput = z.infer<typeof hostInput>;

/** Would putting `domain` on the control plane away from :6767 lose access to
 *  NginUX? The NginUX public URL (Settings → Instance) doubles as the SSO
 *  sign-in URL; a host on that domain that does NOT forward to the control-plane
 *  port would break the sign-in portal. Forwarding TO :6767 is the allowed setup.
 *  ONE definition shared by the REST create/update guards and the agent path. */
export function isControlPlaneDomain(domain: string, forwardPort?: number): boolean {
  const raw = getSettings().ssoLoginUrl?.trim();
  if (!raw) return false;
  let h: string;
  try {
    h = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch { return false; }
  if (h !== domain.toLowerCase()) return false;
  const controlPort = Number(process.env.PORT ?? 6767);
  return forwardPort !== controlPort; // allowed when it points at the control plane
}
