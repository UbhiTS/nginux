import { connect, isIP } from "node:net";
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
  getServingHttpHostByDomainCached,
  getTopology,
  listHosts,
  replaceAllHosts,
  updateHost,
} from "./repo.ts";
import { applyConfig, buildDesiredConfigs, generateHostConfig, generateStreamConfig, previewConfigForHosts, redactConfig } from "./nginx.ts";
import { buildNotifications } from "./notifications.ts";
import { writeGeoipConf } from "./geoip.ts";
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
  destroyUserSessions,
  dismissNotificationsForUser,
  enableTwofa,
  getDismissedNotifications,
  getLastTotpCounter,
  getPendingTwofaSecret,
  getTwofaSecret,
  getUserById,
  listSessions,
  listUsers,
  revokeSession,
  resetTwofa,
  sessionSid,
  countAdmins,
  updateUserRole,
  logEvent,
  parseCookie,
  parseCookieAll,
  scopedAllows,
  seedAuthIfEmpty,
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
import { startUpdateChecker } from "./update.ts";
import {
  deleteCert,
  ensureCert,
  reconcileImportedCerts,
  startRenewalScheduler,
} from "./certs.ts";
import {
  bearerFrom,
  resolveToken,
  seedTokensIfEmpty,
  type Scope,
} from "./tokens.ts";
import { scopesForRole, type Principal } from "./tools.ts";
import { subscribe } from "./events.ts";
import { seedBuiltinProfiles } from "./profiles.ts";
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
import { importNginxConf, previewNginxConf } from "./importer.ts";
import { buildBundle, restoreBundle } from "./backup.ts";
import { encryptJsonAsync, decryptJsonAsync, isEncryptedEnvelope } from "./cryptobox.ts";
import { listBans, replaceAllBans, startBanEngine, writeBannedConf } from "./bans.ts";
import { ensureClientCA, issueClientCert, listClientCerts, revokeClientCert, writeClientCrl } from "./clientcerts.ts";
import { generateSniPassthrough } from "./nginx.ts";
import {
  isDangerousHost,
  isHost,
  isHostname,
} from "./validate.ts";
import {
  type HostInput,
  controlPlaneTargetError,
  frontsControlPlane,
  hostInput,
  isControlPlaneDomain,
  normalizeProtocolFields,
  protocolCapabilityError,
  protocolSupportsHttpControls,
  publishesThisControlPlane,
  streamPortConflictError,
} from "./hostschema.ts";
import { INSTANCE_ID } from "./instance.ts";
import { settingsInput } from "./settingsschema.ts";
import { realmForHost } from "./realms.ts";
import { type RouteCtx, clampLimit } from "./routes/context.ts";
import { registerUpdateRoutes } from "./routes/update.ts";
import { registerGeoipRoutes } from "./routes/geoip.ts";
import { registerTokenRoutes } from "./routes/tokens.ts";
import { registerProfileRoutes } from "./routes/profiles.ts";
import { registerWebhookRoutes } from "./routes/webhooks.ts";
import { registerChannelRoutes } from "./routes/channels.ts";
import { registerSecurityRoutes } from "./routes/security.ts";
import { registerAgentRoutes } from "./routes/agents.ts";
import { registerCertRoutes } from "./routes/certs.ts";
import { initAlertEngine, listChannelsRaw, replaceAllChannels } from "./notify.ts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { resolveSafeOutboundHost } from "./outbound.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 6767);
// Local/source starts are loopback-only unless the operator explicitly opts in.
// The container sets HOST=0.0.0.0 itself, behind Compose's loopback port bind.
const HOST = process.env.HOST ?? "127.0.0.1";

seedIfEmpty();
// The forward-auth shared secret is managed entirely in the DB now (no env var).
// Generate one automatically if it's unset so the login gate is protected by
// default - admins can rotate it anytime from Settings → Login gate.
if (!getSettings().ssoForwardSecret) {
  saveSettings({ ssoForwardSecret: randomBytes(24).toString("hex") });
}
const seeded = await seedAuthIfEmpty();
if (seeded.bootstrapPassword) {
  // Emit immediately after the DB commit, before any later boot step can fail.
  // This is intentionally one-time output; the plaintext is never stored.
  process.stderr.write(`[nginux] first-run admin password: ${seeded.bootstrapPassword}\n`);
  process.stderr.write("[nginux] sign in as admin and replace this bootstrap password immediately.\n");
}
seedTokensIfEmpty();
seedBuiltinProfiles(); // idempotent starter security profiles
writeGeoipConf(); // keep the country-lock include in sync with settings on boot
writeBannedConf(); // regenerate banned.conf in the geo-map format BEFORE the boot apply,
                   // so an instance upgraded from the old `deny`-line format can't fail
                   // `nginx -t` on the new `if ($nginux_banned)` server-scope check.
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
const sessionTokenCache = new WeakMap<FastifyRequest, string>();
/** The session token this request authenticated with (first `nginux_session` cookie
 *  value that resolves to a live session), or "" when none did. */
const sessionTokenOf = (req: FastifyRequest): string => {
  currentUser(req);
  return sessionTokenCache.get(req) ?? "";
};
const currentUser = (req: FastifyRequest): User | null => {
  const cached = userCache.get(req);
  if (cached !== undefined) return cached;
  // A sibling app served through the proxy (or a stale host-only cookie) can add a
  // second `nginux_session` cookie to the same request; try each value in order and
  // keep the first that resolves, instead of letting the last one shadow a valid login.
  let u: User | null = null;
  for (const tok of parseCookieAll(req.headers.cookie, SESSION_COOKIE)) {
    u = userForSession(tok);
    if (u) { sessionTokenCache.set(req, tok); break; }
  }
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
// The client IP feeds audit rows, login rate-limit keys and the auto-ban engine (which
// writes it into nginx config). Fastify derives req.ip from X-Forwarded-For when the
// peer is trusted, and that header is free text — so accept it only when it parses as
// an IP address and otherwise fall back to the socket peer. (Security audit 2026-10-01.)
const clientIp = (req: FastifyRequest): string => {
  const ip = String(req.ip ?? "").trim();
  if (isIP(ip)) return ip;
  const peer = String(req.socket?.remoteAddress ?? "").trim();
  return isIP(peer) ? peer : "";
};
const device = (req: FastifyRequest) => (req.headers["user-agent"] as string)?.slice(0, 120) || "unknown";

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  trustProxy: TRUST_PROXY,
  bodyLimit: 2 * 1024 * 1024, // 2 MB - generous for config import, bounded for safety
  requestTimeout: 30_000,
  // Reject JSON bodies carrying `__proto__` / `constructor` keys at the parser instead of
  // relying on every downstream merge to be prototype-safe. (Security audit 2026-10-01.)
  onProtoPoisoning: "error",
  onConstructorPoisoning: "error",
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
// While a manager owes 2FA enrollment (require2faForManagers policy), only these are.
const TWOFA_ENROLL_ALLOWED = new Set(["/api/auth/2fa/setup", "/api/auth/2fa/verify", "/api/auth/logout", "/api/auth/me"]);
/** Is this user compelled to enroll in 2FA right now? Managers (admin/editor)
 *  without 2FA, when the org policy requires it. Computed from settings, not stored. */
function mustEnroll2fa(u: User): boolean {
  return getSettings().require2faForManagers && (u.role === "admin" || u.role === "editor") && !u.twofaEnabled;
}
/** Attach computed policy flags to a user before it's sent to the client. */
function withPolicyFlags(u: User): User {
  return { ...u, mustEnable2fa: mustEnroll2fa(u) };
}
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** CSRF defense: a cookie-authenticated mutation carrying a cross-origin
 *  Origin/Referer is rejected. Browsers always send Origin on cross-site
 *  writes; native clients (no Origin header) and Bearer agents are unaffected. */
function crossOriginBlocked(req: FastifyRequest): boolean {
  if (!MUTATING.has(req.method)) return false;
  const origin = (req.headers.origin as string) || (req.headers.referer as string);
  if (!origin) return false; // non-browser client
  // Fastify only derives req.host from X-Forwarded-Host when the immediate peer
  // is trusted. Reading the raw header here would let a direct client choose the
  // comparison host and neutralize this origin check.
  const host = req.host;
  try { return new URL(origin).host !== host; } catch { return true; }
}

const BEARER_FAIL_MAX = 30;
const BEARER_FAIL_WINDOW_MS = 60_000;
const bearerFailHits = new Map<string, number[]>();
function bearerRateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (bearerFailHits.get(ip) ?? []).filter((t) => now - t < BEARER_FAIL_WINDOW_MS);
  hits.push(now);
  if (hits.length > BEARER_FAIL_MAX + 1) hits.splice(0, hits.length - (BEARER_FAIL_MAX + 1));
  bearerFailHits.set(ip, hits);
  if (bearerFailHits.size > 5000) {
    for (const [k, v] of bearerFailHits) { if (v.every((t) => now - t >= BEARER_FAIL_WINDOW_MS)) bearerFailHits.delete(k); }
    while (bearerFailHits.size > 5000) { const k = bearerFailHits.keys().next().value; if (k === undefined) break; bearerFailHits.delete(k); }
  }
  return hits.length > BEARER_FAIL_MAX;
}

