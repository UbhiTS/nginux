import { connect } from "node:net";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { closeDb, dbOk, getSettings, pruneAuditLog, redactSettings, saveSettings, seedIfEmpty } from "./db.ts";
import { PRESETS, getPreset } from "./presets.ts";
import {
  createHost,
  deleteHost,
  getHost,
  getHostByDomain,
  getHostByDomainCached,
  getTopology,
  listHosts,
  updateHost,
} from "./repo.ts";
import { applyConfig, generateHostConfig, generateStreamConfig } from "./nginx.ts";
import { buildNotifications } from "./notifications.ts";
import { deleteGeoipDb, downloadGeoipDb, geoipStatus, writeGeoipConf } from "./geoip.ts";
import {
  adminSetPassword,
  beginTwofaSetup,
  changePassword,
  checkCredentials,
  clearCookie,
  cookieSecure,
  createSession,
  createUser,
  deleteUser,
  destroySession,
  enableTwofa,
  getLastTotpCounter,
  getTwofaSecret,
  getUserById,
  listEvents,
  listSessions,
  listUsers,
  logEvent,
  parseCookie,
  seedAuthIfEmpty,
  securityExposure,
  securityOverview,
  setLastTotpCounter,
  useBackupCode,
  SESSION_COOKIE,
  sessionCookie,
  userForSession,
  type Role,
  type User,
} from "./auth.ts";
import type { ProxyHost } from "./types.ts";
import { otpauthURL, verifyTotp, verifyTotpCounter } from "./totp.ts";
import { VERSION } from "./version.ts";
import {
  AcmeError,
  deleteCert,
  ensureCert,
  getCert,
  getCertDetails,
  importCertFiles,
  issue,
  listCerts,
  reconcileImportedCerts,
  setAutoRenew,
  startRenewalScheduler,
  type CertMethod,
} from "./certs.ts";
import {
  bearerFrom,
  createToken,
  listTokens,
  resolveToken,
  revokeToken,
  seedTokensIfEmpty,
} from "./tokens.ts";
import { callTool, decideApproval, listApprovals, scopesForRole, toolCatalog, type Principal } from "./tools.ts";
import { createWebhook, deleteWebhook, listWebhooks, subscribe } from "./events.ts";
import { handleMcp } from "./mcp.ts";
import {
  prometheus,
  recentLogs,
  hostStats,
  hostTraffic,
  startDemoTraffic,
  startLogTailer,
  subscribeLog,
  summary as metricsSummary,
  trafficSeries,
} from "./metrics.ts";
import { getUptime, startUptimeMonitor } from "./uptime.ts";
import { diffVersion, listVersions, restoreVersion, snapshot } from "./versioning.ts";
import { gitLog, syncGitOps } from "./gitops.ts";
import { importNginxConf } from "./importer.ts";
import { addBan, listBans, removeBan, startBanEngine } from "./bans.ts";
import { ensureClientCA, issueClientCert, listClientCerts, revokeClientCert, writeClientCrl } from "./clientcerts.ts";
import { generateSniPassthrough } from "./nginx.ts";
import {
  assertSafeOutboundUrl,
  hasNginxMetachars,
  isDangerousHost,
  isHeaderName,
  isHost,
  isHostPort,
  isHostname,
  isIpOrCidr,
  isLocationPath,
} from "./validate.ts";
import {
  createChannel,
  deleteChannel,
  initAlertEngine,
  listChannels,
  setChannelEnabled,
  testChannel,
  type ChannelType,
} from "./notify.ts";
import type { FastifyReply, FastifyRequest } from "fastify";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4600);
const HOST = process.env.HOST ?? "0.0.0.0";

seedIfEmpty();
const seeded = await seedAuthIfEmpty();
seedTokensIfEmpty();
writeGeoipConf(); // keep the country-lock include in sync with settings on boot
reconcileImportedCerts(); // pick up any cert files dropped into /data/certs (migrations)

const currentUser = (req: FastifyRequest): User | null =>
  userForSession(parseCookie(req.headers.cookie)[SESSION_COOKIE]);
/** Resolve the caller to a user (session) or agent (bearer token). A user's tool
 *  scopes come from their role so the MCP/agent path enforces the same RBAC as
 *  REST (a readonly/scoped user can't run control/security tools). */
const principal = (req: FastifyRequest): Principal | null => {
  const u = currentUser(req);
  if (u) return { kind: "user", name: u.username, scopes: scopesForRole(u.role), user: u };
  return resolveToken(bearerFrom(req.headers.authorization));
};
// Only believe X-Forwarded-For from a trusted hop. NGINUX_TRUST_PROXY=true trusts
// XFF *only from loopback* — the bundled nginx forwards auth subrequests from
// 127.0.0.1, so we get real client IPs there, while a browser hitting :4600
// directly (a non-loopback peer) can't spoof XFF to forge audit IPs / dodge bans.
// Set NGINUX_TRUST_PROXY to a specific IP/CIDR when fronting :4600 with your own
// reverse proxy. Anything falsy = never trust XFF.
const TRUST_PROXY: boolean | string | ((addr: string, hop: number) => boolean) =
  process.env.NGINUX_TRUST_PROXY === "1" || process.env.NGINUX_TRUST_PROXY === "true"
    ? (addr: string) => addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1"
    : (process.env.NGINUX_TRUST_PROXY || false);
const clientIp = (req: FastifyRequest) => req.ip; // resolved by Fastify per trustProxy
const device = (req: FastifyRequest) => (req.headers["user-agent"] as string)?.slice(0, 120) || "unknown";

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  trustProxy: TRUST_PROXY,
  bodyLimit: 2 * 1024 * 1024, // 2 MB — generous for config import, bounded for safety
  requestTimeout: 30_000,
});

// Central error handler: bad input → 400 with field detail; everything else is
// logged in full server-side but returns a generic message (no internal leak).
app.setErrorHandler((err, req, reply) => {
  if (err instanceof z.ZodError) {
    return reply.code(400).send({ error: "Invalid input", issues: err.issues });
  }
  const status = (err as { statusCode?: number }).statusCode ?? 500;
  if (status >= 500) {
    req.log.error({ err }, "request failed");
    return reply.code(status).send({ error: "Something went wrong on our end." });
  }
  return reply.code(status).send({ error: (err as Error).message });
});

// Auth guard. Human UI routes need a session; agent routes (MCP + events)
// accept a session OR a Bearer API token (agents never use 2FA).
const OPEN_PATHS = new Set(["/api/health", "/api/auth/login", "/api/auth/forward"]);
// While a user still holds a temporary password, only these endpoints are reachable.
const PW_CHANGE_ALLOWED = new Set(["/api/auth/change-password", "/api/auth/logout", "/api/auth/me"]);
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** CSRF defense: a cookie-authenticated mutation carrying a cross-origin
 *  Origin/Referer is rejected. Browsers always send Origin on cross-site
 *  writes; native clients (no Origin header) and Bearer agents are unaffected. */
function crossOriginBlocked(req: FastifyRequest): boolean {
  if (!MUTATING.has(req.method)) return false;
  const origin = (req.headers.origin as string) || (req.headers.referer as string);
  if (!origin) return false; // non-browser client
  const host = (req.headers["x-forwarded-host"] as string) || req.headers.host;
  try { return new URL(origin).host !== host; } catch { return true; }
}

