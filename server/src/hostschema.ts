import { isIP } from "node:net";
import { hostname as osHostname, networkInterfaces } from "node:os";
import { z } from "zod";
import { getSettings } from "./db.ts";
import { INSTANCE_ID } from "./instance.ts";
import { PRESETS } from "./presets.ts";
import { parseRealms, realmForHost } from "./realms.ts";
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

/** One "Header-Name: value" line safe for an nginx double-quoted add_header.
 *  CR/LF/quote/backslash can break the generated directive. `$` is equally
 *  security-sensitive: nginx expands variables inside quotes, so an editor-set
 *  value such as `$http_cookie` would reflect the HttpOnly NginUX session into a
 *  browser-readable response header. Dynamic/raw directives belong in the
 *  admin-only customNginx escape hatch, never this editor-writable field. */
export function isCustomHeaderLine(line: string): boolean {
  const i = line.indexOf(":");
  // eslint-disable-next-line no-control-regex
  return i > 0 && isHeaderName(line.slice(0, i).trim()) && !/[\n\r"\\$]/.test(line.slice(i + 1)) && !/[\x00-\x1f\x7f\u2028\u2029]/.test(line);
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

/** certDomain becomes a cert-dir path segment: it must be a hostname or a
 *  `*.wildcard` (the same shape every stored certificate directory has), which
 *  rules out traversal and the bare `.`, `*`, `-` names that resolved to the
 *  CERT_DIR root or to no directory at all. */
export const validCertDomain = (s: string): boolean => s === "" || (s.length <= 253 && isHostname(s));

/** Raw nginx directives may never carry block braces (would break out of the
 *  location block). Admin-only is enforced at the route, not here. */
export const validCustomNginx = (s: string): boolean => !/[{}]/.test(s);

/** A service name safe to reflect into config comments + the maintenance page. */
export const validName = (s: string): boolean => !hasNginxMetachars(s);

/** iconUrl is rendered as an <img src>: only a pinned CDN or an uploaded data: image. */
export const validIconUrl = (s: string): boolean =>
  s === "" || /^https:\/\/cdn\.jsdelivr\.net\//.test(s) || /^data:image\//.test(s);

/** A preset id must be an OWN key of the preset table. `PRESETS["__proto__"]` /
 *  `"constructor"` are truthy inherited values whose `extraDirectives` is undefined,
 *  so one such host made `generateHostConfig` - and therefore every later
 *  applyConfig() for every host - throw. (Security audit 2026-10-01.) */
export const validPreset = (s: string): boolean => Object.hasOwn(PRESETS, s);

// ---- zod field builders (thin wrappers so REST error messages stay put) ----
// Length caps on the free-text/list fields — every one reaches the generated nginx
// config verbatim and every applyConfig() then runs `nginx -t` + reload over it. Without
// a cap a single write could be ~2 MB (the global bodyLimit), bloating the config on
// every reload. (Security audit 2026-07-12.)
const ipListField = z.string().max(4096).default("").refine(validIpList, "IP allow/deny entries must be valid IPv4/IPv6 addresses or CIDRs.");
const customHeadersField = z.string().max(8192).default("").refine(validCustomHeaders, 'Custom headers must be "Header-Name: value" per line (no quotes, backslashes, or nginx variables).');
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
  upstreamTlsVerify: z.boolean().default(true),
  preset: z.string().max(64).default("custom").refine(validPreset, "Unknown preset."),
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

/** L7 HTTP/gRPC hosts can enforce auth_request, mTLS termination, headers,
 * country policy, and request/connection limits. Raw TCP/UDP/SNI passthrough
 * cannot; accepting those flags would make the API/UI claim protection that the
 * generated stream config never applies. */
export function protocolSupportsHttpControls(protocol: string): boolean {
  return protocol === "http" || protocol === "grpc";
}

const STREAM_UNSUPPORTED: Array<[keyof HostInput, string, (h: HostInput) => boolean]> = [
  ["websockets", "WebSockets", (h) => h.websockets],
  ["requireLogin", "NginUX login", (h) => h.requireLogin],
  ["require2fa", "two-factor login", (h) => h.require2fa],
  ["countryLock", "country lock", (h) => h.countryLock],
  ["maintenanceMode", "HTTP maintenance page", (h) => h.maintenanceMode],
  ["hsts", "HSTS", (h) => h.hsts],
  ["rateLimit", "HTTP request rate limit", (h) => h.rateLimit],
  ["ipAllow", "per-service IP allow list", (h) => !!h.ipAllow.trim()],
  ["ipDeny", "per-service IP deny list", (h) => !!h.ipDeny.trim()],
  ["customHeaders", "custom response headers", (h) => !!h.customHeaders.trim()],
  ["customNginx", "HTTP custom directives", (h) => !!h.customNginx?.trim()],
  ["pathRules", "per-path routing", (h) => !!h.pathRules.trim()],
  ["mtls", "mTLS termination", (h) => h.mtls],
  ["rateLimitKbps", "HTTP bandwidth limit", (h) => h.rateLimitKbps > 0],
  ["maxConns", "HTTP per-client connection limit", (h) => h.maxConns > 0],
  ["certDomain", "managed certificate selection", (h) => !!h.certDomain.trim()],
];

import type { Settings } from "./types.ts";

export type PortalSettingsView = Pick<Settings, "ssoLoginUrl" | "ssoCookieDomain" | "ssoRealms">;

const STREAM_PROTOS = new Set(["tcp", "udp", "sni"]);

/** Every TCP port the control plane may answer on: the Fastify listener (PORT)
 *  plus whatever NGINUX_CONTROL_URL points at when an operator remapped it. */
export function controlPlanePorts(): Set<number> {
  const ports = new Set<number>([Number(process.env.PORT) || 6767]);
  try {
    const u = new URL(process.env.NGINUX_CONTROL_URL ?? "http://127.0.0.1:6767");
    ports.add(Number(u.port || (u.protocol === "https:" ? 443 : 80)));
  } catch { /* invalid deployment configuration - the PORT default still applies */ }
  return ports;
}

/** TCP ports nginx or the control plane already own inside the container. A stream
 *  `listen` on one of these passes `nginx -t` (the test never binds) but the reload
 *  fails to bind and - worse - on the next container start nginx grabs 6767 before
 *  Node does (crash loop) or refuses to start at all (443). UDP does not collide
 *  with these TCP listeners, so it is exempt. (Security audit 2026-10-01.) */
export function reservedStreamPorts(): Set<number> {
  return new Set<number>([80, 443, ...controlPlanePorts()]);
}

/** Stream/SNI hosts need a real listen port (1-65535) that is not one of NginUX's
 *  own TCP listeners, and tcp/udp ports must be unique. SNI hosts may share a port
 *  (multiplexed by server name). Returns an error string or null. */
export function streamPortConflictError(
  h: { protocol: string; listenPort: number; name?: string },
  peers: Array<{ id?: string; protocol: string; listenPort: number; name: string }>,
  excludeId?: string,
): string | null {
  if (!STREAM_PROTOS.has(h.protocol)) return null;
  if (!Number.isInteger(h.listenPort) || h.listenPort < 1 || h.listenPort > 65535) {
    return "TCP / UDP / SNI services need a listen port between 1 and 65535.";
  }
  if (h.protocol !== "udp" && reservedStreamPorts().has(h.listenPort)) {
    return `Listen port ${h.listenPort} is reserved for NginUX itself (HTTP 80/443 and the control plane). Pick a different port.`;
  }
  for (const o of peers) {
    if ((excludeId && o.id === excludeId) || !STREAM_PROTOS.has(o.protocol) || o.listenPort !== h.listenPort) continue;
    if (h.protocol === "sni" && o.protocol === "sni") continue; // SNI passthrough multiplexes by host
    return `Listen port ${h.listenPort} is already used by "${o.name}". Pick a different port.`;
  }
  return null;
}

/** Return a clear error when a stream service is carrying an active HTTP-only
 * control. Default-on HTTP presentation fields are normalized separately, so a
 * normal API create of a TCP service does not have to countermand HTTP defaults. */
export function protocolCapabilityError(host: HostInput, settingsOverride?: PortalSettingsView): string | null {
  if (protocolSupportsHttpControls(host.protocol)) return null;
  const active = STREAM_UNSUPPORTED.filter(([, , on]) => on(host)).map(([, label]) => label);
  if (active.length) {
    return `${host.protocol.toUpperCase()} passthrough cannot enforce ${active.join(", ")}. Clear those HTTP-only controls or use HTTP/gRPC so NginUX can enforce them.`;
  }
  if (streamSharesSessionCookie(host, settingsOverride)) {
    return `${host.protocol.toUpperCase()} passthrough cannot use a hostname inside the shared NginUX cookie domain: the browser would send the admin session directly to the passthrough backend. Use a separate base domain or HTTP/gRPC termination.`;
  }
  return null;
}

/** A Domain-scoped session cookie bypasses nginx's HTTP cookie stripping on raw
 * passthrough: the browser sends it straight through to the backend that
 * terminates/handles the connection. Fail closed for stream hostnames inside the
 * effective global or per-realm cookie domain. */
export function streamSharesSessionCookie(
  host: Pick<HostInput, "protocol" | "domain">,
  settingsOverride?: PortalSettingsView,
): boolean {
  if (protocolSupportsHttpControls(host.protocol)) return false;
  const settings = settingsOverride ?? getSettings();
  const realm = realmForHost(host.domain, parseRealms(settings.ssoRealms));
  let cookieDomain = realm?.cookieDomain ?? settings.ssoCookieDomain;
  if (!cookieDomain && settings.ssoLoginUrl) {
    try {
      const parts = new URL(settings.ssoLoginUrl).hostname.split(".");
      if (parts.length >= 2) cookieDomain = "." + parts.slice(parts.length > 2 ? 1 : 0).join(".");
    } catch { /* invalid/empty setting has no shared cookie */ }
  }
  const base = (cookieDomain || "").replace(/^\./, "").toLowerCase();
  const domain = host.domain.replace(/^\*\./, "").replace(/\.$/, "").toLowerCase();
  return !!base && (domain === base || domain.endsWith(`.${base}`));
}

/** Persist stream hosts with an honest representation: fields ignored by the
 * stream generator are cleared instead of remaining "true" in the API and UI.
 * Call protocolCapabilityError first so explicitly requested access controls are
 * rejected rather than silently weakened. */
export function normalizeProtocolFields<T extends HostInput>(host: T): T {
  if (protocolSupportsHttpControls(host.protocol)) return host;
  return {
    ...host,
    websockets: false,
    http2: false,
    ssl: false,
    upstreamTlsVerify: false,
    requireLogin: false,
    require2fa: false,
    countryLock: false,
    certDomain: "",
    maintenanceMode: false,
    securityHeaders: false,
    hsts: false,
    rateLimit: false,
    blockExploits: false,
    ipAllow: "",
    ipDeny: "",
    customHeaders: "",
    customNginx: "",
    pathRules: "",
    mtls: false,
    rateLimitKbps: 0,
    maxConns: 0,
  } as T;
}

function normalizedHost(host: string): string {
  return host.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

/** True when `domain` is one of the configured public NginUX login portals.
 *
 * A NAS deployment often stores its LAN address as the managed service's
 * forward target even though nginx and the control plane live in this same
 * container. The generator uses this public-domain identity to route that
 * service directly to NGINUX_CONTROL_URL, so it can keep the session cookie
 * without ever trusting or leaking it to the user-entered upstream. */
export function isControlPlanePortalDomain(
  domain: string,
  settingsOverride?: Pick<Settings, "ssoLoginUrl" | "ssoRealms">,
): boolean {
  const settings = settingsOverride ?? getSettings();
  const urls = [
    settings.ssoLoginUrl,
    ...parseRealms(settings.ssoRealms).map((realm) => realm.loginUrl),
  ];
  const wanted = normalizedHost(domain);
  return urls.some((raw) => {
    if (!raw?.trim()) return false;
    try {
      const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
      return normalizedHost(url.hostname) === wanted;
    } catch {
      return false;
    }
  });
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
  settingsOverride?: Pick<Settings, "ssoLoginUrl" | "ssoRealms">,
): boolean {
  if (!isControlPlanePortalDomain(domain, settingsOverride)) return false;
  return !isControlPlaneTarget(forwardHost, forwardPort, forwardScheme);
}

// ---------------------------------------------------------------------------
// Control-plane self-exposure guard (security audit 2026-10-01).
//
// isControlPlaneDomain above protects the PORTAL DOMAIN from being repointed. It
// never protected the CONTROL-PLANE TARGET: an editor (or a control-scope agent)
// could publish `evil.example.com -> 127.0.0.1:6767` as an HTTP host - which the
// generator then treats as a portal and proxies WITH the session cookie - or as a
// raw TCP/UDP/SNI stream, exposing the LAN-only admin UI and API on the internet
// without TLS. Because that traffic reaches Fastify from loopback, the proxy-trust
// rule would also believe any X-Forwarded-For the internet client supplied.
// ---------------------------------------------------------------------------

/** Canonical IP for `host` when it is an IP literal in any spelling (`127.1`,
 *  `0x7f.1`, `2130706433`, `[::1]`), else the lower-cased hostname. */
function canonicalAddress(host: string): string {
  const h = normalizedHost(host);
  try {
    return new URL(`http://${isIP(h) === 6 ? `[${h}]` : h}/`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return h;
  }
}

/** Does `host` name THIS machine - loopback in every spelling, the unspecified
 *  address, `localhost` (and `*.localhost`), the container's own hostname, or an
 *  address currently bound on a local interface? Those are the addresses through
 *  which the bundled nginx can reach the control plane. */
export function isLocalAddress(host: string): boolean {
  const h = canonicalAddress(host);
  if (!h) return false;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === osHostname().toLowerCase()) return true;
  if (/^127\./.test(h) || h === "0.0.0.0" || h === "::" || h === "::1") return true;
  // IPv4-mapped loopback: ::ffff:127.0.0.1 / ::ffff:7f00:1 (URL canonicalises to the hex form).
  const mapped = h.match(/^::ffff:(?:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})|([0-9a-f]{1,4}):[0-9a-f]{1,4})$/);
  if (mapped) return mapped[1] ? /^127\./.test(mapped[1]) : (parseInt(mapped[2], 16) >> 8) === 127;
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.address.toLowerCase() === h) return true;
  }
  return false;
}