/** The request path the GUARD must reason about. find-my-way routes on the
 *  percent-DECODED path, so `GET /%61pi/hosts` is dispatched to the `/api/hosts`
 *  handler - but `req.url` still reads `/%61pi/hosts`. Keying the auth guard on the
 *  raw prefix let that spelling skip authentication, CSRF and onboarding
 *  confinement entirely (security audit 2026-10-01). Use the matched route pattern
 *  (`/api/hosts/:id`), and fall back to the decoded raw path when no route matched
 *  (404s), so an unauthenticated probe of a non-existent API path gets 401 rather
 *  than a route-enumeration oracle. */
function guardPath(req: FastifyRequest): string {
  const routed = req.routeOptions?.url;
  if (routed && routed !== "/*" && routed !== "*") return routed;
  const raw = req.url.split("?")[0];
  try { return decodeURIComponent(raw); } catch { return raw; }
}
const isApiRequest = (req: FastifyRequest): boolean => guardPath(req).startsWith("/api");

app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
  if (!isApiRequest(req)) return;
  const path = guardPath(req);
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
    if (!principal(req)) {
      if (bearerFrom(req.headers.authorization) && bearerRateLimited(clientIp(req))) {
        return reply.code(429).send({ error: "Too many invalid API token attempts. Wait a minute and try again." });
      }
      return reply.code(401).send({ error: "Valid session or API token required" });
    }
    // A cookie user with a temporary password is still confined, even via MCP.
    const cu = currentUser(req);
    if (cu?.mustChangePassword) {
      if (!PW_CHANGE_ALLOWED.has(path)) {
        return reply.code(403).send({ error: "Set a new password before continuing.", mustChangePassword: true });
      }
      // Password onboarding is the first gate. Do not simultaneously apply the
      // manager-2FA gate or each flow blocks the other's endpoint.
      return;
    }
    if (cu && mustEnroll2fa(cu) && !TWOFA_ENROLL_ALLOWED.has(path)) {
      return reply.code(403).send({ error: "Two-factor authentication is required for your role.", mustEnable2fa: true });
    }
    return;
  }
  const u = currentUser(req);
  if (!u) return reply.code(401).send({ error: "Authentication required" });
  // A temporary-password account is confined to the change-password flow until it
  // sets a real password - enforced here, not just in the SPA.
  if (u.mustChangePassword) {
    if (!PW_CHANGE_ALLOWED.has(path)) {
      return reply.code(403).send({ error: "Set a new password before continuing.", mustChangePassword: true });
    }
    // Finish replacing the temporary credential before evaluating whether this
    // role must enroll in 2FA. The returned user then transitions to that gate.
    return;
  }
  // Managers owing 2FA enrollment (require2faForManagers) are confined to the
  // enrollment flow until it's set up - enforced server-side, not just in the SPA.
  if (mustEnroll2fa(u) && !TWOFA_ENROLL_ALLOWED.has(path)) {
    return reply.code(403).send({ error: "Two-factor authentication is required for your role.", mustEnable2fa: true });
  }
});

