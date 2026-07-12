import { connect } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { closeDb, dbOk, getSettings, pruneAuditLog, redactSettings, saveSettings, seedIfEmpty } from "./db.ts";
import { PRESETS } from "./presets.ts";
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
import { applyConfig, generateHostConfig, generateStreamConfig, previewConfigForHosts, redactConfig } from "./nginx.ts";
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
  scopedAllows,
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
import { applyUpdate, checkForUpdate, simulateStaleBuild, startUpdateChecker, updateStatus } from "./update.ts";
import {
  AcmeError,
  deleteCert,
  ensureCert,
  getAcmeActivity,
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
  type Scope,
} from "./tokens.ts";
import { decideApproval, listApprovals, scopesForRole, toolCatalog, type Principal } from "./tools.ts";
import { createWebhook, deleteWebhook, listWebhooks, subscribe } from "./events.ts";
import { handleMcp } from "./mcp.ts";
import {
  prometheus,
  recentLogs,
  searchLog,
  hostStats,
  hostTraffic,
  startDemoTraffic,
  startLogTailer,
  replayAccessLog,
  subscribeLog,
  summary as metricsSummary,
  rangeSummary as metricsRangeSummary,
  hostSummary as metricsHostSummary,
  trafficSeries,
} from "./metrics.ts";
import { getUptime, startUptimeMonitor } from "./uptime.ts";
import { rotateLogsNow, startLogRotation } from "./logrotate.ts";
import { diffVersion, listVersions, restoreVersion, snapshot } from "./versioning.ts";
import { gitLog, syncGitOps } from "./gitops.ts";
import { importNginxConf } from "./importer.ts";
import { addBan, listBans, removeBan, startBanEngine } from "./bans.ts";
import { ensureClientCA, issueClientCert, listClientCerts, revokeClientCert, writeClientCrl } from "./clientcerts.ts";
import { generateSniPassthrough } from "./nginx.ts";
import {
  assertSafeOutboundUrl,
  isDangerousHost,
  isHost,
  isHostname,
  isIpOrCidr,
} from "./validate.ts";
import { hostInput, isControlPlaneDomain } from "./hostschema.ts";
import {
  createChannel,
  deleteChannel,
  initAlertEngine,
  listChannels,
  setChannelEnabled,
  setChannelRouting,
  testChannel,
  type ChannelType,
} from "./notify.ts";
import type { FastifyReply, FastifyRequest } from "fastify";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 6767);
const HOST = process.env.HOST ?? "0.0.0.0";

seedIfEmpty();
// The forward-auth shared secret is managed entirely in the DB now (no env var).
// Generate one automatically if it's unset so the login gate is protected by
// default - admins can rotate it anytime from Settings → Login gate.
if (!getSettings().ssoForwardSecret) {
  saveSettings({ ssoForwardSecret: randomBytes(24).toString("hex") });
}
const seeded = await seedAuthIfEmpty();
seedTokensIfEmpty();
writeGeoipConf(); // keep the country-lock include in sync with settings on boot
reconcileImportedCerts(); // pick up any cert files dropped into /data/certs (migrations)

// Profile avatars live as raw image files under the data volume, keyed by user id
// (no DB column - keeps the schema migration-free). The image type is sniffed on
// read so the upload can be PNG/JPEG/WebP without tracking the extension.
const AVATAR_DIR = join(process.env.NGINUX_DATA_DIR ?? join(__dirname, "..", "data"), "avatars");
const AVATAR_MAX_BYTES = 700 * 1024;
function avatarPath(id: string): string {
  // Defend the path join against traversal - ids are uuids, but never trust input.
  return join(AVATAR_DIR, id.replace(/[^a-zA-Z0-9_-]/g, ""));
}
function sniffImageType(buf: Buffer): string | null {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

// Resolving the session costs two SQL lookups + a cookie parse, and currentUser is
// called many times per request (preHandler, principal, then each handler). Memoize
// per-request via a WeakMap keyed on the request object so it resolves once. A
// request's identity never changes mid-flight (login/change-password issue the new
// cookie and read the user directly, not via currentUser), so this is safe. The
// WeakMap entry is collected with the request. This also speeds the nginx
// forward-auth subrequest, which is on the per-request hot path of every gated host.
const userCache = new WeakMap<FastifyRequest, User | null>();
const currentUser = (req: FastifyRequest): User | null => {
  const cached = userCache.get(req);
  if (cached !== undefined) return cached;
  const u = userForSession(parseCookie(req.headers.cookie)[SESSION_COOKIE]);
  userCache.set(req, u);
  return u;
};
/** Resolve the caller to a user (session) or agent (bearer token). A user's tool
 *  scopes come from their role so the MCP/agent path enforces the same RBAC as
 *  REST (a readonly/scoped user can't run control/security tools). */
const principal = (req: FastifyRequest): Principal | null => {
  const u = currentUser(req);
  if (u) return { kind: "user", name: u.username, scopes: scopesForRole(u.role), user: u };
  return resolveToken(bearerFrom(req.headers.authorization));
};
// Only believe X-Forwarded-For from a trusted hop. NGINUX_TRUST_PROXY=true trusts
// XFF *only from loopback* - the bundled nginx forwards auth subrequests from
// 127.0.0.1, so we get real client IPs there, while a browser hitting :6767
// directly (a non-loopback peer) can't spoof XFF to forge audit IPs / dodge bans.
// Set NGINUX_TRUST_PROXY to a specific IP/CIDR when fronting :6767 with your own
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
  bodyLimit: 2 * 1024 * 1024, // 2 MB - generous for config import, bounded for safety
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
  // CSRF applies to EVERY mutating cookie request, including /api/mcp - a malicious
  // page must not be able to drive state-changing MCP tools as the logged-in user.
  // Bearer-token agents send no Origin, so they're unaffected. This runs BEFORE the
  // open-path short-circuit so even unauthenticated mutating endpoints (login) can't
  // be driven cross-site (login CSRF / forced-session fixation); a same-origin SPA
  // POST and any non-mutating / no-Origin request still pass.
  if (crossOriginBlocked(req)) return reply.code(403).send({ error: "Cross-origin request blocked." });
  if (OPEN_PATHS.has(path)) return;
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
  // sets a real password - enforced here, not just in the SPA.
  if (u.mustChangePassword && !PW_CHANGE_ALLOWED.has(path)) {
    return reply.code(403).send({ error: "Set a new password before continuing.", mustChangePassword: true });
  }
});