app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
  if (!req.url.startsWith("/api")) return;
  const path = req.url.split("?")[0];
  if (OPEN_PATHS.has(path)) return;
  // CSRF applies to EVERY mutating cookie request, including /api/mcp — a malicious
  // page must not be able to drive state-changing MCP tools as the logged-in user.
  // Bearer-token agents send no Origin, so they're unaffected.
  if (crossOriginBlocked(req)) return reply.code(403).send({ error: "Cross-origin request blocked." });
  const isAgentPath = path === "/api/mcp" || path.startsWith("/api/events") || path.startsWith("/api/logs") || path === "/api/metrics/prometheus";
  if (isAgentPath) {
    if (!principal(req)) return reply.code(401).send({ error: "Valid session or API token required" });
    // A cookie user with a temporary password is still confined, even via MCP.
    const cu = currentUser(req);
    if (cu?.mustChangePassword && !PW_CHANGE_ALLOWED.has(path)) {
      return reply.code(403).send({ error: "Set a new password before continuing.", mustChangePassword: true });
    }
    return;
  }
  const u = currentUser(req);
  if (!u) return reply.code(401).send({ error: "Authentication required" });
  // A temporary-password account is confined to the change-password flow until it
  // sets a real password — enforced here, not just in the SPA.
  if (u.mustChangePassword && !PW_CHANGE_ALLOWED.has(path)) {
    return reply.code(403).send({ error: "Set a new password before continuing.", mustChangePassword: true });
  }
});

// Security headers on every control-plane response (the admin UI + API on :4600).
// frame-ancestors/X-Frame-Options stop the UI being framed (clickjacking); nosniff
// stops MIME sniffing; the CSP locks script/style/connect to same-origin.
app.addHook("onSend", async (_req, reply, payload) => {
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self'; font-src 'self' data:; connect-src 'self'; object-src 'none'; " +
      "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  return payload;
});

function requireAdmin(req: FastifyRequest, reply: FastifyReply): User | null {
  return requireRole(req, reply, "admin");
}

/** Allow only the listed roles; 403 otherwise. Returns the user when allowed. */
function requireRole(req: FastifyRequest, reply: FastifyReply, ...roles: Role[]): User | null {
  const u = currentUser(req);
  if (!u || !roles.includes(u.role)) {
    reply.code(403).send({ error: `This action requires one of: ${roles.join(", ")}.` });
    return null;
  }
  return u;
}

/** Does a `scoped` user's scope list cover this host? (matches id, name, or domain) */
function scopedAllows(user: User, host: Pick<ProxyHost, "id" | "name" | "domain">): boolean {
  const keys = user.scope.split(/[\s,]+/).map((s) => s.toLowerCase()).filter(Boolean);
  return keys.includes(host.id.toLowerCase()) || keys.includes(host.name.toLowerCase()) || keys.includes(host.domain.toLowerCase());
}

/**
 * Gate a host-mutating request: admin/editor may touch any host; scoped may
 * only touch hosts in their scope and may not create/delete; readonly is denied.
 * Returns the user when allowed, else sends the response and returns null.
 */
function requireHostAccess(
  req: FastifyRequest,
  reply: FastifyReply,
  host: Pick<ProxyHost, "id" | "name" | "domain"> | null,
  opts: { allowScoped?: boolean } = {},
): User | null {
  const u = currentUser(req);
  if (!u) { reply.code(401).send({ error: "Authentication required" }); return null; }
  if (u.role === "admin" || u.role === "editor") return u;
  if (u.role === "scoped" && opts.allowScoped && host && scopedAllows(u, host)) return u;
  reply.code(403).send({ error: "You don't have permission to manage this service." });
  return null;
}

/** customNginx is a raw-directive escape hatch — only admins may set it. */
// Fields a `scoped` user must not set: they manage a service but may not change
// its security posture or routing (which could expose it or repoint it).
const SCOPED_FORBIDDEN_FIELDS = [
  "requireLogin", "require2fa", "mtls", "countryLock", "securityHeaders", "hsts",
  "blockExploits", "ipAllow", "ipDeny", "customHeaders", "pathRules", "upstreams",
] as const;

function rejectPrivilegedFields(req: FastifyRequest, reply: FastifyReply, body: Record<string, unknown>): boolean {
  const role = currentUser(req)?.role;
  // Raw nginx directives are an admin-only escape hatch.
  if (body.customNginx !== undefined && body.customNginx !== "" && role !== "admin") {
    reply.code(403).send({ error: "Only an admin may set custom nginx directives." });
    return false;
  }
  // Scoped users can't touch security/routing fields (e.g. can't strip requireLogin).
  if (role === "scoped") {
    const touched = SCOPED_FORBIDDEN_FIELDS.filter((f) => body[f] !== undefined);
    if (touched.length) {
      reply.code(403).send({ error: `Scoped users can't change security or routing settings (${touched.join(", ")}). Ask an admin.` });
      return false;
    }
  }
  return true;
}

/** May this caller READ this host? Scoped users only within scope; others yes. */
function canReadHost(req: FastifyRequest, host: Pick<ProxyHost, "id" | "name" | "domain">): boolean {
  const u = currentUser(req);
  if (!u) return false;
  return u.role !== "scoped" || scopedAllows(u, host);
}

/** For routes reachable by agent tokens OR users: token principals pass (their
 *  scope is enforced separately); a user session must hold one of `roles`. */
function userRoleAtLeast(req: FastifyRequest, reply: FastifyReply, ...roles: Role[]): boolean {
  const u = currentUser(req);
  if (u && !roles.includes(u.role)) {
    reply.code(403).send({ error: `This action requires one of: ${roles.join(", ")}.` });
    return false;
  }
  return true;
}

// ---------- validation ----------
const splitEntries = (s: string): string[] => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
const splitLines = (s: string): string[] => s.split("\n").map((x) => x.trim()).filter(Boolean);