// Security headers on every control-plane response (the admin UI + API on :6767).
// frame-ancestors/X-Frame-Options stop the UI being framed (clickjacking); nosniff
// stops MIME sniffing; the CSP locks script/style/connect to same-origin.
app.addHook("onSend", async (req, reply, payload) => {
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // Keyed on the DECODED/routed path (see guardPath): `/%61pi/...` is an API response too.
  if (isApiRequest(req)) reply.header("Cache-Control", "no-store");
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
  // `upstreams` is already forbidden; the primary forward host/scheme/PORT and
  // domain must be too. A port-only change is still an SSRF pivot: a scoped user
  // could repoint their benign app hostname at Docker (2375), Portainer, or another
  // admin daemon on the same machine and reach it through their allowed service.
  "forwardHost", "forwardPort", "forwardScheme", "upstreamTlsVerify", "domain", "ssl",
  // Mirror the agent path's FORBIDDEN_TOOL_FIELDS: `protocol`/`listenPort` could turn a
  // login-gated HTTP host into an un-gated TCP/UDP/SNI stream (no auth_request), and
  // `preset` can disable exploit-path blocking — posture, not management.
  "protocol", "listenPort", "preset",
] as const;

function rejectPrivilegedFields(req: FastifyRequest, reply: FastifyReply, body: Record<string, unknown>): boolean {
  const role = currentUser(req)?.role;
  // Raw nginx directives are an admin-only escape hatch.
  if (body.customNginx !== undefined && role !== "admin") {
    if (body.customNginx !== "") {
      reply.code(403).send({ error: "Only an admin may set custom nginx directives." });
      return false;
    }
    // Non-admin host DTOs deliberately redact this field to an empty string. A
    // full-form PUT must not turn that redaction into deletion of an admin's
    // existing directives, so ignore the empty placeholder rather than writing it.
    delete body.customNginx;
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

/** Raw custom nginx commonly contains upstream Authorization/API credentials.
 * Only admins may read it; every other role receives an empty, non-replayable
 * placeholder and the PUT boundary above preserves the stored value. */
function hostForCaller(req: FastifyRequest, host: ProxyHost): ProxyHost {
  return currentUser(req)?.role === "admin" ? host : { ...host, customNginx: "" };
}

/** For routes reachable by agent tokens OR users: token principals pass (their
 *  scope is enforced separately); a user session must hold one of `roles`.
 *  Fails CLOSED when the request carries neither identity: the preHandler is
 *  expected to have rejected such a request already, but a route-level helper must
 *  not silently become "allow" if the guard is ever bypassed or re-keyed. */
function userRoleAtLeast(req: FastifyRequest, reply: FastifyReply, ...roles: Role[]): boolean {
  const u = currentUser(req);
  if (u && !roles.includes(u.role)) {
    reply.code(403).send({ error: `This action requires one of: ${roles.join(", ")}.` });
    return false;
  }
  if (!u && !principal(req)) {
    reply.code(401).send({ error: "Authentication required" });
    return false;
  }
  return true;
}

// Shared identity/role helpers handed to each extracted route group. Defined here
// (index.ts owns the Fastify instance + the auth preHandler); the register calls
// are near the bottom, after the core routes that still live inline.
const routeCtx: RouteCtx = { currentUser, requireAdmin, requireRole, userRoleAtLeast, clientIp };

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

// ---------- health ----------
app.get("/api/health", async (_req, reply) => {
  const db = dbOk();
  return reply.code(db ? 200 : 503).send({
    status: db ? "ok" : "degraded",
    service: "nginux",
    version: VERSION,
    db,
    time: new Date().toISOString(),
    // Random per-boot id: lets the control-plane self-probe (hostschema.ts
    // targetIsThisControlPlane) recognise THIS instance when a proposed upstream is
    // the Docker host's LAN address or a remapped published port. Not a secret and
    // not stable across restarts, so it identifies nothing about the deployment.
    instance: INSTANCE_ID,
  });
});

// ---------- notifications (actionable heads-up banners) ----------
app.get("/api/notifications", async (req, reply) => {
  const u = currentUser(req);
  if (!u) return reply.code(401).send({ error: "Not signed in" });
  const isManager = u.role === "admin" || u.role === "editor";
  const canSee = u.role === "scoped" ? (h: { id: string; name: string; domain: string }) => scopedAllows(u, h) : undefined;
  const all = await buildNotifications({ isManager, canSee });
  const dismissed = new Set(getDismissedNotifications(u.id));
  return all.filter((n) => !(n.dismissible && dismissed.has(n.id)));
});

const dismissNotificationInput = z.object({
  id: z.string().trim().min(1).max(256).optional(),
  ids: z.array(z.string().trim().min(1).max(256)).max(200).optional(),
}).refine((d) => Boolean(d.id || (d.ids && d.ids.length > 0)), {
  message: "Provide 'id' or non-empty 'ids'",
});

app.post("/api/notifications/dismiss", async (req, reply) => {
  const u = currentUser(req);
  if (!u) return reply.code(401).send({ error: "Not signed in" });
  const parsed = dismissNotificationInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  const toDismiss = [
    ...(parsed.data.id ? [parsed.data.id] : []),
    ...(parsed.data.ids ?? []),
  ];
  const dismissed = dismissNotificationsForUser(u.id, toDismiss);
  return { ok: true, dismissed };
});

// ---------- presets ----------
app.get("/api/presets", async () => Object.values(PRESETS));

// ---------- settings ----------
// settingsInput (the write-validation schema) lives in settingsschema.ts, shared
// verbatim with the agent update_settings tool so the two paths can't drift.

app.get("/api/settings", async (req) => {
  const s = getSettings();
  // Only admins see provider credentials; everyone else gets them masked.
  return currentUser(req)?.role === "admin" ? s : redactSettings(s);
});
app.put("/api/settings", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const parsed = settingsInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  const prevSettings = getSettings();
  const saved = saveSettings(parsed.data);
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
  if (geoChanged || parsed.data.ssoLoginUrl !== undefined || parsed.data.ssoForwardSecret !== undefined || parsed.data.ssoRealms !== undefined) {
    const apply = await applyConfig();
    if (!apply.ok && apply.nginxAvailable) {
      saveSettings(prevSettings);
      if (geoChanged) writeGeoipConf();
      await applyConfig();
      logEvent({ type: "settings.update_failed", severity: "warn", actor: currentUser(req)?.username ?? "admin", summary: "Reverted settings - nginx rejected config", ip: clientIp(req), meta: { error: apply.message } });
      return reply.code(422).send({ error: apply.message, apply });
    }
  }
  // Audit which settings changed (keys only - values may be secrets). Security-
  // relevant toggles like agentAutoApprove / ssoForwardSecret must leave a trail.
  const changedKeys = Object.keys(parsed.data);
  if (changedKeys.length) {
    logEvent({ type: "settings.updated", severity: "notice", actor: currentUser(req)?.username ?? "admin", summary: `Updated settings: ${changedKeys.join(", ")}`, ip: clientIp(req), meta: { keys: changedKeys } });
  }
  return saved;
});

// ---------- hosts ----------
function streamPortError(h: { protocol: string; listenPort: number; name?: string }, excludeId?: string): string | null {
  return streamPortConflictError(h, listHosts(), excludeId);
}
/** A host must not claim the control plane's own public hostname (self-hijack). */
// isControlPlaneDomain (the SSO-portal hijack guard) is shared with the agent
// path from hostschema.ts - imported above, defined once.

/** Refuse a host write that would publish the NginUX control plane on the data
 *  plane (security audit 2026-10-01). The static rule (loopback / local addresses on
 *  a control-plane port, for the primary target and every upstream / path-rule
 *  target) applies to everyone - streams always, HTTP/gRPC for non-admins. For
 *  non-admins whose routing changed we then run the live self-probe, which catches
 *  the Docker host's LAN address or a remapped published port. */
async function rejectControlPlaneTarget(
  req: FastifyRequest,
  reply: FastifyReply,
  h: Pick<HostInput, "protocol" | "forwardHost" | "forwardPort" | "forwardScheme" | "upstreams" | "pathRules">,
  opts: { probe: boolean },
): Promise<boolean> {
  const admin = currentUser(req)?.role === "admin";
  const err = controlPlaneTargetError(h, { admin });
  if (err) { reply.code(admin ? 400 : 403).send({ error: err }); return false; }
  if (!admin && opts.probe && await publishesThisControlPlane(h)) {
    reply.code(403).send({ error: "That upstream is this NginUX instance (reached through its LAN address or a remapped port). Only an admin may publish the control plane." });
    return false;
  }
  return true;
}

/** Admin-only gate for a stored host that fronts the control plane (shared
 *  predicate `frontsControlPlane` in hostschema.ts; the agent tools apply the same rule). */
function requireControlPlaneHostAdmin(req: FastifyRequest, reply: FastifyReply, h: Pick<ProxyHost, "domain" | "forwardHost" | "forwardPort">): boolean {
  if (!frontsControlPlane(h) || currentUser(req)?.role === "admin") return true;
  reply.code(403).send({ error: "Only an admin may change, pause, or remove the service that fronts the NginUX control plane (the sign-in portal)." });
  return false;
}

app.get("/api/hosts", async (req) => {
  const u = currentUser(req);
  const hosts = listHosts();
  // Scoped users only see hosts in their scope.
  const visible = u?.role === "scoped" ? hosts.filter((h) => scopedAllows(u, h)) : hosts;
  return visible.map((h) => hostForCaller(req, h));
});

app.get("/api/hosts/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const host = getHost(id);
  if (!host || !canReadHost(req, host)) return reply.code(404).send({ error: "Service not found" });
  return hostForCaller(req, host);
});

app.post("/api/hosts", async (req, reply) => {
  if (!requireRole(req, reply, "admin", "editor")) return;
  const parsed = hostInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  if (!rejectPrivilegedFields(req, reply, parsed.data)) return;
  const capabilityError = protocolCapabilityError(parsed.data);
  if (capabilityError) return reply.code(400).send({ error: capabilityError });
  const input = normalizeProtocolFields(parsed.data);
  if (getHostByDomain(input.domain)) {
    return reply.code(409).send({ error: `${input.domain} is already in use.` });
  }
  if (isControlPlaneDomain(input.domain, input.forwardHost, input.forwardPort, input.forwardScheme)) {
    return reply.code(409).send({ error: "That's the domain NginUX itself runs on (Settings → public URL). To use it as your sign-in portal, forward it to the control plane on port 6767; otherwise pick another domain so you don't lose access to NginUX." });
  }
  const spErr = streamPortError(input);
  if (spErr) return reply.code(400).send({ error: spErr });
  if (!(await rejectControlPlaneTarget(req, reply, input, { probe: true }))) return;
  snapshot(`Before exposing ${input.name}`, currentUser(req)?.username ?? "system");
  const host = createHost(input);
  // Ensure the host has a cert (self-signed now; upgrade to Let's Encrypt later)
  // so nginx serves it immediately over HTTPS.
  if (host.ssl) {
    try { await ensureCert(host.domain); } catch { /* non-fatal */ }
  }
  // An mTLS host needs its client CA on disk before the first apply: the generator
  // fails CLOSED (403 for every request) when the CA is missing rather than silently
  // serving the host without client-certificate verification.
  if (host.mtls) { try { await ensureClientCA(host.domain); } catch { /* non-fatal */ } }
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
  return reply.code(201).send({ host: hostForCaller(req, host), apply });
});

app.put("/api/hosts/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const existing = getHost(id);
  if (!existing) return reply.code(404).send({ error: "Service not found" });
  if (!requireHostAccess(req, reply, existing, { allowScoped: true })) return;
  if (!requireControlPlaneHostAdmin(req, reply, existing)) return;
  const parsed = hostInput.partial().safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  if (!rejectPrivilegedFields(req, reply, parsed.data)) return;
  // Validate the *resulting* host (existing merged with the patch) before writing.
  const merged = { ...existing, ...parsed.data };
  const capabilityError = protocolCapabilityError(merged);
  if (capabilityError) return reply.code(400).send({ error: capabilityError });
  const normalized = normalizeProtocolFields(merged);
  // Guard the control-plane-domain hijack against the MERGED result, not just a
  // domain change: a host already sitting on the portal domain can be broken by a
  // port-only edit (6767 -> 8080), repointing the sign-in server block and locking
  // everyone out. Fire whenever the result is a hijack AND domain or port actually
  // moved (a no-op re-PUT of an unrelated field must not be punished).
  const routingChanged = normalized.domain !== existing.domain
    || normalized.forwardScheme !== existing.forwardScheme
    || normalized.forwardHost !== existing.forwardHost
    || normalized.forwardPort !== existing.forwardPort;
  if (routingChanged && isControlPlaneDomain(normalized.domain, normalized.forwardHost, normalized.forwardPort, normalized.forwardScheme)) {
    return reply.code(409).send({ error: "That's the domain NginUX itself runs on (Settings → public URL). To use it as your sign-in portal, forward it to the control plane on port 6767; otherwise pick another domain so you don't lose access to NginUX." });
  }
  const spErr = streamPortError(normalized, id);
  if (spErr) return reply.code(400).send({ error: spErr });
  const targetsChanged = routingChanged || normalized.protocol !== existing.protocol
    || normalized.upstreams !== existing.upstreams || normalized.pathRules !== existing.pathRules;
  if (!(await rejectControlPlaneTarget(req, reply, normalized, { probe: targetsChanged }))) return;
  snapshot(`Before updating a service`, currentUser(req)?.username ?? "system");
  const host = updateHost(id, normalized);
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
  return { host: hostForCaller(req, host), apply };
});