// Security headers on every control-plane response (the admin UI + API on :6767).
// frame-ancestors/X-Frame-Options stop the UI being framed (clickjacking); nosniff
// stops MIME sniffing; the CSP locks script/style/connect to same-origin.
app.addHook("onSend", async (_req, reply, payload) => {
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header(
    "Content-Security-Policy",
    // jsdelivr serves the dashboard-icons logo set used for service icons (images only).
    "default-src 'self'; img-src 'self' data: https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; " +
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

// scopedAllows is imported from auth.ts (the one canonical scope-membership rule
// shared by REST, MCP tools, and MCP resources).

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

/** customNginx is a raw-directive escape hatch - only admins may set it. */
// Fields a `scoped` user must not set: they manage a service but may not change
// its security posture or routing (which could expose it or repoint it).
const SCOPED_FORBIDDEN_FIELDS = [
  "requireLogin", "require2fa", "mtls", "countryLock", "securityHeaders", "hsts",
  "blockExploits", "ipAllow", "ipDeny", "customHeaders", "pathRules", "upstreams",
  // Repointing to a DIFFERENT machine, hijacking the domain, or flipping TLS is
  // routing/posture - not "managing" the service - and would let a scoped user turn
  // NginUX into an SSRF pivot to any internal target or shadow another host's domain.
  // `upstreams` is already forbidden; the primary forward HOST/scheme and the domain
  // must be too, or the rule is trivially bypassed. `forwardPort` is deliberately NOT
  // here: moving your own app to a new port on the same box is legitimate management
  // (they still can't point at a different host), so the SSRF-pivot door stays shut.
  "forwardHost", "forwardScheme", "domain", "ssl",
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

/** Gate a route reachable by users AND tokens so it enforces the SAME RBAC as the
 *  equivalent MCP tool: a cookie user must hold one of `roles`; a token principal
 *  must hold `scope`. userRoleAtLeast() alone lets EVERY valid token through
 *  regardless of scope - use THIS on token-reachable routes that expose sensitive
 *  data (access logs with client IPs, the audit stream, metrics) so a low-scope
 *  token can't read what the matching MCP tool would deny it. */
function requireRoleOrScope(req: FastifyRequest, reply: FastifyReply, roles: Role[], scope: Scope): boolean {
  const u = currentUser(req);
  if (u) {
    if (!roles.includes(u.role)) {
      reply.code(403).send({ error: `This action requires one of: ${roles.join(", ")}.` });
      return false;
    }
    return true;
  }
  const p = principal(req);
  if (!p || !p.scopes.includes(scope)) {
    reply.code(403).send({ error: `This action requires the '${scope}' scope.` });
    return false;
  }
  return true;
}

// ---------- validation ----------
// The host-write schema (`hostInput`) + its field predicates live in
// hostschema.ts, shared verbatim with the agent/MCP tool path so the two can't
// drift. See that module for the injection-boundary rationale.

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

// ---------- self-update (admin only; agents have no tool for this on purpose) ----------
app.get("/api/update/status", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  return updateStatus();
});

app.post("/api/update/check", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  // Dev-only escape hatch: ?simulate=1 marks the current build stale so the
  // update flow can be exercised without a real newer release.
  const simulate = (req.query as { simulate?: string }).simulate === "1";
  if (simulate && process.env.NODE_ENV !== "production") return simulateStaleBuild();
  return checkForUpdate();
});

app.post("/api/update/apply", async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  const result = await applyUpdate(admin.username);
  return reply.code(result.ok ? 200 : 422).send(result);
});

// ---------- presets ----------
app.get("/api/presets", async () => Object.values(PRESETS));

// ---------- settings ----------
const settingsInput = z.object({
  instanceName: z.string().max(120),
  baseDomain: z.string().max(253).refine((s) => s === "" || isHostname(s), "Invalid base domain."),
  theme: z.enum(["dark", "less-dark", "medium", "less-light", "light"]),
  letsEncryptEmail: z.string().max(254),
  homeCountry: z.string().max(2),
  // Comma/space-separated ISO-3166-1 alpha-2 codes; geoip.ts filters to valid
  // 2-letter tokens, so we only bound length + charset here (no injection into
  // the generated nginx map - each code is re-validated against /^[A-Z]{2}$/).
  allowedCountries: z.string().max(512).regex(/^[A-Za-z ,]*$/, "Only letters, spaces and commas."),
  publicIp: z.string().max(64),
  gatewayIp: z.string().max(64),
  dnsProvider: z.enum(["none", "godaddy", "cloudflare"]),
  godaddyApiKey: z.string().max(256),
  godaddySecret: z.string().max(256),
  cloudflareApiToken: z.string().max(256),
  maxmindLicenseKey: z.string().max(256),
  acmeStaging: z.boolean(),
  updateCheckEnabled: z.boolean(),
  agentAutoApprove: z.boolean(),
  gitOpsEnabled: z.boolean(),
  ssoLoginUrl: z.string().max(512).refine((s) => s === "" || /^https?:\/\/[^\s/]+/i.test(s), "Must be a full URL like https://nginux.example.com."),
  ssoCookieDomain: z.string().max(253).refine((s) => s === "" || /^\.?[a-z0-9.-]+$/i.test(s), "Invalid cookie domain."),
  ssoForwardSecret: z.string().max(256),
  logMaxMb: z.number().int().min(0).max(100000),
  logKeepFiles: z.number().int().min(0).max(50),
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
  // Audit which settings changed (keys only - values may be secrets). Security-
  // relevant toggles like agentAutoApprove / ssoForwardSecret must leave a trail.
  const changedKeys = Object.keys(parsed.data);
  if (changedKeys.length) {
    logEvent({ type: "settings.updated", severity: "notice", actor: currentUser(req)?.username ?? "admin", summary: `Updated settings: ${changedKeys.join(", ")}`, ip: clientIp(req), meta: { keys: changedKeys } });
  }
  // Changing the allowed countries (home or travel allowlist) re-derives the geo config.
  const geoChanged = parsed.data.homeCountry !== undefined || parsed.data.allowedCountries !== undefined;
  if (geoChanged) writeGeoipConf();
  // Apply new log-rotation limits right away instead of waiting for the timer.
  if (parsed.data.logMaxMb !== undefined || parsed.data.logKeepFiles !== undefined) {
    try { rotateLogsNow(); } catch { /* best-effort */ }
  }
  // Several settings are baked into generated nginx config (the geo include, the
  // login-gate 401→login redirect, and the forward-auth secret header) - re-apply
  // so a change here takes effect immediately instead of on the next host edit.
  if (geoChanged || parsed.data.ssoLoginUrl !== undefined || parsed.data.ssoForwardSecret !== undefined) {
    await applyConfig();
  }
  return saved;
});

// ---------- hosts ----------
const STREAM_PROTOS = new Set(["tcp", "udp", "sni"]);
/** Stream/SNI hosts need a real listen port, and tcp/udp ports must be unique -
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
// isControlPlaneDomain (the SSO-portal hijack guard) is shared with the agent
// path from hostschema.ts - imported above, defined once.

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
  if (isControlPlaneDomain(parsed.data.domain, parsed.data.forwardPort)) {
    return reply.code(409).send({ error: "That's the domain NginUX itself runs on (Settings → public URL). To use it as your sign-in portal, forward it to the control plane on port 6767; otherwise pick another domain so you don't lose access to NginUX." });
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
  // If nginx rejected the new config, roll the host back out - keeping it would
  // leave a service that breaks nginx on the next restart. Re-apply to restore
  // the last-good state. (nginxAvailable=false means we couldn't validate, so we
  // don't punish the host for a missing nginx binary.)
  if (!apply.ok && apply.nginxAvailable) {
    deleteHost(host.id);
    await applyConfig();
    logEvent({ type: "host.create_failed", severity: "warn", actor: currentUser(req)?.username ?? "system", summary: `Couldn't expose ${host.name} (${host.domain}) - config rejected`, ip: clientIp(req), meta: { error: apply.message } });
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
  // Guard the control-plane-domain hijack against the MERGED result, not just a
  // domain change: a host already sitting on the portal domain can be broken by a
  // port-only edit (6767 -> 8080), repointing the sign-in server block and locking
  // everyone out. Fire whenever the result is a hijack AND domain or port actually
  // moved (a no-op re-PUT of an unrelated field must not be punished).
  const domainOrPortChanged = merged.domain !== existing.domain || merged.forwardPort !== existing.forwardPort;
  if (domainOrPortChanged && isControlPlaneDomain(merged.domain, merged.forwardPort)) {
    return reply.code(409).send({ error: "That's the domain NginUX itself runs on (Settings → public URL). To use it as your sign-in portal, forward it to the control plane on port 6767; otherwise pick another domain so you don't lose access to NginUX." });
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
    logEvent({ type: "host.update_failed", severity: "warn", actor: currentUser(req)?.username ?? "system", summary: `Reverted ${existing.name} (${existing.domain}) - config rejected`, ip: clientIp(req), meta: { id, error: apply.message } });
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
  // now unreferenced - remove it too. Best-effort: don't fail the delete on it.
  if (existing) { try { deleteCert(existing.domain); } catch { /* ignore */ } }
  const apply = await applyConfig();
  void syncGitOps(`Remove a service`);
  logEvent({ type: "host.deleted", severity: "warn", actor: currentUser(req)?.username ?? "system", summary: `Removed a service`, ip: clientIp(req), meta: { id } });
  return { ok: true, apply };
});