// Each entry of an IP allow/deny list must be a valid IP or CIDR.
const ipListField = z.string().default("").refine(
  (s) => splitEntries(s).every(isIpOrCidr),
  "IP allow/deny entries must be valid IPv4/IPv6 addresses or CIDRs.",
);
// "Name: value" per line; header name must be a token, value free of CR/LF.
const customHeadersField = z.string().default("").refine(
  (s) => splitLines(s).every((line) => {
    const i = line.indexOf(":");
    // Reject CR/LF (response splitting) AND " (would close the quoted nginx
    // add_header string and inject a directive).
    return i > 0 && isHeaderName(line.slice(0, i).trim()) && !/[\n\r"]/.test(line.slice(i + 1));
  }),
  'Custom headers must be "Header-Name: value" per line (no quotes).',
);
// "/path host:port" per line — both parts strictly validated (config injection sink).
const pathRulesField = z.string().default("").refine(
  (s) => splitLines(s).every((line) => {
    const [p, t, ...rest] = line.split(/\s+/);
    return rest.length === 0 && isLocationPath(p) && isHostPort(t);
  }),
  'Path rules must be "/path host:port" per line.',
);
// Extra upstream targets, "host:port" per line.
const upstreamsField = z.string().default("").refine(
  (s) => splitLines(s).every(isHostPort),
  'Upstream targets must be "host:port" per line.',
);
// Raw nginx directives are admin-only (enforced in the route) and may never
// contain block braces, which would let a value break out of the location block.
const customNginxField = z.string().default("").refine(
  (s) => !/[{}]/.test(s),
  "Custom nginx directives may not contain { or }.",
);

const hostInput = z.object({
  name: z.string().min(1).max(100).refine((s) => !hasNginxMetachars(s), "Name may not contain ; { } or line breaks."),
  emoji: z.string().max(16).refine((s) => !hasNginxMetachars(s), "Invalid emoji.").default("⚙️"),
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
  certDomain: z.string().max(253).default("").refine(
    (s) => s === "" || (/^[a-z0-9.*_-]+$/i.test(s) && !s.includes("..")),
    "Invalid certificate selection.",
  ),
  maintenanceMode: z.boolean().default(false),
  securityHeaders: z.boolean().default(true),
  hsts: z.boolean().default(false),
  rateLimit: z.boolean().default(false),
  blockExploits: z.boolean().default(false),
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

// A domain used as a filesystem path segment (certs) must be a plain hostname.
const domainParam = z.string().min(1).max(253).refine(isHostname, "Invalid domain.");

// ---------- health ----------
app.get("/api/health", async (_req, reply) => {
  const db = dbOk();
  return reply.code(db ? 200 : 503).send({
    status: db ? "ok" : "degraded",
    service: "nginux",
    version: VERSION,
    db,
    time: new Date().toISOString(),
  });
});

// ---------- notifications (actionable heads-up banners) ----------
app.get("/api/notifications", async (req, reply) => {
  const u = currentUser(req);
  if (!u) return reply.code(401).send({ error: "Not signed in" });
  const isManager = u.role === "admin" || u.role === "editor";
  return buildNotifications({ isManager });
});

// ---------- presets ----------
app.get("/api/presets", async () => Object.values(PRESETS));

// ---------- settings ----------
const settingsInput = z.object({
  instanceName: z.string().max(120),
  baseDomain: z.string().max(253),
  publicUrl: z.string().max(512),
  theme: z.enum(["dark", "medium", "light"]),
  letsEncryptEmail: z.string().max(254),
  homeCountry: z.string().max(2),
  publicIp: z.string().max(64),
  gatewayIp: z.string().max(64),
  dnsProvider: z.enum(["none", "godaddy", "cloudflare"]),
  godaddyApiKey: z.string().max(256),
  godaddySecret: z.string().max(256),
  cloudflareApiToken: z.string().max(256),
  maxmindLicenseKey: z.string().max(256),
  acmeStaging: z.boolean(),
  agentAutoApprove: z.boolean(),
  gitOpsEnabled: z.boolean(),
  ssoLoginUrl: z.string().max(512).refine((s) => s === "" || /^https?:\/\/[^\s/]+/i.test(s), "Must be a full URL like https://nginux.example.com."),
  ssoCookieDomain: z.string().max(253).refine((s) => s === "" || /^\.?[a-z0-9.-]+$/i.test(s), "Invalid cookie domain."),
}).partial();

app.get("/api/settings", async (req) => {
  const s = getSettings();
  // Only admins see provider credentials; everyone else gets them masked.
  return currentUser(req)?.role === "admin" ? s : redactSettings(s);
});
app.put("/api/settings", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const parsed = settingsInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  const saved = saveSettings(parsed.data);
  // Changing the allowed country re-derives the geo config; reload to apply it.
  if (parsed.data.homeCountry !== undefined) { writeGeoipConf(); await applyConfig(); }
  return saved;
});

// ---------- hosts ----------
const STREAM_PROTOS = new Set(["tcp", "udp", "sni"]);
/** Stream/SNI hosts need a real listen port, and tcp/udp ports must be unique —
 *  a `listen 0;` or a duplicate listen breaks the whole `stream {}` block (and
 *  can wedge nginx on the next restart, where there's no rollback). SNI hosts may
 *  share a port (they're multiplexed by server name). Returns an error or null. */
function streamPortError(h: { protocol: string; listenPort: number; name?: string }, excludeId?: string): string | null {
  if (!STREAM_PROTOS.has(h.protocol)) return null;
  if (!Number.isInteger(h.listenPort) || h.listenPort < 1 || h.listenPort > 65535) {
    return "TCP / UDP / SNI services need a listen port between 1 and 65535.";
  }
  for (const o of listHosts()) {
    if (o.id === excludeId || !STREAM_PROTOS.has(o.protocol) || o.listenPort !== h.listenPort) continue;
    if (h.protocol === "sni" && o.protocol === "sni") continue; // SNI passthrough multiplexes by host
    return `Listen port ${h.listenPort} is already used by "${o.name}". Pick a different port.`;
  }
  return null;
}
/** A host must not claim the control plane's own public hostname (self-hijack). */
function isControlPlaneDomain(domain: string): boolean {
  const raw = getSettings().publicUrl?.trim();
  if (!raw) return false;
  try {
    const h = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase();
    return h === domain.toLowerCase();
  } catch { return false; }
}

app.get("/api/hosts", async (req) => {
  const u = currentUser(req);
  const hosts = listHosts();
  // Scoped users only see hosts in their scope.
  return u?.role === "scoped" ? hosts.filter((h) => scopedAllows(u, h)) : hosts;
});

app.get("/api/hosts/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const host = getHost(id);
  if (!host || !canReadHost(req, host)) return reply.code(404).send({ error: "Service not found" });
  return host;
});

app.post("/api/hosts", async (req, reply) => {
  if (!requireRole(req, reply, "admin", "editor")) return;
  const parsed = hostInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  if (!rejectPrivilegedFields(req, reply, parsed.data)) return;
  if (getHostByDomain(parsed.data.domain)) {
    return reply.code(409).send({ error: `${parsed.data.domain} is already in use.` });
  }
  if (isControlPlaneDomain(parsed.data.domain)) {
    return reply.code(409).send({ error: "That domain is the NginUX control plane itself — choose another." });
  }
  const spErr = streamPortError(parsed.data);
  if (spErr) return reply.code(400).send({ error: spErr });
  snapshot(`Before exposing ${parsed.data.name}`, currentUser(req)?.username ?? "system");
  const host = createHost(parsed.data);
  // Ensure the host has a cert (self-signed now; upgrade to Let's Encrypt later)
  // so nginx serves it immediately over HTTPS.
  if (host.ssl) {
    try { await ensureCert(host.domain); } catch { /* non-fatal */ }
  }
  const apply = await applyConfig();
  // If nginx rejected the new config, roll the host back out — keeping it would
  // leave a service that breaks nginx on the next restart. Re-apply to restore
  // the last-good state. (nginxAvailable=false means we couldn't validate, so we
  // don't punish the host for a missing nginx binary.)
  if (!apply.ok && apply.nginxAvailable) {
    deleteHost(host.id);
    await applyConfig();
    logEvent({ type: "host.create_failed", severity: "warn", actor: currentUser(req)?.username ?? "system", summary: `Couldn't expose ${host.name} (${host.domain}) — config rejected`, ip: clientIp(req), meta: { error: apply.message } });
    return reply.code(422).send({ error: apply.message, apply });
  }
  void syncGitOps(`Expose ${host.name} (${host.domain})`);
  logEvent({ type: "host.created", severity: "notice", actor: currentUser(req)?.username ?? "system", summary: `Exposed ${host.name} at ${host.domain}`, ip: clientIp(req), meta: { id: host.id } });
  return reply.code(201).send({ host, apply });
});

app.put("/api/hosts/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const existing = getHost(id);
  if (!existing) return reply.code(404).send({ error: "Service not found" });
  if (!requireHostAccess(req, reply, existing, { allowScoped: true })) return;
  const parsed = hostInput.partial().safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  if (!rejectPrivilegedFields(req, reply, parsed.data)) return;
  // Validate the *resulting* host (existing merged with the patch) before writing.
  const merged = { ...existing, ...parsed.data };
  if (parsed.data.domain && parsed.data.domain !== existing.domain && isControlPlaneDomain(parsed.data.domain)) {
    return reply.code(409).send({ error: "That domain is the NginUX control plane itself — choose another." });
  }
  const spErr = streamPortError(merged, id);
  if (spErr) return reply.code(400).send({ error: spErr });
  snapshot(`Before updating a service`, currentUser(req)?.username ?? "system");
  const host = updateHost(id, parsed.data);
  if (!host) return reply.code(404).send({ error: "Service not found" });
  if (host.mtls) { try { await ensureClientCA(host.domain); } catch { /* non-fatal */ } }
  const apply = await applyConfig();
  // If nginx rejected the change, revert to the previous good config rather than
  // leaving a broken service that would stop nginx from starting next restart.
  if (!apply.ok && apply.nginxAvailable) {
    updateHost(id, existing);
    await applyConfig();
    logEvent({ type: "host.update_failed", severity: "warn", actor: currentUser(req)?.username ?? "system", summary: `Reverted ${existing.name} (${existing.domain}) — config rejected`, ip: clientIp(req), meta: { id, error: apply.message } });
    return reply.code(422).send({ error: apply.message, apply });
  }
  void syncGitOps(`Update ${host.name} (${host.domain})`);
  logEvent({ type: "host.updated", severity: "notice", actor: currentUser(req)?.username ?? "system", summary: `Updated ${host.name} (${host.domain})`, ip: clientIp(req), meta: { id: host.id } });
  return { host, apply };
});