app.delete("/api/hosts/:id", async (req, reply) => {
  if (!requireRole(req, reply, "admin", "editor")) return;
  const { id } = req.params as { id: string };
  const existing = getHost(id);
  if (existing && !requireControlPlaneHostAdmin(req, reply, existing)) return;
  snapshot(`Before removing a service`, currentUser(req)?.username ?? "system");
  if (!deleteHost(id)) return reply.code(404).send({ error: "Service not found" });
  // deleteHost() already cascaded the host's client_certs + incidents rows. The
  // domain is unique to this host, so its managed cert (DB row + on-disk dir) is
  // now unreferenced - remove it too, UNLESS another host still serves it through
  // `certDomain` (a shared wildcard): deleting it would break those hosts at the
  // next reload. Best-effort: don't fail the delete on it.
  if (existing && !certStillReferenced(existing.domain)) { try { deleteCert(existing.domain); } catch { /* ignore */ } }
  const apply = await applyConfig();
  void syncGitOps(`Remove a service`);
  logEvent({ type: "host.deleted", severity: "warn", actor: currentUser(req)?.username ?? "system", summary: `Removed a service`, ip: clientIp(req), meta: { id } });
  return { ok: true, apply };
});

/** Is a managed certificate still selected by a remaining host (`certDomain`) or
 *  served by a remaining host of the same domain? Called AFTER the owning host row
 *  was deleted, so any match means the cert must stay on disk. */
function certStillReferenced(domain: string): boolean {
  const d = domain.toLowerCase();
  return listHosts().some((h) => h.domain.toLowerCase() === d || (h.certDomain || "").toLowerCase() === d);
}