// Config-diff preview ("see exactly what changes"): generate the nginx config a
// proposed create/update/delete WOULD produce and diff it against what's live,
// WITHOUT writing or reloading. Admin/editor only - the diff spans the whole
// config set (every host's file), so it's the same sensitivity as the metrics feeds.
const previewInput = z.object({
  mode: z.enum(["create", "update", "delete"]),
  id: z.string().optional(),
  host: z.record(z.unknown()).optional(),
});
app.post("/api/config/preview", async (req, reply) => {
  if (!userRoleAtLeast(req, reply, "admin", "editor")) return undefined;
  const parsedReq = previewInput.safeParse(req.body);
  if (!parsedReq.success) return reply.code(400).send({ error: parsedReq.error.issues });
  const { mode, id, host } = parsedReq.data;
  const hosts = listHosts();
  let candidateHosts: ProxyHost[];

  if (mode === "delete") {
    if (!id || !getHost(id)) return reply.code(404).send({ error: "Service not found" });
    candidateHosts = hosts.filter((h) => h.id !== id);
  } else if (mode === "update") {
    if (!id) return reply.code(400).send({ error: "id is required to preview an update." });
    const existing = getHost(id);
    if (!existing) return reply.code(404).send({ error: "Service not found" });
    const parsed = hostInput.partial().safeParse(host ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const merged = { ...existing, ...parsed.data } as ProxyHost;
    candidateHosts = hosts.map((h) => (h.id === id ? merged : h));
  } else { // create
    const parsed = hostInput.safeParse(host ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const candidate = { ...parsed.data, id: "__preview__", health: "unknown", certExpiresAt: null, createdAt: "", updatedAt: "" } as ProxyHost;
    candidateHosts = [...hosts, candidate];
  }
  return previewConfigForHosts(candidateHosts);
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
  return reply.type("text/plain").send(redactConfig(conf)); // never expose the forward-auth secret in the config preview
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
app.get("/api/config/versions", async (req, reply) => {
  if (!requireRole(req, reply, "admin", "editor")) return; // restore points expose every host domain + who changed what
  return listVersions();
});
app.post("/api/config/versions", async (req, reply) => {
  if (!requireRole(req, reply, "admin", "editor")) return;
  const { label } = z.object({ label: z.string().max(120).default("Manual snapshot") }).parse(req.body ?? {});
  return snapshot(label, currentUser(req)?.username ?? "admin");
});
app.get("/api/config/versions/:id/diff", async (req, reply) => {
  if (!requireRole(req, reply, "admin", "editor")) return; // diffs expose full host configs
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
app.get("/api/gitops/log", async (req, reply) => {
  if (!requireRole(req, reply, "admin", "editor")) return;
  return gitLog();
});

// ---------- topology + traffic (dashboard) ----------
app.get("/api/topology", async (req) => {
  const s = getSettings();
  // Scoped users only see their own services in the map (mirrors /api/hosts).
  const u = currentUser(req);
  const hosts = u?.role === "scoped" ? listHosts().filter((h) => scopedAllows(u, h)) : listHosts();
  return getTopology({ publicIp: s.publicIp, gatewayIp: s.gatewayIp }, hosts);
});

app.get("/api/traffic", async (req, reply) => {
  if (!userRoleAtLeast(req, reply, "admin", "editor")) return undefined; // per-host traffic (host param) - admin/editor like the other metrics
  const { range = "live", metric = "requests", host } = req.query as { range?: string; metric?: string; host?: string };
  return trafficSeries(range, metric === "bandwidth" ? "bandwidth" : "requests", host || undefined);
});

// ---------- logs + metrics ----------
app.get("/api/metrics/summary", async (req, reply) => {
  if (!userRoleAtLeast(req, reply, "admin", "editor")) return undefined;
  const range = (req.query as { range?: string }).range;
  // A range scopes every panel to that window; no range = cumulative snapshot.
  return range ? metricsRangeSummary(range) : metricsSummary();
});
// Per-service analytics summary (requests/bandwidth/p95/error-rate + status,
// top IPs/paths/countries) for one host, computed on demand. Admin/editor only
// since it carries client IPs, matching /metrics/summary and /logs.
app.get("/api/metrics/host/:domain", async (req, reply) => {
  if (!userRoleAtLeast(req, reply, "admin", "editor")) return undefined;
  const { domain } = req.params as { domain: string };
  if (!isHostname(domain)) return reply.code(400).send({ error: "Invalid domain." });
  const range = (req.query as { range?: string }).range ?? "1d";
  return metricsHostSummary(domain, range);
});
app.get("/api/metrics/hosts", async (req, reply) => {
  // Per-host traffic reveals which services exist + their volume; gate it to
  // admin/editor like every other metrics route, so a scoped/readonly user can't
  // enumerate out-of-scope hosts through the Network Map.
  if (!userRoleAtLeast(req, reply, "admin", "editor")) return undefined;
  const { range = "live", metric = "requests" } = req.query as { range?: string; metric?: string };
  return hostTraffic(range, metric === "bandwidth" ? "bandwidth" : "requests");
});
app.get("/api/metrics/host-stats", async (req, reply) => {
  if (!userRoleAtLeast(req, reply, "admin", "editor")) return undefined;
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
  } catch { /* offline or blocked - fine */ }

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
// Best-effort public-IP (and country) auto-detection via outbound echo services.
// Fixed, trusted endpoints - never user-supplied - so this isn't an SSRF vector.
async function detectPublicIp(): Promise<{ ip: string | null; country: string | null }> {
  let ip: string | null = null, country: string | null = null;
  try {
    const r = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(3000) });
    if (r.ok) { const t = (await r.text()).trim(); if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) ip = t; }
  } catch { /* offline or blocked */ }
  if (ip) {
    // Country auto-detect from the public IP - no MaxMind DB needed (that's only
    // for filtering inbound traffic). Try a couple of free, keyless providers in
    // order so a rate-limit / hiccup on one still fills the field. Fixed,
    // trusted endpoints (the IP is regex-validated above), so not an SSRF vector.
    const sources = [
      `https://ipapi.co/${ip}/country/`, // plain text, 2-letter code
      `https://api.country.is/${ip}`,    // JSON { country: "US" } - works server-side
    ];
    for (const url of sources) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (!r.ok) continue;
        let cc = "";
        if ((r.headers.get("content-type") || "").includes("json")) {
          const j = (await r.json()) as { country?: string; country_code?: string };
          cc = String(j.country ?? j.country_code ?? "").trim().toUpperCase();
        } else {
          cc = (await r.text()).trim().toUpperCase();
        }
        if (/^[A-Z]{2}$/.test(cc)) { country = cc; break; }
      } catch { /* try the next provider */ }
    }
  }
  return { ip, country };
}

// Auto-detect this host's public IP (+ country) so the user doesn't have to look
// it up - they can still override it manually in Settings.
app.get("/api/network/detect-ip", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  return detectPublicIp();
});

// Search the dashboard-icons logo catalog (homarr-labs/dashboard-icons via jsdelivr)
// so a service can use a real app logo instead of an emoji. We proxy the metadata
// index (cached ~1 day) and return matching {name, url}; the CDN images themselves
// load directly in the browser (allowed in the CSP img-src).
const ICON_CDN = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons";
let iconIndex: { name: string; base: string; aliases: string[] }[] | null = null;
let iconIndexAt = 0;
async function getIconIndex(): Promise<typeof iconIndex> {
  if (iconIndex && Date.now() - iconIndexAt < 24 * 3600_000) return iconIndex;
  const r = await fetch(`${ICON_CDN}/metadata.json`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("icon catalog unavailable");
  const meta = (await r.json()) as Record<string, { base?: string; aliases?: string[] }>;
  iconIndex = Object.entries(meta).map(([name, m]) => ({ name, base: m.base || "svg", aliases: m.aliases ?? [] }));
  iconIndexAt = Date.now();
  return iconIndex;
}
app.get("/api/icons", async (req, reply) => {
  if (!userRoleAtLeast(req, reply, "admin", "editor")) return;
  const q = String((req.query as { q?: string }).q ?? "").trim().toLowerCase();
  if (q.length < 1) return [];
  try {
    const idx = (await getIconIndex()) ?? [];
    const rank = (n: string) => (n === q ? 0 : n.startsWith(q) ? 1 : 2);
    return idx
      .filter((i) => i.name.includes(q) || i.aliases.some((a) => a.toLowerCase().includes(q)))
      .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
      .slice(0, 60)
      .map((i) => ({ name: i.name, url: `${ICON_CDN}/${i.base}/${i.name}.${i.base}` }));
  } catch { return reply.code(502).send({ error: "Couldn't reach the icon catalog." }); }
});

app.get("/api/metrics/traffic", async (req, reply) => {
  if (!userRoleAtLeast(req, reply, "admin", "editor")) return undefined;
  const { range = "1d" } = req.query as { range?: string };
  return trafficSeries(range);
});
app.get("/api/metrics/prometheus", async (req, reply) => {
  if (!requireRoleOrScope(req, reply, ["admin", "editor"], "report")) return;
  return reply.type("text/plain; version=0.0.4").send(prometheus());
});
const clampLimit = (raw?: string): number | undefined =>
  raw ? Math.min(1000, Math.max(1, Number(raw) || 1)) : undefined;

app.get("/api/logs/recent", async (req, reply) => {
  if (!requireRoleOrScope(req, reply, ["admin", "editor"], "report")) return; // access logs carry client IPs; token needs 'report' (mirrors the recent_logs MCP tool)
  const { filter, limit } = req.query as { filter?: string; limit?: string };
  // A filter (e.g. clicking an IP on the traffic map) searches the persisted log
  // on disk so older IPs still resolve; an unfiltered tail uses the live ring.
  return filter ? searchLog(filter, clampLimit(limit)) : recentLogs(undefined, clampLimit(limit));
});
let sseClients = 0;
const SSE_MAX = Number(process.env.NGINUX_SSE_MAX ?? 200);

app.get("/api/logs/stream", (req, reply) => {
  if (!requireRoleOrScope(req, reply, ["admin", "editor"], "report")) return; // live access logs carry client IPs; token needs 'report'
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
// throttled even when requests bypass nginx and hit port 6767 directly.
const LOGIN_MAX = 10;          // attempts per minute, per (ip + username)
const LOGIN_IP_MAX = 30;       // attempts per minute, per IP across all usernames
const LOGIN_WINDOW_MS = 60_000; // window
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
  if (loginHits.size > 5000) { // cap so the map can't grow unbounded
    for (const [k, v] of loginHits) { if (v.every((t) => now - t >= windowMs)) loginHits.delete(k); }
    // If a distinct-key flood outpaces expiry, hard-evict oldest-inserted keys
    // (Map preserves insertion order) so memory stays bounded under abuse.
    while (loginHits.size > 5000) { const k = loginHits.keys().next().value; if (k === undefined) break; loginHits.delete(k); }
  }
  return hits.length > max;
}

/** Cookie Domain for the session cookie - the configured ssoCookieDomain, or
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

// Bound the inputs: username/password are attacker-controlled and each login
// attempt runs a deliberately-expensive scrypt, so an unbounded password also
// amplifies CPU. (Length caps are generous; real creds fit easily.)
const loginInput = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200), token: z.string().max(64).optional() });
app.post("/api/auth/login", async (req, reply) => {
  const parsed = loginInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
  const { username, password, token } = parsed.data;
  const ip = clientIp(req);

  // Per-IP budget, independent of username: the username is attacker-controlled, so
  // keying the limiter only on ip+username would let one IP get a fresh allowance
  // per guessed username and force unbounded scrypt work. This caps total attempts
  // (hence scrypt calls) from a single source regardless of the usernames tried.
  if (rateLimited(`ipall:${ip}`, LOGIN_IP_MAX, LOGIN_WINDOW_MS)) {
    logEvent({ type: "login.failed", severity: "warn", actor: username, summary: "Too many login attempts from this IP - throttled", ip, meta: { throttled: true } });
    return reply.code(429).send({ error: "Too many attempts. Wait a minute and try again." });
  }
  if (rateLimited(`${ip}:${username}`.toLowerCase(), LOGIN_MAX, LOGIN_WINDOW_MS)) {
    logEvent({ type: "login.failed", severity: "warn", actor: username, summary: "Too many login attempts - throttled", ip, meta: { throttled: true } });
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
      logEvent({ type: "login.failed", severity: "warn", actor: username, summary: "2FA locked - too many wrong codes", ip, meta: {} });
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
// The shared secret lives in the DB (Settings → Login gate) and is auto-generated
// on boot if unset. nginx.ts reads the same value when it stamps the header onto
// each forward-auth subrequest.
const forwardSecret = (): string => getSettings().ssoForwardSecret;
/** Constant-time header-secret check (avoids a byte-by-byte timing oracle). */
function forwardSecretOk(hdr: unknown, secret: string): boolean {
  if (!secret) return true; // no secret configured → header not required
  if (typeof hdr !== "string" || hdr.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(hdr), Buffer.from(secret));
}
app.get("/api/auth/forward", async (req, reply) => {
  if (!forwardSecretOk(req.headers["x-nginux-forward-secret"], forwardSecret())) {
    return reply.code(401).send({ ok: false });
  }
  const u = currentUser(req);
  if (!u) return reply.code(401).send({ ok: false });
  // A temporary/default-credential session (admin/admin on a fresh install) is
  // confined to the change-password flow on the control plane; it must NOT satisfy
  // per-host login gates either, or default creds would reach every backend app.
  if (u.mustChangePassword) return reply.code(401).send({ ok: false });
  // If we can identify the target host, enforce its per-host requirements.
  const originalHost = (req.headers["x-original-host"] as string) || (req.headers["x-forwarded-host"] as string);
  if (originalHost) {
    const host = getHostByDomainCached(originalHost.split(":")[0]);
    if (host) {
      if (host.require2fa && !u.twofaEnabled) return reply.code(401).send({ ok: false });
      // A scoped user only passes the per-host login gate for hosts in their
      // scope - otherwise one NginUX login would unlock every protected app.
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
    return reply.code(400).send({ error: "That code didn't match - try the current one." });
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

// ---------- profile avatar ----------
// The client sends a small, already-resized data URL, so we never need an image
// library server-side - just validate, sniff, and write the bytes to the volume.
app.post("/api/users/me/avatar", async (req, reply) => {
  const me = currentUser(req);
  if (!me) return reply.code(401).send({ error: "Not signed in" });
  const parsed = z.object({ image: z.string().min(1).max(1_600_000) }).safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "Missing image data." });
  const m = /^data:image\/(?:png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(parsed.data.image.trim());
  if (!m) return reply.code(415).send({ error: "Unsupported image - use a PNG, JPEG, or WebP file." });
  let buf: Buffer;
  try { buf = Buffer.from(m[1], "base64"); } catch { return reply.code(400).send({ error: "Couldn't decode the image." }); }
  if (!buf.length || !sniffImageType(buf)) return reply.code(415).send({ error: "That doesn't look like a valid image." });
  if (buf.length > AVATAR_MAX_BYTES) return reply.code(413).send({ error: "Image is too large - keep it under 700 KB." });
  mkdirSync(AVATAR_DIR, { recursive: true });
  writeFileSync(avatarPath(me.id), buf);
  return { ok: true };
});

// Serve a user's avatar (any signed-in user - avatars show next to names).
app.get("/api/users/:id/avatar", async (req, reply) => {
  if (!currentUser(req)) return reply.code(401).send({ error: "Not signed in" });
  const { id } = req.params as { id: string };
  const p = avatarPath(id);
  if (!existsSync(p)) return reply.code(404).send({ error: "No avatar." });
  const buf = readFileSync(p);
  // Private to the session and short-lived; the client cache-busts with ?v= on change.
  return reply.header("Content-Type", sniffImageType(buf) ?? "application/octet-stream").header("Cache-Control", "private, max-age=60").send(buf);
});

// Remove the signed-in user's avatar (revert to the initial).
app.delete("/api/users/me/avatar", async (req, reply) => {
  const me = currentUser(req);
  if (!me) return reply.code(401).send({ error: "Not signed in" });
  rmSync(avatarPath(me.id), { force: true });
  return { ok: true };
});

app.get("/api/sessions", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  // Never return the raw session token to the client - mask to a short id.
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

// Live ACME activity feed for the Certificates page - everything NginUX and
// acme-client did while talking to Let's Encrypt, so failures aren't a black box.
app.get("/api/acme/log", async (req, reply) => {
  if (!requireRole(req, reply, "admin", "editor")) return;
  const since = Number((req.query as { since?: string }).since ?? 0) || 0;
  return getAcmeActivity(since);
});

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
  logEvent({ type: "token.revoked", severity: "notice", actor: currentUser(req)?.username ?? "admin", summary: `Revoked API token ${id}`, ip: clientIp(req), meta: { id } });
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
  logEvent({ type: "webhook.created", severity: "notice", actor: currentUser(req)?.username ?? "admin", summary: `Created webhook → ${parsed.data.url}`, ip: clientIp(req), meta: { id: webhook.id, events: parsed.data.events } });
  return reply.code(201).send({ webhook, secret }); // secret shown once
});
app.delete("/api/webhooks/:id", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const { id } = req.params as { id: string };
  deleteWebhook(id);
  logEvent({ type: "webhook.deleted", severity: "notice", actor: currentUser(req)?.username ?? "admin", summary: `Deleted webhook ${id}`, ip: clientIp(req), meta: { id } });
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
      minSeverity: z.enum(["info", "notice", "warn", "danger"]).default("info"),
    })
    .safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  const body = parsed.data;
  // SSRF guard: any user-supplied destination URL must be a safe http(s) target.
  for (const key of ["url", "server"]) {
    const v = body.config[key];
    if (v) { try { assertSafeOutboundUrl(v); } catch (e) { return reply.code(400).send({ error: e instanceof Error ? e.message : "Invalid URL." }); } }
  }
  const ch = createChannel({ type: body.type as ChannelType, name: body.name, config: body.config, events: body.events, minSeverity: body.minSeverity });
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
// Edit a channel's routing: which event types + the severity floor it alerts on.
app.put("/api/channels/:id/routing", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const { id } = req.params as { id: string };
  const parsed = z.object({
    events: z.array(z.string().max(64)).max(50).optional(),
    minSeverity: z.enum(["info", "notice", "warn", "danger"]).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  const ch = setChannelRouting(id, parsed.data);
  if (!ch) return reply.code(404).send({ error: "Channel not found" });
  return ch;
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
  // The live audit/security feed (login-failure client IPs, bans, user changes) -
  // same sensitivity as the pull endpoint /api/audit, so gate it identically
  // (admin/editor session, or a 'report'-scoped token). Without this any session
  // or token gets the full security event stream.
  if (!requireRoleOrScope(req, reply, ["admin", "editor"], "report")) return;
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

export { app }; // exported so tests can drive routes via app.inject() (no listener)

// Bind the port + start the schedulers ONLY when this file is the entry point
// (npm start / the container). When a test imports index.ts, the app + routes are
// built but stay inert - no port bound, no background timers running.
if (import.meta.main) {
app.listen({ port: PORT, host: HOST }).then(async () => {
  app.log.info(`NginUX control plane on http://${HOST}:${PORT}`);
  if (seeded.usingDefault) {
    app.log.warn(`First run - default login is "admin" / "admin". You'll be required to set a new password on first sign-in.`);
  }
  if (process.env.NODE_ENV === "production" && !forwardSecret()) {
    app.log.warn("No forward-auth secret set - generate one in Settings → Login gate so /api/auth/forward can't be invoked directly. Per-host login gates are weaker without it.");
  }
  // Render the data plane + replay metrics history on boot. Isolated in its own
  // try/catch: a failure here (e.g. EACCES/EROFS on the data volume, or an
  // unreadable access log) must NOT abort the scheduler startup below - otherwise
  // a single boot hiccup would silently leave the instance with no cert renewal,
  // uptime monitoring, auto-ban, or log rotation.
  try {
    const result = await applyConfig();
    app.log.info(`nginx apply on boot: ${result.message}`);
    // Metrics: replay persisted access-log history so it survives restarts.
    const replayed = replayAccessLog();
    if (replayed) app.log.info(`metrics: replayed ${replayed} access-log lines from disk (history survives restarts)`);
  } catch (err) {
    app.log.error({ err }, "boot data-plane render/replay failed - continuing so schedulers still start");
  }
  // Daily auto-renewal + cert status refresh.
  startRenewalScheduler();
  // Release checker (GitHub releases; respects the Settings toggle).
  startUpdateChecker();
  // Metrics: tail nginx access logs; only feed synthetic traffic when explicitly
  // asked (NGINUX_DEMO_TRAFFIC=1) or in an explicit dev run - never silently in prod.
  startLogTailer();
  const devRun = process.execArgv.includes("--watch"); // `npm run dev`, never `start`
  if (process.env.NGINUX_DEMO_TRAFFIC === "1" || devRun) {
    startDemoTraffic();
    app.log.info("demo traffic generator on - feeding the metrics pipeline");
  }
  // Uptime monitoring + alert routing + brute-force auto-ban.
  startUptimeMonitor();
  initAlertEngine();
  startBanEngine();
  // Keep the audit log bounded.
  pruneAuditLog();
  setInterval(() => { try { pruneAuditLog(); } catch { /* ignore */ } }, 24 * 3600_000).unref?.();
  // Keep the on-disk nginx logs bounded (size-based rotation per Settings -> Logs).
  startLogRotation();
}).catch((err) => {
  // listen() itself failed (e.g. port in use) - fail fast and loud instead of
  // lingering as a half-started process that never accepts connections.
  app.log.fatal({ err }, "failed to start NginUX control plane");
  process.exit(1);
});
}

// ---------- graceful shutdown ----------
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`${signal} received - shutting down gracefully`);
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