app.delete("/api/hosts/:id", async (req, reply) => {
  if (!requireRole(req, reply, "admin", "editor")) return;
  const { id } = req.params as { id: string };
  const existing = getHost(id);
  snapshot(`Before removing a service`, currentUser(req)?.username ?? "system");
  if (!deleteHost(id)) return reply.code(404).send({ error: "Service not found" });
  // deleteHost() already cascaded the host's client_certs + incidents rows. The
  // domain is unique to this host, so its managed cert (DB row + on-disk dir) is
  // now unreferenced — remove it too. Best-effort: don't fail the delete on it.
  if (existing) { try { deleteCert(existing.domain); } catch { /* ignore */ } }
  const apply = await applyConfig();
  void syncGitOps(`Remove a service`);
  logEvent({ type: "host.deleted", severity: "warn", actor: currentUser(req)?.username ?? "system", summary: `Removed a service`, ip: clientIp(req), meta: { id } });
  return { ok: true, apply };
});

// per-host mTLS client certificates
app.get("/api/hosts/:id/client-certs", async (req, reply) => {
  const { id } = req.params as { id: string };
  const host = getHost(id);
  if (!host || !canReadHost(req, host)) return reply.code(404).send({ error: "Service not found" });
  return listClientCerts(id);
});
app.post("/api/hosts/:id/client-certs", async (req, reply) => {
  const { id } = req.params as { id: string };
  const host = getHost(id);
  if (!host) return reply.code(404).send({ error: "Service not found" });
  if (!requireHostAccess(req, reply, host, { allowScoped: true })) return;
  const parsed = z.object({ name: z.string().min(1).max(64) }).safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  const issued = await issueClientCert(id, host.domain, parsed.data.name);
  logEvent({ type: "cert.client_issued", severity: "notice", actor: currentUser(req)?.username ?? "admin", summary: `Issued client cert "${parsed.data.name}" for ${host.domain}`, ip: clientIp(req), meta: {} });
  return reply.code(201).send(issued); // cert + key shown once
});
app.delete("/api/hosts/:id/client-certs/:certId", async (req, reply) => {
  const { id, certId } = req.params as { id: string; certId: string };
  const host = getHost(id);
  if (!host) return reply.code(404).send({ error: "Service not found" });
  if (!requireHostAccess(req, reply, host, { allowScoped: true })) return;
  // Only revoke a cert that actually belongs to this host (prevents cross-host IDOR).
  if (!listClientCerts(id).some((c) => c.id === certId)) {
    return reply.code(404).send({ error: "Certificate not found for this service." });
  }
  const ok = revokeClientCert(certId);
  if (ok) {
    // Publish the revocation in the CA's CRL and reload nginx so the cert is
    // actually refused (deleting the DB row alone left it valid until expiry).
    writeClientCrl(host.domain);
    const apply = await applyConfig();
    logEvent({ type: "cert.client_revoked", severity: "notice", actor: currentUser(req)?.username ?? "admin", summary: `Revoked a client cert for ${host.domain}`, ip: clientIp(req), meta: { certId } });
    return { ok, apply };
  }
  return { ok };
});

// per-host uptime (availability %, history, incidents)
app.get("/api/hosts/:id/uptime", async (req, reply) => {
  const { id } = req.params as { id: string };
  const host = getHost(id);
  if (!host || !canReadHost(req, host)) return reply.code(404).send({ error: "Service not found" });
  const u = getUptime(id);
  if (!u) return reply.code(404).send({ error: "Service not found" });
  return u;
});

// generated nginx config preview (raw config viewer from the PRD)
app.get("/api/hosts/:id/config", async (req, reply) => {
  const { id } = req.params as { id: string };
  const host = getHost(id);
  if (!host || !canReadHost(req, host)) return reply.code(404).send({ error: "Service not found" });
  let conf: string;
  if (host.protocol === "sni") conf = generateSniPassthrough([host]);
  else if (host.protocol === "tcp" || host.protocol === "udp") conf = generateStreamConfig(host);
  else conf = generateHostConfig(host);
  return reply.type("text/plain").send(conf);
});

// "Test connection" before proceeding (PRD wizard step 2)
const testInput = z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65535) });
app.post("/api/test-connection", async (req, reply) => {
  if (!requireRole(req, reply, "admin", "editor")) return; // not a probe tool for readonly
  const parsed = testInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  const { host, port } = parsed.data;
  // Private LAN targets are legitimate for a homelab, but link-local/metadata is not.
  if (isDangerousHost(host)) return reply.code(400).send({ error: "That destination host is not allowed." });
  const reachable = await tcpProbe(host, port, 2500);
  return {
    reachable,
    message: reachable
      ? `Connected. ${host}:${port} is reachable and responding.`
      : `NginUX can't reach ${host}:${port}. It might be offline or the port may be wrong.`,
  };
});

// ---------- config versioning / backup / restore / export ----------
app.get("/api/config/versions", async () => listVersions());
app.post("/api/config/versions", async (req, reply) => {
  if (!requireRole(req, reply, "admin", "editor")) return;
  const { label } = z.object({ label: z.string().max(120).default("Manual snapshot") }).parse(req.body ?? {});
  return snapshot(label, currentUser(req)?.username ?? "admin");
});
app.get("/api/config/versions/:id/diff", async (req, reply) => {
  const { id } = req.params as { id: string };
  const d = diffVersion(id);
  if (!d) return reply.code(404).send({ error: "Version not found" });
  return d;
});
app.post("/api/config/versions/:id/restore", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const { id } = req.params as { id: string };
  snapshot("Before restore", currentUser(req)?.username ?? "admin");
  const r = restoreVersion(id);
  if (!r) return reply.code(404).send({ error: "Version not found" });
  const apply = await applyConfig();
  void syncGitOps("Restore previous config");
  logEvent({ type: "config.restored", severity: "warn", actor: currentUser(req)?.username ?? "admin", summary: `Restored config (${r.restored} services)`, ip: clientIp(req), meta: { id } });
  return { ...r, apply };
});
app.get("/api/config/export", async (req, reply) => {
  if (!requireAdmin(req, reply)) return; // full dump includes provider secrets
  return { version: VERSION, exportedAt: new Date().toISOString(), hosts: listHosts(), settings: getSettings() };
});
app.post("/api/config/import", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const parsed = z.object({ conf: z.string().min(1).max(1_000_000) }).safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  const { conf } = parsed.data;
  snapshot("Before import", currentUser(req)?.username ?? "admin");
  const result = importNginxConf(conf);
  const apply = await applyConfig();
  void syncGitOps(`Import ${result.imported.length} host(s)`);
  logEvent({ type: "config.imported", severity: "notice", actor: currentUser(req)?.username ?? "admin", summary: `Imported ${result.imported.length} host(s) from nginx.conf`, ip: clientIp(req), meta: result });
  return { ...result, apply };
});
app.get("/api/gitops/log", async () => gitLog());