// Bulk actions on many services at once (enable/disable/maintenance/delete),
// with ONE snapshot + ONE nginx reload for the whole batch instead of N. Admin/
// editor only, matching the single-host mutation + delete routes.
app.post("/api/hosts/batch", async (req, reply) => {
  if (!requireRole(req, reply, "admin", "editor")) return;
  const parsed = z.object({
    ids: z.array(z.string().max(64)).min(1).max(500),
    action: z.enum(["enable", "disable", "maintenance-on", "maintenance-off", "delete"]),
  }).safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  const { ids, action } = parsed.data;
  if ((action === "maintenance-on" || action === "maintenance-off")
    && ids.some((id) => { const h = getHost(id); return h && !protocolSupportsHttpControls(h.protocol); })) {
    return reply.code(400).send({ error: "Maintenance pages are HTTP/gRPC-only. Pause a TCP/UDP/SNI service instead." });
  }
  // The portal / control-plane-fronting host is admin territory even in bulk: a
  // bulk disable, maintenance or delete by an editor would lock every remote admin out.
  for (const id of ids) {
    const h = getHost(id);
    if (h && !requireControlPlaneHostAdmin(req, reply, h)) return;
  }
  const actor = currentUser(req)?.username ?? "system";
  snapshot(`Bulk ${action} on ${ids.length} service(s)`, actor);
  const previousHosts = listHosts();

  let affected = 0;
  for (const id of ids) {
    const h = getHost(id);
    if (!h) continue;
    if (action === "delete") {
      if (deleteHost(id)) {
        if (!certStillReferenced(h.domain)) { try { deleteCert(h.domain); } catch { /* best effort */ } }
        affected++;
      }
    } else {
      const patch = action === "enable" ? { enabled: true }
        : action === "disable" ? { enabled: false }
        : action === "maintenance-on" ? { maintenanceMode: true }
        : { maintenanceMode: false };
      if (updateHost(id, patch)) affected++;
    }
  }
  const apply = await applyConfig();
  if (!apply.ok && apply.nginxAvailable) {
    replaceAllHosts(previousHosts);
    await applyConfig();
    logEvent({ type: "host.update_failed", severity: "warn", actor, summary: `Reverted bulk ${action} - config rejected`, ip: clientIp(req), meta: { action, error: apply.message } });
    return reply.code(422).send({ error: apply.message, apply });
  }
  void syncGitOps(`Bulk ${action} (${affected} service${affected === 1 ? "" : "s"})`);
  logEvent({
    type: action === "delete" ? "host.deleted" : "host.updated",
    severity: action === "delete" ? "warn" : "notice",
    actor, summary: `Bulk ${action} on ${affected} service${affected === 1 ? "" : "s"}`, ip: clientIp(req), meta: { action, affected },
  });
  return { affected, apply };
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
    const existing = id ? getHost(id) : null;
    if (!existing) return reply.code(404).send({ error: "Service not found" });
    if (currentUser(req)?.role !== "admin" && existing.customNginx) {
      return reply.code(403).send({ error: "Only an admin may preview a service containing custom nginx directives." });
    }
    candidateHosts = hosts.filter((h) => h.id !== id);
  } else if (mode === "update") {
    if (!id) return reply.code(400).send({ error: "id is required to preview an update." });
    const existing = getHost(id);
    if (!existing) return reply.code(404).send({ error: "Service not found" });
    if (currentUser(req)?.role !== "admin" && existing.customNginx) {
      return reply.code(403).send({ error: "Only an admin may preview a service containing custom nginx directives." });
    }
    const parsed = hostInput.partial().safeParse(host ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    if (!rejectPrivilegedFields(req, reply, parsed.data)) return;
    const merged = { ...existing, ...parsed.data } as ProxyHost;
    const capabilityError = protocolCapabilityError(merged);
    if (capabilityError) return reply.code(400).send({ error: capabilityError });
    const normalized = normalizeProtocolFields(merged);
    if (isControlPlaneDomain(normalized.domain, normalized.forwardHost, normalized.forwardPort, normalized.forwardScheme)) {
      return reply.code(409).send({ error: "The public NginUX portal must forward to the exact configured control plane." });
    }
    const spErr = streamPortError(normalized, id);
    if (spErr) return reply.code(400).send({ error: spErr });
    if (!(await rejectControlPlaneTarget(req, reply, normalized, { probe: false }))) return;
    candidateHosts = hosts.map((h) => (h.id === id ? normalized : h));
  } else { // create
    const parsed = hostInput.safeParse(host ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    if (!rejectPrivilegedFields(req, reply, parsed.data)) return;
    const capabilityError = protocolCapabilityError(parsed.data);
    if (capabilityError) return reply.code(400).send({ error: capabilityError });
    // rejectPrivilegedFields strips a non-admin's empty customNginx placeholder; the
    // generator needs the field present (an editor's create preview used to 500 here).
    const normalized = normalizeProtocolFields({ ...parsed.data, customNginx: parsed.data.customNginx ?? "" });
    if (isControlPlaneDomain(normalized.domain, normalized.forwardHost, normalized.forwardPort, normalized.forwardScheme)) {
      return reply.code(409).send({ error: "The public NginUX portal must forward to the exact configured control plane." });
    }
    const spErr = streamPortError(normalized);
    if (spErr) return reply.code(400).send({ error: spErr });
    if (!(await rejectControlPlaneTarget(req, reply, normalized, { probe: false }))) return;
    const candidate = { ...normalized, id: "__preview__", health: "unknown", certExpiresAt: null, createdAt: "", updatedAt: "" } as ProxyHost;
    candidateHosts = [...hosts, candidate];
  }
  // Non-admins diff against the config regenerated from the DB, not the on-disk
  // files: unrelated on-disk drift (another host's admin-only customNginx edit) must
  // not leak into an editor's preview. Admins see the true on-disk delta.
  const baseline = currentUser(req)?.role === "admin" ? undefined : buildDesiredConfigs(hosts);
  return previewConfigForHosts(candidateHosts, baseline);
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
  if (!protocolSupportsHttpControls(host.protocol)) {
    return reply.code(400).send({ error: "mTLS client certificates require HTTP/gRPC TLS termination; they cannot protect TCP/UDP/SNI passthrough." });
  }
  const parsed = z.object({
    name: z.string().min(1).max(64).refine((s) => !/[\r\n\0]/.test(s), "Certificate name may not contain control characters."),
  }).safeParse(req.body);
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
  // Omit admin-only custom directives for every non-admin before generation;
  // redactConfig alone only masks the managed forward-auth secret.
  const readable = currentUser(req)?.role === "admin" ? host : { ...host, customNginx: "" };
  if (readable.protocol === "sni") conf = generateSniPassthrough([readable]);
  else if (readable.protocol === "tcp" || readable.protocol === "udp") conf = generateStreamConfig(readable);
  else conf = generateHostConfig(readable);
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
  let address: string;
  try { address = await resolveSafeOutboundHost(host); }
  catch (e) { return reply.code(400).send({ error: e instanceof Error ? e.message : "That destination host is not allowed." }); }
  const reachable = await tcpProbe(address, port, 2500);
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
  const prevHosts = listHosts();
  const prevSettings = getSettings();
  snapshot("Before restore", currentUser(req)?.username ?? "admin");
  const r = restoreVersion(id);
  if (!r) return reply.code(404).send({ error: "Version not found" });
  const apply = await applyConfig();
  if (!apply.ok && apply.nginxAvailable) {
    replaceAllHosts(prevHosts);
    saveSettings(prevSettings);
    writeGeoipConf();
    await applyConfig();
    logEvent({ type: "config.restore_failed", severity: "warn", actor: currentUser(req)?.username ?? "admin", summary: `Reverted restore ${id} - config rejected`, ip: clientIp(req), meta: { id, error: apply.message } });
    return reply.code(422).send({ error: apply.message, apply });
  }
  void syncGitOps("Restore previous config");
  logEvent({ type: "config.restored", severity: "warn", actor: currentUser(req)?.username ?? "admin", summary: `Restored config (${r.restored} services)`, ip: clientIp(req), meta: { id } });
  return { ...r, apply };
});
// Portable backup bundle (hosts + settings + bans + channels; NOT certs). Without
// a passphrase the bundle is plaintext with secrets MASKED (safe to store); with a
// passphrase the whole bundle is AES-256-GCM encrypted and may carry real secrets.
app.post("/api/config/backup", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const parsed = z.object({
    passphrase: z.string().min(8).max(256).optional(),
    includeSecrets: z.boolean().default(false),
  }).safeParse(req.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  const { passphrase, includeSecrets } = parsed.data;
  // Real secrets only ever leave the box inside an encrypted bundle.
  const withSecrets = includeSecrets && !!passphrase;
  const bundle = buildBundle(new Date().toISOString(), withSecrets);
  logEvent({ type: "config.exported", severity: "notice", actor: currentUser(req)?.username ?? "admin", summary: `Exported a backup bundle${passphrase ? " (encrypted)" : ""}`, ip: clientIp(req), meta: { encrypted: !!passphrase, includeSecrets: withSecrets } });
  return passphrase ? { encrypted: true, blob: await encryptJsonAsync(bundle, passphrase) } : { encrypted: false, bundle };
});

// Restore a bundle (plaintext object or an encrypted blob + passphrase). Replaces
// hosts/bans/channels and merges settings, then reloads nginx. Snapshots first.
app.post("/api/config/restore", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const parsed = z.object({
    bundle: z.record(z.string(), z.unknown()).optional(),
    blob: z.record(z.string(), z.unknown()).optional(),
    passphrase: z.string().max(256).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  let data: unknown = parsed.data.bundle;
  if (parsed.data.blob && isEncryptedEnvelope(parsed.data.blob)) {
    try { data = await decryptJsonAsync(parsed.data.blob, parsed.data.passphrase ?? ""); }
    catch (e) { return reply.code(400).send({ error: e instanceof Error ? e.message : "Couldn't decrypt the backup." }); }
  }
  if (!data) return reply.code(400).send({ error: "Provide a bundle or an encrypted blob + passphrase." });
  const prevHosts = listHosts();
  const prevBans = listBans();
  const prevChannels = listChannelsRaw();
  const prevSettings = getSettings();
  snapshot("Before restoring a backup", currentUser(req)?.username ?? "admin");
  let result;
  try { result = restoreBundle(data); }
  catch (e) { return reply.code(400).send({ error: e instanceof Error ? e.message : "Invalid backup bundle." }); }
  writeGeoipConf();
  const apply = await applyConfig();
  if (!apply.ok && apply.nginxAvailable) {
    replaceAllHosts(prevHosts);
    replaceAllBans(prevBans);
    replaceAllChannels(prevChannels);
    saveSettings(prevSettings);
    writeGeoipConf();
    await applyConfig();
    logEvent({ type: "config.restore_failed", severity: "warn", actor: currentUser(req)?.username ?? "admin", summary: "Reverted backup restore - config rejected", ip: clientIp(req), meta: { error: apply.message } });
    return reply.code(422).send({ error: apply.message, apply });
  }
  void syncGitOps(`Restore backup (${result.hosts} services)`);
  logEvent({ type: "config.restored", severity: "warn", actor: currentUser(req)?.username ?? "admin", summary: `Restored a backup: ${result.hosts} services, ${result.bans} bans, ${result.channels} channels`, ip: clientIp(req), meta: { ...result } });
  return { ...result, apply };
});

// Legacy plaintext export (hosts + settings), now with secrets MASKED so it can't
// leak provider credentials. Prefer POST /api/config/backup.
app.get("/api/config/export", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const b = buildBundle(new Date().toISOString(), false);
  return { version: b.version, exportedAt: b.createdAt, hosts: b.hosts, settings: b.settings };
});
// Dry-run: parse an nginx.conf and show what WOULD be imported (+ skip reasons)
// without creating anything, so the user can review before committing.
app.post("/api/config/import/preview", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const parsed = z.object({ conf: z.string().min(1).max(1_000_000) }).safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  return previewNginxConf(parsed.data.conf);
});
app.post("/api/config/import", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const parsed = z.object({ conf: z.string().min(1).max(1_000_000) }).safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  const { conf } = parsed.data;
  snapshot("Before import", currentUser(req)?.username ?? "admin");
  const result = importNginxConf(conf);
  const apply = await applyConfig();
  if (!apply.ok && apply.nginxAvailable) {
    for (const id of result.createdIds) deleteHost(id);
    await applyConfig();
    logEvent({ type: "config.import_failed", severity: "warn", actor: currentUser(req)?.username ?? "admin", summary: "Reverted nginx.conf import - config rejected", ip: clientIp(req), meta: { error: apply.message } });
    return reply.code(422).send({ error: apply.message, apply });
  }
  void syncGitOps(`Import ${result.imported.length} host(s)`);
  logEvent({ type: "config.imported", severity: "notice", actor: currentUser(req)?.username ?? "admin", summary: `Imported ${result.imported.length} host(s) from nginx.conf`, ip: clientIp(req), meta: result });
  return { imported: result.imported, skipped: result.skipped, apply };
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
  return await metricsHostSummary(domain, range);
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

app.get("/api/logs/recent", async (req, reply) => {
  if (!requireRoleOrScope(req, reply, ["admin", "editor"], "report")) return; // access logs carry client IPs; token needs 'report' (mirrors the recent_logs MCP tool)
  const { filter, limit } = req.query as { filter?: string; limit?: string };
  // A filter (e.g. clicking an IP on the traffic map) searches the persisted log
  // on disk so older IPs still resolve; an unfiltered tail uses the live ring.
  return filter ? await searchLog(filter, clampLimit(limit)) : recentLogs(undefined, clampLimit(limit));
});
// ---- SSE connection policy (shared by /api/logs/stream and /api/events/sse) ----
// Global cap (so streams can't exhaust sockets/memory) PLUS a per-principal cap, so one
// low-scope token or session can't hog every slot and lock admins out of the live feeds.
// Slow readers are dropped once their unsent buffer passes SSE_MAX_BUFFER (otherwise an
// attacker who never reads keeps the process buffering every event for them), and each
// heartbeat re-checks that the caller's session/token is still valid so revocation also
// ends streams that were opened before it. (Security audit 2026-10-01.)
let sseClients = 0;
const SSE_MAX = Math.min(1000, Math.max(1, Number(process.env.NGINUX_SSE_MAX) || 200));
const SSE_PER_PRINCIPAL = Math.min(SSE_MAX, Math.max(1, Number(process.env.NGINUX_SSE_PER_PRINCIPAL) || 5));
const SSE_MAX_BUFFER = 1024 * 1024;
const ssePerPrincipal = new Map<string, number>();
const ssePrincipalKey = (req: FastifyRequest): string => {
  const p = principal(req);
  if (p?.kind === "user") return `user:${p.user.id}`;
  if (p?.kind === "agent") return `agent:${p.id}`;
  return `ip:${clientIp(req)}`;
};
type SseWrite = (chunk: string) => void;
/** Installs the event subscription (given a bounded writer) and returns its unsubscribe. */
type SseRegister = (install: (write: SseWrite) => () => void) => () => void;
/** Claim an SSE slot. Returns a registrar, or null (503 already sent). */
function openSse(req: FastifyRequest, reply: FastifyReply, extraHeaders: Record<string, string> = {}): SseRegister | null {
  const key = ssePrincipalKey(req);
  const mine = ssePerPrincipal.get(key) ?? 0;
  if (sseClients >= SSE_MAX || mine >= SSE_PER_PRINCIPAL) {
    reply.code(503).send({ error: "Too many open streams." });
    return null;
  }
  sseClients++;
  ssePerPrincipal.set(key, mine + 1);
  reply.hijack();
  reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...extraHeaders });
  reply.raw.write(": connected\n\n");
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    sseClients--;
    const n = (ssePerPrincipal.get(key) ?? 1) - 1;
    if (n <= 0) ssePerPrincipal.delete(key); else ssePerPrincipal.set(key, n);
    try { reply.raw.end(); } catch { /* already gone */ }
    try { reply.raw.destroy(); } catch { /* already gone */ }
  };
  const write = (chunk: string) => {
    if (closed) return;
    if (reply.raw.writableLength > SSE_MAX_BUFFER) { close(); return; } // slow/absent reader
    reply.raw.write(chunk);
  };
  // Returns a registrar: the caller passes the subscription installer and gets `close`.
  return (install) => {
    const unsub = install(write);
    const hb = setInterval(() => {
      // Re-validate: a revoked session/token must not keep an already-open stream alive.
      userCache.delete(req); sessionTokenCache.delete(req);
      if (!principal(req)) { close(); return; }
      write(": ping\n\n");
    }, 25000);
    hb.unref?.();
    const finish = () => { clearInterval(hb); try { unsub(); } catch { /* ignore */ } close(); };
    req.raw.on("close", finish);
    req.raw.on("error", finish);
    return finish;
  };
}