/** Is `host:port` an address at which the NginUX control plane answers? Exact
 *  NGINUX_CONTROL_URL match (any scheme) OR a local address on a control-plane port. */
export function isControlPlaneAddress(host: string, port: number): boolean {
  if (isControlPlaneTarget(host, port, "http") || isControlPlaneTarget(host, port, "https")) return true;
  return controlPlanePorts().has(port) && isLocalAddress(host);
}

/** Does this STORED host front the control plane - the sign-in portal domain, or
 *  an (admin-created) forward to the control-plane address? Such a host is admin
 *  territory for edits, pause / maintenance and delete on every write path: a
 *  non-admin who could disable or delete the portal would lock every remote admin
 *  out of NginUX, and one who could add response headers to it could open the
 *  admin origin cross-site. Shared by REST and the agent tools. */
export function frontsControlPlane(h: { domain: string; forwardHost: string; forwardPort: number }): boolean {
  return isControlPlanePortalDomain(h.domain) || isControlPlaneAddress(h.forwardHost, h.forwardPort);
}

function splitHostPort(target: string): { host: string; port: number } | null {
  const t = target.replace(/^https?:\/\//, "");
  const colon = t.lastIndexOf(":");
  if (colon <= 0) return null;
  return { host: t.slice(0, colon), port: Number(t.slice(colon + 1)) };
}

export type ControlPlaneTargetHost = Pick<HostInput, "protocol" | "forwardHost" | "forwardPort"> & Partial<Pick<HostInput, "upstreams" | "pathRules">>;

/** Reject a host write that would publish the control plane on the data plane.
 *  - Stream (tcp/udp/sni) passthrough to the control plane is refused for everyone:
 *    it is plain-TCP exposure of the admin UI with no login gate and no TLS.
 *  - An HTTP/gRPC primary target on the control plane is ADMIN-ONLY. Admins need it
 *    for the documented portal flow (`nginux.example.com -> 127.0.0.1:6767`, which
 *    the generator pins to NGINUX_CONTROL_URL and serves with the session cookie).
 *  - Load-balancer `upstreams` and `pathRules` targets may never be the control
 *    plane: a pool would spray the session cookie across targets and a path route
 *    would expose the API under another service's hostname.
 *  Returns an error string or null. Shared by REST, agent tools, restore and import. */
export function controlPlaneTargetError(h: ControlPlaneTargetHost, opts: { admin: boolean }): string | null {
  if (isControlPlaneAddress(h.forwardHost, h.forwardPort)) {
    if (!protocolSupportsHttpControls(h.protocol)) {
      return `${h.protocol.toUpperCase()} passthrough may not target the NginUX control plane: it would publish the admin UI and API on the internet without the login gate or TLS.`;
    }
    if (!opts.admin) {
      return "Only an admin may forward a service to the NginUX control plane (that publishes the admin UI). Ask an admin to set up the sign-in portal from Settings → public URL.";
    }
  }
  for (const line of splitLines(h.upstreams ?? "")) {
    const hp = splitHostPort(line);
    if (hp && isControlPlaneAddress(hp.host, hp.port)) return "Load-balancer upstream targets may not include the NginUX control plane.";
  }
  for (const line of splitLines(h.pathRules ?? "")) {
    const target = line.split(/\s+/)[1];
    const hp = target ? splitHostPort(target) : null;
    if (hp && isControlPlaneAddress(hp.host, hp.port)) return "Path rules may not route to the NginUX control plane.";
  }
  return null;
}

/** Best-effort live check for the case the static rules cannot see: the control
 *  plane reached through the Docker host's LAN address or a remapped published port
 *  (`-p 8443:6767`). Fetches `/api/health` from the proposed upstream and compares
 *  the per-boot INSTANCE_ID. Fails OPEN on any network error or timeout (this is
 *  defence in depth behind controlPlaneTargetError, not the primary control), and
 *  is only run for non-admin writers whose routing actually changed. */
export async function targetIsThisControlPlane(
  h: Pick<HostInput, "forwardHost" | "forwardPort" | "forwardScheme">,
  timeoutMs = 1500,
): Promise<boolean> {
  if (isDangerousHost(h.forwardHost)) return false; // never probe metadata / link-local
  const hostPart = isIP(normalizedHost(h.forwardHost)) === 6 ? `[${normalizedHost(h.forwardHost)}]` : h.forwardHost;
  try {
    const res = await fetch(`${h.forwardScheme}://${hostPart}:${h.forwardPort}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
      headers: { accept: "application/json" },
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { instance?: unknown };
    return body?.instance === INSTANCE_ID;
  } catch {
    return false;
  }
}

/** Run targetIsThisControlPlane over the primary target AND every load-balancer /
 *  path-rule target of a proposed host (distinct, capped at 8, in parallel), so a
 *  non-admin cannot publish the admin API under a path prefix or pool member either.
 *  The static controlPlaneTargetError must run first; this is the live backstop.
 *  `NGINUX_SELF_PROBE=0` disables only this network step (the unit-test env sets
 *  it: the fixture upstreams are unroutable and would each cost the full timeout). */
export async function publishesThisControlPlane(
  h: ControlPlaneTargetHost & Pick<HostInput, "forwardScheme">,
  timeoutMs = 1500,
): Promise<boolean> {
  if (/^(0|off|false|no)$/i.test(process.env.NGINUX_SELF_PROBE ?? "")) return false;
  const targets: Array<Pick<HostInput, "forwardHost" | "forwardPort" | "forwardScheme">> = [
    { forwardHost: h.forwardHost, forwardPort: h.forwardPort, forwardScheme: h.forwardScheme },
  ];
  for (const line of splitLines(h.upstreams ?? "")) {
    const hp = splitHostPort(line);
    if (hp) targets.push({ forwardHost: hp.host, forwardPort: hp.port, forwardScheme: h.forwardScheme });
  }
  for (const line of splitLines(h.pathRules ?? "")) {
    const t = line.split(/\s+/)[1];
    const hp = t ? splitHostPort(t) : null;
    if (hp) targets.push({ forwardHost: hp.host, forwardPort: hp.port, forwardScheme: /^https:\/\//.test(t) ? "https" : "http" });
  }
  const seen = new Set<string>();
  const distinct = targets.filter((t) => {
    const key = `${t.forwardScheme}://${t.forwardHost}:${t.forwardPort}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
  const hits = await Promise.all(distinct.map((t) => targetIsThisControlPlane(t, timeoutMs)));
  return hits.some(Boolean);
}