// ---------- topology + traffic (dashboard) ----------
app.get("/api/topology", async () => {
  const s = getSettings();
  return getTopology({ publicIp: s.publicIp, gatewayIp: s.gatewayIp });
});

app.get("/api/traffic", async (req) => {
  const { range = "live", metric = "requests", host } = req.query as { range?: string; metric?: string; host?: string };
  return trafficSeries(range, metric === "bandwidth" ? "bandwidth" : "requests", host || undefined);
});

// ---------- logs + metrics ----------
app.get("/api/metrics/summary", async (req, reply) => userRoleAtLeast(req, reply, "admin", "editor") ? metricsSummary() : undefined);
app.get("/api/metrics/hosts", async (req) => {
  const { range = "live", metric = "requests" } = req.query as { range?: string; metric?: string };
  return hostTraffic(range, metric === "bandwidth" ? "bandwidth" : "requests");
});
app.get("/api/metrics/host-stats", async (req) => {
  const { range = "live" } = req.query as { range?: string };
  return hostStats(range);
});

// Live reachability for the gateway badge: is nginx actually serving 80/443, and
// (best-effort) can the public IP be reached back through the router?
app.get("/api/network/reachability", async (req, reply) => {
  if (!currentUser(req)) return reply.code(401).send({ error: "Unauthorized" });
  const s = getSettings();
  const [local80, local443] = await Promise.all([tcpProbe("127.0.0.1", 80, 1500), tcpProbe("127.0.0.1", 443, 1500)]);
  const nginxUp = local80 && local443;

  // Detect the real public IP (outbound, best-effort) so we can flag drift.
  let detectedPublicIp: string | null = null;
  try {
    const r = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(3000) });
    if (r.ok) { const ip = (await r.text()).trim(); if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) detectedPublicIp = ip; }
  } catch { /* offline or blocked — fine */ }

  // Probe the public IP back through the router (works only if NAT loopback /
  // hairpin is on, so a failure is inconclusive, not necessarily a broken forward).
  const probeIp = detectedPublicIp ?? s.publicIp;
  const routable = /^\d{1,3}(\.\d{1,3}){3}$/.test(probeIp) && !/^(203\.0\.113\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(probeIp);
  const [ext80, ext443] = routable
    ? await Promise.all([tcpProbe(probeIp, 80, 3000), tcpProbe(probeIp, 443, 3000)])
    : [null, null];

  return {
    nginxUp, local80, local443,
    detectedPublicIp,
    configuredPublicIp: s.publicIp,
    ipMismatch: !!detectedPublicIp && !!s.publicIp && detectedPublicIp !== s.publicIp,
    ext80, ext443,
  };
});
app.get("/api/metrics/traffic", async (req) => {
  const { range = "1d" } = req.query as { range?: string };
  return trafficSeries(range);
});
app.get("/api/metrics/prometheus", async (_req, reply) => {
  return reply.type("text/plain; version=0.0.4").send(prometheus());
});
const clampLimit = (raw?: string): number | undefined =>
  raw ? Math.min(1000, Math.max(1, Number(raw) || 1)) : undefined;

app.get("/api/logs/recent", async (req, reply) => {
  if (!userRoleAtLeast(req, reply, "admin", "editor")) return; // access logs carry client IPs
  const { filter, limit } = req.query as { filter?: string; limit?: string };
  return recentLogs(filter, clampLimit(limit));
});
let sseClients = 0;
const SSE_MAX = Number(process.env.NGINUX_SSE_MAX ?? 200);

app.get("/api/logs/stream", (req, reply) => {
  if (!userRoleAtLeast(req, reply, "admin", "editor")) return; // live access logs carry client IPs
  if (sseClients >= SSE_MAX) return reply.code(503).send({ error: "Too many open streams." });
  sseClients++;
  reply.hijack();
  reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  reply.raw.write(": connected\n\n");
  const unsub = subscribeLog((e) => reply.raw.write(`event: log\ndata: ${JSON.stringify(e)}\n\n`));
  const hb = setInterval(() => reply.raw.write(": ping\n\n"), 25000);
  req.raw.on("close", () => { clearInterval(hb); unsub(); sseClients--; });
});

// ---------- auth ----------
// Sliding-window in-memory limiter so brute force against the control plane is
// throttled even when requests bypass nginx and hit port 4600 directly.
const LOGIN_MAX = 10;          // attempts
const LOGIN_WINDOW_MS = 60_000; // per minute, per key (ip + username)
const loginHits = new Map<string, number[]>();
// Per-account 2FA brute-force lockout + TOTP replay guard (in-memory; the window
// is short so a restart clearing them is harmless).
const TWOFA_MAX_FAILS = 5;
const TWOFA_LOCK_MS = 5 * 60_000;
const twofaFails = new Map<string, { n: number; until: number }>();
function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const hits = (loginHits.get(key) ?? []).filter((t) => now - t < windowMs);
  hits.push(now);
  loginHits.set(key, hits);
  if (loginHits.size > 5000) { // crude cap so the map can't grow unbounded
    for (const [k, v] of loginHits) { if (v.every((t) => now - t >= windowMs)) loginHits.delete(k); }
  }
  return hits.length > max;
}

/** Cookie Domain for the session cookie — the configured ssoCookieDomain, or
 *  derived from ssoLoginUrl's host (strip the leftmost label), or "" (host-only).
 *  Lets one sign-in cover every subdomain so login-gated services work. */
function authCookieDomain(): string {
  const s = getSettings();
  if (s.ssoCookieDomain) return s.ssoCookieDomain.replace(/^\.?/, ".");
  try {
    const host = new URL(s.ssoLoginUrl).hostname;
    const parts = host.split(".");
    if (parts.length >= 2) return "." + parts.slice(parts.length > 2 ? 1 : 0).join(".");
  } catch { /* ssoLoginUrl unset/invalid */ }
  return "";
}