app.get("/api/logs/stream", (req, reply) => {
  if (!requireRoleOrScope(req, reply, ["admin", "editor"], "report")) return; // live access logs carry client IPs; token needs 'report'
  const register = openSse(req, reply);
  if (!register) return;
  register((write) => subscribeLog((e) => write(`event: log\ndata: ${JSON.stringify(e)}\n\n`)));
});

// ---------- auth ----------
// Sliding-window in-memory limiter so brute force against the control plane is
// throttled even when requests bypass nginx and hit port 6767 directly.
const LOGIN_MAX = 10;          // attempts per minute, per (ip + username)
const LOGIN_IP_MAX = 30;       // attempts per minute, per IP across all usernames
const LOGIN_GLOBAL_MAX = 300;  // process-wide ceiling against distributed scrypt/log floods
const LOGIN_WINDOW_MS = 60_000; // window
const loginHits = new Map<string, number[]>();
const loginThrottleAuditAt = new Map<string, number>();
// Per-account 2FA brute-force lockout + TOTP replay guard (in-memory; the window
// is short so a restart clearing them is harmless).
const TWOFA_MAX_FAILS = 5;
const TWOFA_LOCK_MS = 5 * 60_000;
const twofaFails = new Map<string, { n: number; until: number }>();
function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const hits = (loginHits.get(key) ?? []).filter((t) => now - t < windowMs);
  hits.push(now);
  // Keep the newest max+1 samples. Previously a client that was already blocked
  // could keep appending timestamps without bound and exhaust memory without
  // paying the scrypt cost.
  if (hits.length > max + 1) hits.splice(0, hits.length - (max + 1));
  loginHits.set(key, hits);
  if (loginHits.size > 5000) { // cap so the map can't grow unbounded
    for (const [k, v] of loginHits) { if (v.every((t) => now - t >= windowMs)) loginHits.delete(k); }
    // If a distinct-key flood outpaces expiry, hard-evict oldest-inserted keys
    // (Map preserves insertion order) so memory stays bounded under abuse.
    while (loginHits.size > 5000) { const k = loginHits.keys().next().value; if (k === undefined) break; loginHits.delete(k); }
  }
  return hits.length > max;
}

/** Preserve one audit signal per source/window without turning the 429 path into
 * an unauthenticated SQLite/webhook amplification primitive. */
function logLoginThrottleOnce(ip: string, username: string, summary: string, auditKey = ip): void {
  const now = Date.now();
  const last = loginThrottleAuditAt.get(auditKey) ?? 0;
  if (now - last < LOGIN_WINDOW_MS) return;
  loginThrottleAuditAt.set(auditKey, now);
  if (loginThrottleAuditAt.size > 5000) {
    for (const [key, ts] of loginThrottleAuditAt) if (now - ts >= LOGIN_WINDOW_MS) loginThrottleAuditAt.delete(key);
    while (loginThrottleAuditAt.size > 5000) {
      const oldest = loginThrottleAuditAt.keys().next().value;
      if (oldest === undefined) break;
      loginThrottleAuditAt.delete(oldest);
    }
  }
  logEvent({ type: "login.failed", severity: "warn", actor: username, summary, ip, meta: { throttled: true } });
}

/** Cookie Domain for the session cookie - the configured ssoCookieDomain, or
 *  derived from ssoLoginUrl's host (strip the leftmost label), or "" (host-only).
 *  Lets one sign-in cover every subdomain so login-gated services work.
 *  The Domain attribute is only emitted when the REQUEST's own host sits under that
 *  base: a browser rejects a Set-Cookie whose Domain does not cover the request host
 *  (which silently broke sign-in via the LAN IP / an unrelated hostname), and a host
 *  outside the base must never receive a base-wide cookie. (Security audit 2026-10-01.) */
function authCookieDomain(req?: FastifyRequest): string {
  const s = getSettings();
  // req.hostname only honors forwarded host data from a trusted proxy.
  const reqHost = req ? String(req.hostname ?? "").toLowerCase().replace(/^\[?([^\]]*)\]?(?::\d+)?$/, "$1").replace(/\.$/, "") : "";
  const covers = (domain: string): string => {
    if (!domain) return "";
    if (!req) return domain;
    const base = domain.replace(/^\.+/, "");
    return reqHost === base || reqHost.endsWith("." + base) ? domain : "";
  };
  // Multi-realm: if the request's host belongs to a configured realm, scope the
  // cookie to THAT base domain, so a sign-in on a second base domain works.
  if (reqHost) {
    const realm = realmForHost(reqHost);
    if (realm) return covers(realm.cookieDomain);
  }
  if (s.ssoCookieDomain) return covers(s.ssoCookieDomain.replace(/^\.?/, "."));
  try {
    const host = new URL(s.ssoLoginUrl).hostname;
    const parts = host.split(".");
    if (parts.length >= 2) return covers("." + parts.slice(parts.length > 2 ? 1 : 0).join("."));
  } catch { /* ssoLoginUrl unset/invalid */ }
  return "";
}

// Bound the inputs: username/password are attacker-controlled and each login
// attempt runs a deliberately-expensive scrypt, so an unbounded password also
// amplifies CPU. (Length caps are generous; real creds fit easily.)
const loginInput = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(200),
  token: z.string().max(64).optional(),
  returnUrl: z.string().max(2048).optional(),
});

/** Login redirects are authorized against the server's configured host table.
 * Client-side "same domain family" heuristics are unsafe on multi-tenant public
 * suffixes such as github.io and pages.dev. */