const loginInput = z.object({ username: z.string(), password: z.string(), token: z.string().optional() });
app.post("/api/auth/login", async (req, reply) => {
  const parsed = loginInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
  const { username, password, token } = parsed.data;
  const ip = clientIp(req);

  if (rateLimited(`${ip}:${username}`.toLowerCase(), LOGIN_MAX, LOGIN_WINDOW_MS)) {
    logEvent({ type: "login.failed", severity: "warn", actor: username, summary: "Too many login attempts — throttled", ip, meta: {} });
    return reply.code(429).send({ error: "Too many attempts. Wait a minute and try again." });
  }

  const row = await checkCredentials(username, password);
  if (!row) {
    logEvent({ type: "login.failed", severity: "warn", actor: username, summary: "Wrong username or password", ip, meta: {} });
    return reply.code(401).send({ error: "Wrong username or password." });
  }

  if (row.twofaEnabled) {
    if (!token) return reply.send({ twofaRequired: true });
    const uid = String(row.id);
    // Per-account 2FA lockout, independent of source IP (so rotating IPs can't
    // multiply guesses against one account).
    const lock = twofaFails.get(uid);
    if (lock && lock.until > Date.now()) {
      logEvent({ type: "login.failed", severity: "warn", actor: username, summary: "2FA locked — too many wrong codes", ip, meta: {} });
      return reply.code(429).send({ error: "Too many 2FA attempts. Wait a few minutes.", twofaRequired: true });
    }
    const secret = getTwofaSecret(uid);
    // Accept a TOTP code (rejecting replay of an already-used step) or a one-time backup code.
    const counter = secret ? verifyTotpCounter(token, secret) : -1;
    // Reject replay of an already-consumed step (persisted, so it survives restart).
    const totpOk = counter >= 0 && counter > getLastTotpCounter(uid);
    const ok = totpOk || useBackupCode(uid, token);
    if (!ok) {
      const f = twofaFails.get(uid) ?? { n: 0, until: 0 };
      f.n += 1;
      if (f.n >= TWOFA_MAX_FAILS) { f.until = Date.now() + TWOFA_LOCK_MS; f.n = 0; }
      twofaFails.set(uid, f);
      logEvent({ type: "login.failed", severity: "warn", actor: username, summary: "Incorrect 2FA code", ip, meta: {} });
      return reply.code(401).send({ error: "That 2FA code didn't match.", twofaRequired: true });
    }
    if (totpOk) setLastTotpCounter(uid, counter); // burn this step so it can't be replayed
    twofaFails.delete(uid);
  }

  const sessionToken = createSession(String(row.id), device(req), ip);
  logEvent({ type: "login.success", severity: "info", actor: username, summary: "Signed in", ip, meta: {} });
  reply.header("set-cookie", sessionCookie(sessionToken, cookieSecure(req.protocol === "https"), authCookieDomain()));
  return { user: getUserById(String(row.id)) };
});

app.post("/api/auth/logout", async (req, reply) => {
  const tok = parseCookie(req.headers.cookie)[SESSION_COOKIE];
  if (tok) destroySession(tok);
  reply.header("set-cookie", clearCookie(cookieSecure(req.protocol === "https"), authCookieDomain()));
  return { ok: true };
});

app.get("/api/auth/me", async (req, reply) => {
  const u = currentUser(req);
  if (!u) return reply.code(401).send({ error: "Not signed in" });
  return u;
});

// auth_request target for nginx forward-auth: 200 = allowed, 401 = block.
// nginx passes the original host so we can enforce that host's policy, and an
// optional shared secret so the endpoint can't be usefully called directly.
const FORWARD_SECRET = process.env.NGINUX_FORWARD_SECRET || "";
app.get("/api/auth/forward", async (req, reply) => {
  if (FORWARD_SECRET && req.headers["x-nginux-forward-secret"] !== FORWARD_SECRET) {
    return reply.code(401).send({ ok: false });
  }
  const u = currentUser(req);
  if (!u) return reply.code(401).send({ ok: false });
  // If we can identify the target host, enforce its per-host requirements.
  const originalHost = (req.headers["x-original-host"] as string) || (req.headers["x-forwarded-host"] as string);
  if (originalHost) {
    const host = getHostByDomainCached(originalHost.split(":")[0]);
    if (host) {
      if (host.require2fa && !u.twofaEnabled) return reply.code(401).send({ ok: false });
      // A scoped user only passes the per-host login gate for hosts in their
      // scope — otherwise one NginUX login would unlock every protected app.
      if (u.role === "scoped" && !scopedAllows(u, host)) return reply.code(403).send({ ok: false });
    }
  }
  return reply.code(200).send({ ok: true });
});

app.post("/api/auth/change-password", async (req, reply) => {
  const u = currentUser(req);
  if (!u) return reply.code(401).send({ error: "Not signed in" });
  const parsed = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8, "Use at least 8 characters.").max(200),
  }).safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  if (parsed.data.newPassword === parsed.data.currentPassword) {
    return reply.code(400).send({ error: "Pick a password different from the current one." });
  }
  if (!(await changePassword(u.id, parsed.data.currentPassword, parsed.data.newPassword))) {
    return reply.code(400).send({ error: "Your current password is incorrect." });
  }
  // changePassword revoked all sessions; issue a fresh one so the current client
  // stays signed in while any other (possibly stolen) sessions are now dead.
  const fresh = createSession(u.id, device(req), clientIp(req));
  reply.header("set-cookie", sessionCookie(fresh, cookieSecure(req.protocol === "https"), authCookieDomain()));
  logEvent({ type: "security.password_changed", severity: "notice", actor: u.username, summary: "Changed account password", ip: clientIp(req), meta: {} });
  return { ok: true, user: getUserById(u.id) };
});

app.post("/api/auth/2fa/setup", async (req, reply) => {
  const u = currentUser(req)!;
  // Require the password to (re)bind 2FA so a hijacked session can't silently
  // rebind the authenticator to the attacker's device.
  const { password } = z.object({ password: z.string().min(1) }).parse(req.body ?? {});
  if (!(await checkCredentials(u.username, password))) {
    return reply.code(403).send({ error: "Confirm your password to set up two-factor authentication." });
  }
  const { secret } = beginTwofaSetup(u.id);
  return { secret, otpauth: otpauthURL(secret, u.username) };
});

app.post("/api/auth/2fa/verify", async (req, reply) => {
  const u = currentUser(req)!;
  const { token } = z.object({ token: z.string() }).parse(req.body);
  const secret = getTwofaSecret(u.id);
  if (!secret || !verifyTotp(token, secret)) {
    return reply.code(400).send({ error: "That code didn't match — try the current one." });
  }
  const backupCodes = enableTwofa(u.id);
  logEvent({ type: "security.2fa_enabled", severity: "info", actor: u.username, summary: "Enabled two-factor authentication", ip: clientIp(req), meta: {} });
  return { ok: true, backupCodes };
});

// ---------- users (admin) ----------
app.get("/api/users", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  return listUsers();
});
app.post("/api/users", async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  const body = z
    .object({
      username: z.string().min(1).max(64),
      password: z.string().min(8).max(200),
      email: z.string().max(254).optional(),
      role: z.enum(["admin", "editor", "readonly", "scoped"]).default("readonly"),
      scope: z.string().optional(),
    })
    .parse(req.body);
  // Admin-created users get a temporary password they must change on first login.
  const user = await createUser({ ...body, mustChangePassword: true });
  logEvent({ type: "user.created", severity: "notice", actor: admin.username, summary: `Created user ${body.username} (${body.role})`, ip: clientIp(req), meta: {} });
  return reply.code(201).send(user);
});
app.delete("/api/users/:id", async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  const { id } = req.params as { id: string };
  if (id === admin.id) return reply.code(400).send({ error: "You can't delete your own account." });
  deleteUser(id);
  logEvent({ type: "user.deleted", severity: "warn", actor: admin.username, summary: `Deleted a user`, ip: clientIp(req), meta: { id } });
  return { ok: true };
});

// Admin reset of another user's password (no current password needed; the user
// is forced to change it on next login and their sessions are revoked).
app.post("/api/users/:id/password", async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const parsed = z.object({ newPassword: z.string().min(8, "Use at least 8 characters.").max(200) }).safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  if (!(await adminSetPassword(id, parsed.data.newPassword))) return reply.code(404).send({ error: "User not found" });
  const target = getUserById(id);
  logEvent({ type: "user.password_reset", severity: "warn", actor: admin.username, summary: `Reset password for ${target?.username ?? id}`, ip: clientIp(req), meta: { id } });
  return { ok: true };
});

app.get("/api/sessions", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  // Never return the raw session token to the client — mask to a short id.
  return listSessions().map((s) => ({ ...s, token: "…" + s.token.slice(-6) }));
});

// ---------- audit + security posture ----------
app.get("/api/audit", async (req, reply) => {
  if (!requireRole(req, reply, "admin", "editor")) return;
  const { type, limit } = req.query as { type?: string; limit?: string };
  return listEvents({ type, limit: clampLimit(limit) });
});
app.get("/api/security/overview", async (req, reply) => requireRole(req, reply, "admin", "editor") ? securityOverview() : undefined);
app.get("/api/security/exposure", async (req, reply) => requireRole(req, reply, "admin", "editor") ? securityExposure() : undefined);

// ---------- IP bans (fail2ban-style) ----------
app.get("/api/bans", async (req, reply) => requireRole(req, reply, "admin", "editor") ? listBans() : undefined);
app.post("/api/bans", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const parsed = z.object({
    ip: z.string().refine(isIpOrCidr, "Must be a valid IP or CIDR."),
    reason: z.string().max(200).default("Manually banned"),
  }).safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  const { ip, reason } = parsed.data;
  const ban = addBan(ip, reason, "manual");
  logEvent({ type: "security.ip_banned", severity: "warn", actor: currentUser(req)?.username ?? "admin", summary: `Banned ${ip}`, ip: clientIp(req), meta: { source: "manual" } });
  return reply.code(201).send(ban);
});
app.delete("/api/bans/:ip", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const { ip } = req.params as { ip: string };
  const ok = removeBan(decodeURIComponent(ip));
  if (ok) logEvent({ type: "security.ip_unbanned", severity: "info", actor: currentUser(req)?.username ?? "admin", summary: `Unbanned ${ip}`, ip: clientIp(req), meta: {} });
  return { ok };
});

// ---------- certificates ----------
app.get("/api/certificates", async (req, reply) => requireRole(req, reply, "admin", "editor") ? listCerts() : undefined);

app.post("/api/certificates/:domain/issue", async (req, reply) => {
  if (!requireRole(req, reply, "admin", "editor")) return;
  const dp = domainParam.safeParse((req.params as { domain: string }).domain);
  if (!dp.success) return reply.code(400).send({ error: "Invalid domain." });
  const domain = dp.data;
  const { method } = z
    .object({ method: z.enum(["selfsigned", "http-01", "dns-01"]).default("selfsigned") })
    .parse(req.body ?? {});
  try {
    const cert = await issue(domain, method as CertMethod);
    await applyConfig(); // pick up the new cert paths
    logEvent({ type: "cert.issued", severity: "info", actor: currentUser(req)?.username ?? "system", summary: `Issued ${method} certificate for ${domain}`, ip: clientIp(req), meta: {} });
    return cert;
  } catch (e) {
    const kind = e instanceof AcmeError ? e.kind : "other";
    return reply.code(kind === "rate_limit" ? 429 : 422).send({ error: e instanceof Error ? e.message : "Issuance failed.", kind });
  }
});

app.post("/api/certificates/:domain/renew", async (req, reply) => {
  if (!requireRole(req, reply, "admin", "editor")) return;
  const dp = domainParam.safeParse((req.params as { domain: string }).domain);
  if (!dp.success) return reply.code(400).send({ error: "Invalid domain." });
  const domain = dp.data;
  const cert = getCert(domain);
  if (!cert) return reply.code(404).send({ error: "No certificate for that domain." });
  try {
    const next = await issue(domain, cert.method);
    await applyConfig();
    return next;
  } catch (e) {
    const kind = e instanceof AcmeError ? e.kind : "other";
    return reply.code(kind === "rate_limit" ? 429 : 422).send({ error: e instanceof Error ? e.message : "Renewal failed.", kind });
  }
});

app.put("/api/certificates/:domain/autorenew", async (req, reply) => {
  if (!requireRole(req, reply, "admin", "editor")) return;
  const dp = domainParam.safeParse((req.params as { domain: string }).domain);
  if (!dp.success) return reply.code(400).send({ error: "Invalid domain." });
  const { on } = z.object({ on: z.boolean() }).parse(req.body);
  setAutoRenew(dp.data, on);
  return getCert(dp.data);
});

app.post("/api/certificates/import", async (req, reply) => {
  if (!requireRole(req, reply, "admin", "editor")) return;
  const parsed = z.object({
    files: z.array(z.object({ path: z.string().max(1024), content: z.string().max(200_000) })).min(1).max(300),
  }).safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid upload." });
  const result = importCertFiles(parsed.data.files);
  if (result.imported.length) {
    reconcileImportedCerts(); // register the new files in the DB
    await applyConfig();       // and have nginx start serving them
    logEvent({ type: "cert.imported", severity: "notice", actor: currentUser(req)?.username ?? "admin", summary: `Imported ${result.imported.length} certificate(s)`, ip: clientIp(req), meta: { domains: result.imported.map((i) => i.domain) } });
  }
  return result;
});

app.get("/api/certificates/:domain/details", async (req, reply) => {
  if (!requireRole(req, reply, "admin", "editor")) return;
  const dp = domainParam.safeParse((req.params as { domain: string }).domain);
  if (!dp.success) return reply.code(400).send({ error: "Invalid domain." });
  const details = getCertDetails(dp.data);
  if (!details) return reply.code(404).send({ error: "No certificate file for that domain yet." });
  return details;
});

app.delete("/api/certificates/:domain", async (req, reply) => {
  if (!requireRole(req, reply, "admin", "editor")) return;
  const dp = domainParam.safeParse((req.params as { domain: string }).domain);
  if (!dp.success) return reply.code(400).send({ error: "Invalid domain." });
  deleteCert(dp.data);
  // Re-apply so any host on this domain drops back to the bootstrap cert cleanly.
  const apply = await applyConfig();
  logEvent({ type: "cert.deleted", severity: "warn", actor: currentUser(req)?.username ?? "system", summary: `Deleted certificate for ${dp.data}`, ip: clientIp(req), meta: {} });
  return { ok: true, apply };
});

// ---------- GeoIP (country lock) ----------
app.get("/api/geoip/status", async () => geoipStatus());

app.post("/api/geoip/download", async (req, reply) => {
  if (!requireRole(req, reply, "admin", "editor")) return;
  let result: { sizeBytes: number };
  try {
    result = await downloadGeoipDb();
  } catch (e) {
    return reply.code(422).send({ error: e instanceof Error ? e.message : "Download failed." });
  }
  // Regenerate the geo config and validate it. If nginx rejects it, drop the DB
  // and restore the allow-all include so we never leave a broken config behind.
  writeGeoipConf();
  const apply = await applyConfig();
  if (!apply.ok && apply.nginxAvailable) {
    deleteGeoipDb();
    writeGeoipConf();
    await applyConfig();
    return reply.code(422).send({ error: `Database installed but nginx rejected the geo config: ${apply.message}` });
  }
  logEvent({ type: "geoip.updated", severity: "info", actor: currentUser(req)?.username ?? "system", summary: `Updated GeoIP database (${Math.round(result.sizeBytes / 1024)} KB)`, ip: clientIp(req), meta: {} });
  return { ok: true, status: geoipStatus() };
});

app.delete("/api/geoip", async (req, reply) => {
  if (!requireRole(req, reply, "admin", "editor")) return;
  deleteGeoipDb();
  writeGeoipConf();
  const apply = await applyConfig();
  logEvent({ type: "geoip.deleted", severity: "notice", actor: currentUser(req)?.username ?? "system", summary: "Removed GeoIP database", ip: clientIp(req), meta: {} });
  return { ok: true, apply };
});