function safeLoginRedirect(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return undefined;
    if ((u.protocol === "http:" && u.port && u.port !== "80")
      || (u.protocol === "https:" && u.port && u.port !== "443")) return undefined;
    // Redirects require an exact host row; a wildcard proxy entry must not turn
    // into a blanket redirect allowlist for a multi-tenant suffix. The only producer
    // of `rd` is the login gate on a login-gated HTTP/gRPC host, so require exactly
    // that: a non-gated (possibly editor-created) host is never a redirect target.
    const host = getHostByDomain(u.hostname);
    const gatedHttp = !!host?.enabled && host.requireLogin && (host.protocol === "http" || host.protocol === "grpc");
    return gatedHttp ? u.href : undefined;
  } catch {
    return undefined;
  }
}
app.post("/api/auth/login", async (req, reply) => {
  const parsed = loginInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
  const { username, password, token, returnUrl } = parsed.data;
  const ip = clientIp(req);

  // Order matters: the per-source limiters run FIRST so a single IP that is already
  // throttled does not keep consuming the shared global budget (which would let one
  // noisy source lock every other user out of sign-in). The global breaker only counts
  // attempts that passed the per-source limits. (Security audit 2026-10-01.)
  //
  // Per-IP budget, independent of username: the username is attacker-controlled, so
  // keying the limiter only on ip+username would let one IP get a fresh allowance
  // per guessed username and force unbounded scrypt work. This caps total attempts
  // (hence scrypt calls) from a single source regardless of the usernames tried.
  if (rateLimited(`ipall:${ip}`, LOGIN_IP_MAX, LOGIN_WINDOW_MS)) {
    logLoginThrottleOnce(ip, username, "Too many login attempts from this IP - throttled");
    return reply.code(429).send({ error: "Too many attempts. Wait a minute and try again." });
  }
  if (rateLimited(`${ip}:${username}`.toLowerCase(), LOGIN_MAX, LOGIN_WINDOW_MS)) {
    logLoginThrottleOnce(ip, username, "Too many login attempts - throttled");
    return reply.code(429).send({ error: "Too many attempts. Wait a minute and try again." });
  }
  if (rateLimited("login:global", LOGIN_GLOBAL_MAX, LOGIN_WINDOW_MS)) {
    logLoginThrottleOnce(ip, username, "Global login-attempt budget reached - throttled", "login:global");
    return reply.code(429).send({ error: "The sign-in service is temporarily busy. Wait a minute and try again." });
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
  reply.header("set-cookie", sessionCookie(sessionToken, cookieSecure(req.protocol === "https"), authCookieDomain(req)));
  const created = getUserById(String(row.id));
  return { user: created ? withPolicyFlags(created) : created, redirectTo: safeLoginRedirect(returnUrl) };
});

app.post("/api/auth/logout", async (req, reply) => {
  const tok = sessionTokenOf(req);
  if (tok) destroySession(tok);
  else for (const t of parseCookieAll(req.headers.cookie, SESSION_COOKIE)) destroySession(t);
  reply.header("set-cookie", clearCookie(cookieSecure(req.protocol === "https"), authCookieDomain(req)));
  return { ok: true };
});

app.get("/api/auth/me", async (req, reply) => {
  const u = currentUser(req);
  if (!u) return reply.code(401).send({ error: "Not signed in" });
  return withPolicyFlags(u);
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
  if (!secret) return false; // fail closed if settings are damaged or cleared
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
  // A manager still owing 2FA enrollment (require2faForManagers) is confined on the
  // control plane; deny downstream service access too until enrolled, mirroring that
  // confinement. (Security audit 2026-07-12.)
  if (mustEnroll2fa(u)) return reply.code(401).send({ ok: false });
  // Enforce the target host's per-host policy. forward-auth is only ever invoked by
  // nginx for a requireLogin host, and nginx always stamps X-Original-Host — so that
  // host MUST resolve to a DB row. If it can't, FAIL CLOSED (deny) rather than fall
  // through to 200. This closes the whole "per-host check silently skipped" class at
  // the root, for EVERY role: any present-or-future way to make the lookup miss
  // (uppercase, wildcard, unicode/punycode, config drift, a header we don't parse)
  // now denies an under-authenticated request instead of admitting it — the exact
  // recurrence guarded against here. (Security audit 2026-07-12.)
  const originalHost = (req.headers["x-original-host"] as string) || (req.headers["x-forwarded-host"] as string);
  // Resolve the row nginx is actually SERVING for this name (enabled http/grpc, exact
  // then wildcard) - not merely the row with that domain. A disabled or tcp/udp/sni
  // row must not shadow the covering wildcard whose policy really applies here.
  const host = originalHost ? getServingHttpHostByDomainCached(originalHost.split(":")[0]) : null;
  if (!host) return reply.code(401).send({ ok: false });
  // nginx only emits auth_request for requireLogin hosts; a gate check for an
  // ungated row can't have come from the generated config - deny.
  if (!host.requireLogin) return reply.code(401).send({ ok: false });
  if (host.require2fa && !u.twofaEnabled) return reply.code(401).send({ ok: false });
  // A scoped user only passes the per-host login gate for hosts in their scope -
  // otherwise one NginUX login would unlock every protected app.
  if (u.role === "scoped" && !scopedAllows(u, host)) return reply.code(403).send({ ok: false });
  return reply.code(200).send({ ok: true });
});

app.post("/api/auth/change-password", async (req, reply) => {
  const u = currentUser(req);
  if (!u) return reply.code(401).send({ error: "Not signed in" });
  // Step-up reauth is password-checked (scrypt) with no lockout otherwise; throttle it
  // so a session-hijacker can't online-brute-force the current password. Shared key
  // with 2fa/setup so attempts across both count together. (Security audit 2026-07-12.)
  if (rateLimited(`reauth:${u.id}`, 10, LOGIN_WINDOW_MS)) return reply.code(429).send({ error: "Too many attempts — wait a minute and try again." });
  const parsed = z.object({
    currentPassword: z.string().min(1).max(200),
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
  reply.header("set-cookie", sessionCookie(fresh, cookieSecure(req.protocol === "https"), authCookieDomain(req)));
  logEvent({ type: "security.password_changed", severity: "notice", actor: u.username, summary: "Changed account password", ip: clientIp(req), meta: {} });
  const changed = getUserById(u.id);
  return { ok: true, user: changed ? withPolicyFlags(changed) : changed };
});

app.post("/api/auth/2fa/setup", async (req, reply) => {
  const u = currentUser(req)!;
  // Throttle the password reauth (shared budget with change-password). (Security audit 2026-07-12.)
  if (rateLimited(`reauth:${u.id}`, 10, LOGIN_WINDOW_MS)) return reply.code(429).send({ error: "Too many attempts — wait a minute and try again." });
  // Require the password to (re)bind 2FA so a hijacked session can't silently
  // rebind the authenticator to the attacker's device.
  const { password } = z.object({ password: z.string().min(1).max(200) }).parse(req.body ?? {});
  if (!(await checkCredentials(u.username, password))) {
    return reply.code(403).send({ error: "Confirm your password to set up two-factor authentication." });
  }
  const { secret } = beginTwofaSetup(u.id);
  return { secret, otpauth: otpauthURL(secret, u.username) };
});

app.post("/api/auth/2fa/verify", async (req, reply) => {
  const u = currentUser(req)!;
  if (rateLimited(`2fa-enroll:${u.id}`, 10, LOGIN_WINDOW_MS)) {
    return reply.code(429).send({ error: "Too many verification attempts — wait a minute and try again." });
  }
  const { token } = z.object({ token: z.string().min(1).max(64) }).parse(req.body);
  const secret = getPendingTwofaSecret(u.id);
  const enrolCounter = secret ? verifyTotpCounter(token, secret) : -1;
  if (!secret || enrolCounter < 0) {
    return reply.code(400).send({ error: "That code didn't match - try the current one." });
  }
  const replacing = u.twofaEnabled;
  const backupCodes = enableTwofa(u.id);
  // Burn the step used to enrol: the login path rejects any counter <= the stored one, so
  // the code the user just typed cannot be replayed at the sign-in prompt within its
  // validity window. (Security audit 2026-10-01.)
  setLastTotpCounter(u.id, enrolCounter);
  // 2FA assurance is stored on the user, not on each session. Once the factor is
  // enabled/replaced, every earlier cookie would otherwise inherit that stronger
  // state without proving the new factor. Revoke them all and keep only this
  // verifying browser signed in with a freshly-issued session.
  destroyUserSessions(u.id);
  const fresh = createSession(u.id, device(req), clientIp(req));
  reply.header("set-cookie", sessionCookie(fresh, cookieSecure(req.protocol === "https"), authCookieDomain(req)));
  logEvent({
    type: replacing ? "security.2fa_replaced" : "security.2fa_enabled",
    severity: "info", actor: u.username,
    summary: replacing ? "Replaced two-factor authenticator" : "Enabled two-factor authentication",
    ip: clientIp(req), meta: {},
  });
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
  const target = getUserById(id);
  if (target?.role === "admin" && countAdmins() <= 1) return reply.code(400).send({ error: "Can't delete the last admin account." });
  deleteUser(id);
  logEvent({ type: "user.deleted", severity: "warn", actor: admin.username, summary: `Deleted a user`, ip: clientIp(req), meta: { id } });
  return { ok: true };
});
// Change a user's role in place (promote/demote without delete+recreate, which
// used to lose their 2FA enrollment). Refuses to demote the last admin.
app.patch("/api/users/:id/role", async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  const { id } = req.params as { id: string };
  const parsed = z.object({
    role: z.enum(["admin", "editor", "readonly", "scoped"]),
    scope: z.string().max(200).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  const target = getUserById(id);
  if (!target) return reply.code(404).send({ error: "User not found" });
  if (target.role === "admin" && parsed.data.role !== "admin" && countAdmins() <= 1) {
    return reply.code(400).send({ error: "Can't demote the last admin account." });
  }
  updateUserRole(id, parsed.data.role, parsed.data.scope ?? "");
  logEvent({ type: "user.role_changed", severity: "warn", actor: admin.username, summary: `Changed ${target.username}'s role to ${parsed.data.role}`, ip: clientIp(req), meta: { id, role: parsed.data.role } });
  return getUserById(id)!;
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

// Admin recovery for another user who lost both their authenticator and backup
// codes. Self-service uses the safer replacement flow, which keeps the old factor
// active until the new one is verified. Recovery revokes all target sessions.
app.post("/api/users/:id/2fa/reset", async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  const { id } = req.params as { id: string };
  if (id === admin.id) {
    return reply.code(400).send({ error: "Use Replace 2FA for your own account so the old authenticator stays active until verification." });
  }
  const target = getUserById(id);
  if (!target) return reply.code(404).send({ error: "User not found" });
  if (!target.twofaEnabled) return reply.code(409).send({ error: "Two-factor authentication is not enabled for this user." });
  if (rateLimited(`reauth:${admin.id}`, 10, LOGIN_WINDOW_MS)) {
    return reply.code(429).send({ error: "Too many attempts — wait a minute and try again." });
  }
  const parsed = z.object({ currentPassword: z.string().min(1).max(200) }).safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  if (!(await checkCredentials(admin.username, parsed.data.currentPassword))) {
    return reply.code(403).send({ error: "Confirm your own admin password before resetting another user's 2FA." });
  }
  if (!resetTwofa(id)) return reply.code(409).send({ error: "Two-factor authentication was already reset." });
  logEvent({
    type: "security.2fa_reset", severity: "warn", actor: admin.username,
    summary: `Reset two-factor authentication for ${target.username}`,
    ip: clientIp(req), meta: { id },
  });
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
  if (!z.string().uuid().safeParse(id).success) return reply.code(404).send({ error: "No avatar." });
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
  // Expose the non-secret sid (used to revoke) and flag the caller's own session;
  // never return the raw token.
  const myTok = sessionTokenOf(req);
  const mySid = myTok ? sessionSid(myTok) : "";
  return listSessions().map((s) => ({
    sid: s.sid, userId: s.userId, username: s.username, device: s.device,
    ip: s.ip, lastActive: s.lastActive, current: s.sid === mySid,
  }));
});
// Revoke one session by its public sid (kills a lost/rogue login without deleting
// the whole account). Revoking your own session logs you out.
app.delete("/api/sessions/:sid", async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  const { sid } = req.params as { sid: string };
  const ok = revokeSession(sid);
  if (ok) logEvent({ type: "security.session_revoked", severity: "notice", actor: admin.username, summary: "Revoked a session", ip: clientIp(req), meta: { sid } });
  return { ok };
});

// Route groups extracted into server/src/routes/*.ts (registered on the same app
// instance, sharing the auth preHandler defined above). routeCtx (defined near
// the top, next to the identity helpers) carries the session/role helpers each
// module needs; everything else a module uses it imports directly.
registerUpdateRoutes(app, routeCtx);
registerGeoipRoutes(app, routeCtx);
registerTokenRoutes(app, routeCtx);
registerProfileRoutes(app, routeCtx);
registerWebhookRoutes(app, routeCtx);
registerChannelRoutes(app, routeCtx);
registerSecurityRoutes(app, routeCtx);
registerAgentRoutes(app, routeCtx);
registerCertRoutes(app, routeCtx);

// ---------- MCP server (JSON-RPC over HTTP; session or Bearer token) ----------
app.post("/api/mcp", async (req, reply) => {
  const me = principal(req)!;
  const body = req.body as unknown;
  const handle = (m: unknown) => handleMcp(me, m as never);
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return reply.send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid JSON-RPC request." } });
    }
    if (body.length > 50) return reply.code(413).send({ error: "Batch too large (max 50)." });
    // Mutating tools can rewrite the whole nginx config and have per-operation
    // rollback. Execute a batch in order so two writes cannot race each other's
    // DB snapshot/revert even though applyConfig itself serializes file writes.
    const out: object[] = [];
    for (const message of body) {
      const result = await handle(message);
      if (result) out.push(result);
    }
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
  const register = openSse(req, reply);
  if (!register) return;
  register((write) => subscribe((e) => {
    write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  }));
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