// ---------- agents: tokens ----------
app.get("/api/tokens", async (req, reply) => requireAdmin(req, reply) ? listTokens() : undefined);
app.post("/api/tokens", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const body = z
    .object({
      name: z.string().min(1).max(64),
      scopes: z.array(z.enum(["read", "report", "control", "security"])).min(1),
      trust: z.enum(["untrusted", "trusted"]).default("untrusted"),
    })
    .parse(req.body);
  const { token, record } = createToken(body);
  logEvent({ type: "agent.token_created", severity: "notice", actor: currentUser(req)?.username ?? "admin", summary: `Created API token "${body.name}"`, ip: clientIp(req), meta: { scopes: body.scopes } });
  return reply.code(201).send({ token, record }); // raw token shown once
});
app.delete("/api/tokens/:id", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const { id } = req.params as { id: string };
  revokeToken(id);
  return { ok: true };
});

// ---------- agents: tools, approvals, overview ----------
app.get("/api/agents/tools", async () => toolCatalog());
app.get("/api/agents/approvals", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const { status } = req.query as { status?: string };
  return listApprovals(status);
});
app.post("/api/agents/approvals/:id/approve", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const { id } = req.params as { id: string };
  const ap = await decideApproval(id, true, currentUser(req)?.username ?? "admin");
  if (!ap) return reply.code(404).send({ error: "Approval not found" });
  return ap;
});
app.post("/api/agents/approvals/:id/deny", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const { id } = req.params as { id: string };
  const ap = await decideApproval(id, false, currentUser(req)?.username ?? "admin");
  if (!ap) return reply.code(404).send({ error: "Approval not found" });
  return ap;
});
app.get("/api/agents/overview", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  return {
    agents: listTokens().length,
    tools: toolCatalog().length,
    pendingApprovals: listApprovals("pending").length,
    webhooks: listWebhooks().length,
  };
});

// ---------- agents: webhooks ----------
app.get("/api/webhooks", async (req, reply) => requireAdmin(req, reply) ? listWebhooks() : undefined);
app.post("/api/webhooks", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const parsed = z.object({ url: z.string().url(), events: z.array(z.string().max(64)).max(50).default(["*"]) }).safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  try { assertSafeOutboundUrl(parsed.data.url); }
  catch (e) { return reply.code(400).send({ error: e instanceof Error ? e.message : "Invalid URL." }); }
  const { webhook, secret } = createWebhook(parsed.data.url, parsed.data.events);
  return reply.code(201).send({ webhook, secret }); // secret shown once
});
app.delete("/api/webhooks/:id", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const { id } = req.params as { id: string };
  deleteWebhook(id);
  return { ok: true };
});

// ---------- notification channels ----------
app.get("/api/channels", async (req, reply) => requireAdmin(req, reply) ? listChannels() : undefined);
app.post("/api/channels", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const parsed = z
    .object({
      type: z.enum(["ntfy", "gotify", "pushover", "discord", "slack", "telegram", "webhook", "email"]),
      name: z.string().min(1).max(64),
      config: z.record(z.string(), z.string().max(2048)).default({}),
      events: z.array(z.string().max(64)).max(50).default(["*"]),
    })
    .safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  const body = parsed.data;
  // SSRF guard: any user-supplied destination URL must be a safe http(s) target.
  for (const key of ["url", "server"]) {
    const v = body.config[key];
    if (v) { try { assertSafeOutboundUrl(v); } catch (e) { return reply.code(400).send({ error: e instanceof Error ? e.message : "Invalid URL." }); } }
  }
  const ch = createChannel({ type: body.type as ChannelType, name: body.name, config: body.config, events: body.events });
  logEvent({ type: "alert.channel_added", severity: "notice", actor: currentUser(req)?.username ?? "admin", summary: `Added ${body.type} notification channel "${body.name}"`, ip: clientIp(req), meta: {} });
  return reply.code(201).send(ch);
});
app.put("/api/channels/:id/enabled", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const { id } = req.params as { id: string };
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
  setChannelEnabled(id, enabled);
  return { ok: true };
});
app.delete("/api/channels/:id", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const { id } = req.params as { id: string };
  deleteChannel(id);
  return { ok: true };
});
app.post("/api/channels/:id/test", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const { id } = req.params as { id: string };
  return testChannel(id);
});

// ---------- MCP server (JSON-RPC over HTTP; session or Bearer token) ----------
app.post("/api/mcp", async (req, reply) => {
  const me = principal(req)!;
  const body = req.body as Record<string, unknown> | Record<string, unknown>[];
  const handle = (m: Record<string, unknown>) => handleMcp(me, m as never);
  if (Array.isArray(body)) {
    if (body.length > 50) return reply.code(413).send({ error: "Batch too large (max 50)." });
    const out = (await Promise.all(body.map(handle))).filter(Boolean);
    return reply.send(out);
  }
  const res = await handle(body);
  if (res === null) return reply.code(204).send();
  return reply.send(res);
});

// ---------- SSE event stream ----------
app.get("/api/events/sse", (req, reply) => {
  if (sseClients >= SSE_MAX) return reply.code(503).send({ error: "Too many open streams." });
  sseClients++;
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  reply.raw.write(": connected\n\n");
  const unsub = subscribe((e) => {
    reply.raw.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  });
  const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 25000);
  req.raw.on("close", () => {
    clearInterval(heartbeat);
    unsub();
    sseClients--;
  });
});

// ---------- static SPA (production) ----------
const webDist = join(__dirname, "..", "..", "web", "dist");
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api")) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile("index.html"); // SPA fallback
  });
}

app.listen({ port: PORT, host: HOST }).then(async () => {
  app.log.info(`NginUX control plane on http://${HOST}:${PORT}`);
  if (seeded.usingDefault) {
    app.log.warn(`First run — default login is "admin" / "admin". You'll be required to set a new password on first sign-in.`);
  }
  if (process.env.NODE_ENV === "production" && !FORWARD_SECRET) {
    app.log.warn("NGINUX_FORWARD_SECRET is not set — set it so /api/auth/forward can't be invoked directly. Per-host login gates are weaker without it.");
  }
  // Render the data plane on boot so nginx serves the managed hosts.
  const result = await applyConfig();
  app.log.info(`nginx apply on boot: ${result.message}`);
  // Daily auto-renewal + cert status refresh.
  startRenewalScheduler();
  // Metrics: tail nginx access logs; only feed synthetic traffic when explicitly
  // asked (NGINUX_DEMO_TRAFFIC=1) or in an explicit dev run — never silently in prod.
  startLogTailer();
  const devRun = process.execArgv.includes("--watch"); // `npm run dev`, never `start`
  if (process.env.NGINUX_DEMO_TRAFFIC === "1" || devRun) {
    startDemoTraffic();
    app.log.info("demo traffic generator on — feeding the metrics pipeline");
  }
  // Uptime monitoring + alert routing + brute-force auto-ban.
  startUptimeMonitor();
  initAlertEngine();
  startBanEngine();
  // Keep the audit log bounded.
  pruneAuditLog();
  setInterval(() => { try { pruneAuditLog(); } catch { /* ignore */ } }, 24 * 3600_000).unref?.();
});

// ---------- graceful shutdown ----------
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`${signal} received — shutting down gracefully`);
  const hardExit = setTimeout(() => process.exit(1), 10_000);
  hardExit.unref?.();
  try { await app.close(); } catch (e) { app.log.error({ e }, "error closing server"); }
  try { closeDb(); } catch { /* ignore */ }
  process.exit(0);
}
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => void shutdown(sig));
process.on("unhandledRejection", (reason) => app.log.error({ reason }, "unhandled promise rejection"));
process.on("uncaughtException", (err) => app.log.error({ err }, "uncaught exception"));

// ---------- helpers ----------
function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

