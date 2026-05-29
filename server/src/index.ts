import { connect } from "node:net";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { getSettings, saveSettings, seedIfEmpty } from "./db.ts";
import { PRESETS, getPreset } from "./presets.ts";
import {
  createHost,
  deleteHost,
  getHost,
  getHostByDomain,
  getTopology,
  listHosts,
  updateHost,
} from "./repo.ts";
import { applyConfig, generateHostConfig, generateStreamConfig } from "./nginx.ts";
import {
  beginTwofaSetup,
  checkCredentials,
  clearCookie,
  createSession,
  createUser,
  deleteUser,
  destroySession,
  enableTwofa,
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
  SESSION_COOKIE,
  sessionCookie,
  userForSession,
  type User,
} from "./auth.ts";
import { otpauthURL, verifyTotp } from "./totp.ts";
import {
  deleteCert,
  ensureCert,
  getCert,
  issue,
  listCerts,
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
import { callTool, decideApproval, listApprovals, toolCatalog, type Principal } from "./tools.ts";
import { createWebhook, deleteWebhook, listWebhooks, subscribe } from "./events.ts";
import { handleMcp } from "./mcp.ts";
import {
  prometheus,
  recentLogs,
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
import { ensureClientCA, issueClientCert, listClientCerts, revokeClientCert } from "./clientcerts.ts";
import { generateSniPassthrough } from "./nginx.ts";
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
const seeded = seedAuthIfEmpty();
seedTokensIfEmpty();

const ALL_SCOPES: Scope[] = ["read", "report", "control", "security"];
const currentUser = (req: FastifyRequest): User | null =>
  userForSession(parseCookie(req.headers.cookie)[SESSION_COOKIE]);
/** Resolve the caller to a user (session) or agent (bearer token). */
const principal = (req: FastifyRequest): Principal | null => {
  const u = currentUser(req);
  if (u) return { kind: "user", name: u.username, scopes: ALL_SCOPES, user: u };
  return resolveToken(bearerFrom(req.headers.authorization));
};
const clientIp = (req: FastifyRequest) =>
  (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip;
const device = (req: FastifyRequest) => (req.headers["user-agent"] as string)?.slice(0, 120) || "unknown";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

// Auth guard. Human UI routes need a session; agent routes (MCP + events)
// accept a session OR a Bearer API token (agents never use 2FA).
const OPEN_PATHS = new Set(["/api/health", "/api/auth/login", "/api/auth/forward"]);
app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
  if (!req.url.startsWith("/api")) return;
  const path = req.url.split("?")[0];
  if (OPEN_PATHS.has(path)) return;
  if (path === "/api/mcp" || path.startsWith("/api/events") || path.startsWith("/api/logs") || path === "/api/metrics/prometheus") {
    if (!principal(req)) return reply.code(401).send({ error: "Valid session or API token required" });
    return;
  }
  if (!currentUser(req)) return reply.code(401).send({ error: "Authentication required" });
});

function requireAdmin(req: FastifyRequest, reply: FastifyReply): User | null {
  const u = currentUser(req);
  if (!u || u.role !== "admin") {
    reply.code(403).send({ error: "Admin role required" });
    return null;
  }
  return u;
}

// ---------- validation ----------
const hostInput = z.object({
  name: z.string().min(1),
  emoji: z.string().default("⚙️"),
  domain: z.string().min(1),
  forwardScheme: z.enum(["http", "https"]).default("http"),
  forwardHost: z.string().min(1),
  forwardPort: z.number().int().min(1).max(65535),
  preset: z.string().default("custom"),
  websockets: z.boolean().default(false),
  http2: z.boolean().default(true),
  ssl: z.boolean().default(true),
  requireLogin: z.boolean().default(false),
  require2fa: z.boolean().default(false),
  countryLock: z.boolean().default(false),
  serverGroup: z.string().default("default"),
  serverIp: z.string().default(""),
  enabled: z.boolean().default(true),
  maintenanceMode: z.boolean().default(false),
  securityHeaders: z.boolean().default(true),
  hsts: z.boolean().default(false),
  rateLimit: z.boolean().default(false),
  blockExploits: z.boolean().default(false),
  ipAllow: z.string().default(""),
  ipDeny: z.string().default(""),
  customHeaders: z.string().default(""),
  customNginx: z.string().default(""),
  upstreams: z.string().default(""),
  lbMethod: z.enum(["round_robin", "least_conn", "ip_hash"]).default("round_robin"),
  protocol: z.enum(["http", "tcp", "udp", "grpc", "sni"]).default("http"),
  listenPort: z.number().int().min(0).max(65535).default(0),
  pathRules: z.string().default(""),
  mtls: z.boolean().default(false),
  rateLimitKbps: z.number().int().min(0).max(1_000_000).default(0),
  maxConns: z.number().int().min(0).max(100_000).default(0),
});

// ---------- health ----------
app.get("/api/health", async () => ({
  status: "ok",
  service: "nginux",
  version: "0.1.0",
  time: new Date().toISOString(),
}));

// ---------- presets ----------
app.get("/api/presets", async () => Object.values(PRESETS));

// ---------- settings ----------
app.get("/api/settings", async () => getSettings());
app.put("/api/settings", async (req) => {
  const patch = z.record(z.string(), z.any()).parse(req.body);
  return saveSettings(patch);
});

// ---------- hosts ----------
app.get("/api/hosts", async () => listHosts());

app.get("/api/hosts/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const host = getHost(id);
  if (!host) return reply.code(404).send({ error: "Service not found" });
  return host;
});

app.post("/api/hosts", async (req, reply) => {
  const parsed = hostInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  if (getHostByDomain(parsed.data.domain)) {
    return reply.code(409).send({ error: `${parsed.data.domain} is already in use.` });
  }
  snapshot(`Before exposing ${parsed.data.name}`, currentUser(req)?.username ?? "system");
  const host = createHost(parsed.data);
  // Ensure the host has a cert (self-signed now; upgrade to Let's Encrypt later)
  // so nginx serves it immediately over HTTPS.
  if (host.ssl) {
    try { ensureCert(host.domain); } catch { /* non-fatal */ }
  }
  const apply = await applyConfig();
  void syncGitOps(`Expose ${host.name} (${host.domain})`);
  logEvent({ type: "host.created", severity: "notice", actor: currentUser(req)?.username ?? "system", summary: `Exposed ${host.name} at ${host.domain}`, ip: clientIp(req), meta: { id: host.id } });
  return reply.code(201).send({ host, apply });
});

app.put("/api/hosts/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const parsed = hostInput.partial().safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  snapshot(`Before updating a service`, currentUser(req)?.username ?? "system");
  const host = updateHost(id, parsed.data);
  if (!host) return reply.code(404).send({ error: "Service not found" });
  if (host.mtls) { try { ensureClientCA(host.domain); } catch { /* non-fatal */ } }
  const apply = await applyConfig();
  void syncGitOps(`Update ${host.name} (${host.domain})`);
  logEvent({ type: "host.updated", severity: "notice", actor: currentUser(req)?.username ?? "system", summary: `Updated ${host.name} (${host.domain})`, ip: clientIp(req), meta: { id: host.id } });
  return { host, apply };
});

app.delete("/api/hosts/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  snapshot(`Before removing a service`, currentUser(req)?.username ?? "system");
  if (!deleteHost(id)) return reply.code(404).send({ error: "Service not found" });
  const apply = await applyConfig();
  void syncGitOps(`Remove a service`);
  logEvent({ type: "host.deleted", severity: "warn", actor: currentUser(req)?.username ?? "system", summary: `Removed a service`, ip: clientIp(req), meta: { id } });
  return { ok: true, apply };
});

// per-host mTLS client certificates
app.get("/api/hosts/:id/client-certs", async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!getHost(id)) return reply.code(404).send({ error: "Service not found" });
  return listClientCerts(id);
});
app.post("/api/hosts/:id/client-certs", async (req, reply) => {
  const { id } = req.params as { id: string };
  const host = getHost(id);
  if (!host) return reply.code(404).send({ error: "Service not found" });
  const { name } = z.object({ name: z.string().min(1) }).parse(req.body);
  const issued = issueClientCert(id, host.domain, name);
  logEvent({ type: "cert.client_issued", severity: "notice", actor: currentUser(req)?.username ?? "admin", summary: `Issued client cert "${name}" for ${host.domain}`, ip: clientIp(req), meta: {} });
  return reply.code(201).send(issued); // cert + key shown once
});
app.delete("/api/hosts/:id/client-certs/:certId", async (req) => {
  const { certId } = req.params as { certId: string };
  return { ok: revokeClientCert(certId) };
});

// per-host uptime (availability %, history, incidents)
app.get("/api/hosts/:id/uptime", async (req, reply) => {
  const { id } = req.params as { id: string };
  const u = getUptime(id);
  if (!u) return reply.code(404).send({ error: "Service not found" });
  return u;
});

// generated nginx config preview (raw config viewer from the PRD)
app.get("/api/hosts/:id/config", async (req, reply) => {
  const { id } = req.params as { id: string };
  const host = getHost(id);
  if (!host) return reply.code(404).send({ error: "Service not found" });
  let conf: string;
  if (host.protocol === "sni") conf = generateSniPassthrough([host]);
  else if (host.protocol === "tcp" || host.protocol === "udp") conf = generateStreamConfig(host);
  else conf = generateHostConfig(host);
  return reply.type("text/plain").send(conf);
});

// "Test connection" before proceeding (PRD wizard step 2)
const testInput = z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65535) });
app.post("/api/test-connection", async (req, reply) => {
  const parsed = testInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  const { host, port } = parsed.data;
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
app.post("/api/config/versions", async (req) => {
  const { label } = z.object({ label: z.string().default("Manual snapshot") }).parse(req.body ?? {});
  return snapshot(label, currentUser(req)?.username ?? "admin");
});
app.get("/api/config/versions/:id/diff", async (req, reply) => {
  const { id } = req.params as { id: string };
  const d = diffVersion(id);
  if (!d) return reply.code(404).send({ error: "Version not found" });
  return d;
});
app.post("/api/config/versions/:id/restore", async (req, reply) => {
  const { id } = req.params as { id: string };
  snapshot("Before restore", currentUser(req)?.username ?? "admin");
  const r = restoreVersion(id);
  if (!r) return reply.code(404).send({ error: "Version not found" });
  const apply = await applyConfig();
  void syncGitOps("Restore previous config");
  logEvent({ type: "config.restored", severity: "warn", actor: currentUser(req)?.username ?? "admin", summary: `Restored config (${r.restored} services)`, ip: clientIp(req), meta: { id } });
  return { ...r, apply };
});
app.get("/api/config/export", async () => {
  return { version: "0.1.0", exportedAt: new Date().toISOString(), hosts: listHosts(), settings: getSettings() };
});
app.post("/api/config/import", async (req, reply) => {
  const { conf } = z.object({ conf: z.string().min(1) }).parse(req.body);
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
  const { range = "1d" } = req.query as { range?: string };
  return trafficSeries(range);
});

// ---------- logs + metrics ----------
app.get("/api/metrics/summary", async () => metricsSummary());
app.get("/api/metrics/traffic", async (req) => {
  const { range = "1d" } = req.query as { range?: string };
  return trafficSeries(range);
});
app.get("/api/metrics/prometheus", async (_req, reply) => {
  return reply.type("text/plain; version=0.0.4").send(prometheus());
});
app.get("/api/logs/recent", async (req) => {
  const { filter, limit } = req.query as { filter?: string; limit?: string };
  return recentLogs(filter, limit ? Number(limit) : undefined);
});
app.get("/api/logs/stream", (req, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  reply.raw.write(": connected\n\n");
  const unsub = subscribeLog((e) => reply.raw.write(`event: log\ndata: ${JSON.stringify(e)}\n\n`));
  const hb = setInterval(() => reply.raw.write(": ping\n\n"), 25000);
  req.raw.on("close", () => { clearInterval(hb); unsub(); });
});

// ---------- auth ----------
const loginInput = z.object({ username: z.string(), password: z.string(), token: z.string().optional() });
app.post("/api/auth/login", async (req, reply) => {
  const parsed = loginInput.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
  const { username, password, token } = parsed.data;
  const ip = clientIp(req);

  const row = checkCredentials(username, password);
  if (!row) {
    logEvent({ type: "login.failed", severity: "warn", actor: username, summary: "Wrong username or password", ip, meta: {} });
    return reply.code(401).send({ error: "Wrong username or password." });
  }

  if (row.twofaEnabled) {
    if (!token) return reply.send({ twofaRequired: true });
    const secret = getTwofaSecret(String(row.id));
    if (!secret || !verifyTotp(token, secret)) {
      logEvent({ type: "login.failed", severity: "warn", actor: username, summary: "Incorrect 2FA code", ip, meta: {} });
      return reply.code(401).send({ error: "That 2FA code didn't match.", twofaRequired: true });
    }
  }

  const sessionToken = createSession(String(row.id), device(req), ip);
  logEvent({ type: "login.success", severity: "info", actor: username, summary: "Signed in", ip, meta: {} });
  reply.header("set-cookie", sessionCookie(sessionToken));
  return { user: getUserById(String(row.id)) };
});

app.post("/api/auth/logout", async (req, reply) => {
  const tok = parseCookie(req.headers.cookie)[SESSION_COOKIE];
  if (tok) destroySession(tok);
  reply.header("set-cookie", clearCookie());
  return { ok: true };
});

app.get("/api/auth/me", async (req, reply) => {
  const u = currentUser(req);
  if (!u) return reply.code(401).send({ error: "Not signed in" });
  return u;
});

// auth_request target for nginx forward-auth: 200 = allowed, 401 = block.
app.get("/api/auth/forward", async (req, reply) => {
  return currentUser(req) ? reply.code(200).send({ ok: true }) : reply.code(401).send({ ok: false });
});

app.post("/api/auth/2fa/setup", async (req, reply) => {
  const u = currentUser(req)!;
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
      username: z.string().min(1),
      password: z.string().min(6),
      email: z.string().optional(),
      role: z.enum(["admin", "editor", "readonly", "scoped"]).default("readonly"),
      scope: z.string().optional(),
    })
    .parse(req.body);
  const user = createUser(body);
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

app.get("/api/sessions", async () => listSessions());

// ---------- audit + security posture ----------
app.get("/api/audit", async (req) => {
  const { type, limit } = req.query as { type?: string; limit?: string };
  return listEvents({ type, limit: limit ? Number(limit) : undefined });
});
app.get("/api/security/overview", async () => securityOverview());
app.get("/api/security/exposure", async () => securityExposure());

// ---------- IP bans (fail2ban-style) ----------
app.get("/api/bans", async () => listBans());
app.post("/api/bans", async (req, reply) => {
  const { ip, reason } = z.object({ ip: z.string().min(3), reason: z.string().default("Manually banned") }).parse(req.body);
  const ban = addBan(ip, reason, "manual");
  logEvent({ type: "security.ip_banned", severity: "warn", actor: currentUser(req)?.username ?? "admin", summary: `Banned ${ip}`, ip: clientIp(req), meta: { source: "manual" } });
  return reply.code(201).send(ban);
});
app.delete("/api/bans/:ip", async (req) => {
  const { ip } = req.params as { ip: string };
  const ok = removeBan(decodeURIComponent(ip));
  if (ok) logEvent({ type: "security.ip_unbanned", severity: "info", actor: currentUser(req)?.username ?? "admin", summary: `Unbanned ${ip}`, ip: clientIp(req), meta: {} });
  return { ok };
});

// ---------- certificates ----------
app.get("/api/certificates", async () => listCerts());

app.post("/api/certificates/:domain/issue", async (req, reply) => {
  const { domain } = req.params as { domain: string };
  const { method } = z
    .object({ method: z.enum(["selfsigned", "http-01", "dns-01"]).default("selfsigned") })
    .parse(req.body ?? {});
  try {
    const cert = await issue(domain, method as CertMethod);
    await applyConfig(); // pick up the new cert paths
    logEvent({ type: "cert.issued", severity: "info", actor: currentUser(req)?.username ?? "system", summary: `Issued ${method} certificate for ${domain}`, ip: clientIp(req), meta: {} });
    return cert;
  } catch (e) {
    return reply.code(422).send({ error: e instanceof Error ? e.message : "Issuance failed." });
  }
});

app.post("/api/certificates/:domain/renew", async (req, reply) => {
  const { domain } = req.params as { domain: string };
  const cert = getCert(domain);
  if (!cert) return reply.code(404).send({ error: "No certificate for that domain." });
  try {
    const next = await issue(domain, cert.method);
    await applyConfig();
    return next;
  } catch (e) {
    return reply.code(422).send({ error: e instanceof Error ? e.message : "Renewal failed." });
  }
});

app.put("/api/certificates/:domain/autorenew", async (req) => {
  const { domain } = req.params as { domain: string };
  const { on } = z.object({ on: z.boolean() }).parse(req.body);
  setAutoRenew(domain, on);
  return getCert(domain);
});

app.delete("/api/certificates/:domain", async (req) => {
  const { domain } = req.params as { domain: string };
  deleteCert(domain);
  return { ok: true };
});

// ---------- agents: tokens ----------
app.get("/api/tokens", async () => listTokens());
app.post("/api/tokens", async (req, reply) => {
  const body = z
    .object({
      name: z.string().min(1),
      scopes: z.array(z.enum(["read", "report", "control", "security"])).min(1),
      trust: z.enum(["untrusted", "trusted"]).default("untrusted"),
    })
    .parse(req.body);
  const { token, record } = createToken(body);
  logEvent({ type: "agent.token_created", severity: "notice", actor: currentUser(req)?.username ?? "admin", summary: `Created API token "${body.name}"`, ip: clientIp(req), meta: { scopes: body.scopes } });
  return reply.code(201).send({ token, record }); // raw token shown once
});
app.delete("/api/tokens/:id", async (req) => {
  const { id } = req.params as { id: string };
  revokeToken(id);
  return { ok: true };
});

// ---------- agents: tools, approvals, overview ----------
app.get("/api/agents/tools", async () => toolCatalog());
app.get("/api/agents/approvals", async (req) => {
  const { status } = req.query as { status?: string };
  return listApprovals(status);
});
app.post("/api/agents/approvals/:id/approve", async (req, reply) => {
  const { id } = req.params as { id: string };
  const ap = await decideApproval(id, true, currentUser(req)?.username ?? "admin");
  if (!ap) return reply.code(404).send({ error: "Approval not found" });
  return ap;
});
app.post("/api/agents/approvals/:id/deny", async (req, reply) => {
  const { id } = req.params as { id: string };
  const ap = await decideApproval(id, false, currentUser(req)?.username ?? "admin");
  if (!ap) return reply.code(404).send({ error: "Approval not found" });
  return ap;
});
app.get("/api/agents/overview", async () => ({
  agents: listTokens().length,
  tools: toolCatalog().length,
  pendingApprovals: listApprovals("pending").length,
  webhooks: listWebhooks().length,
}));

// ---------- agents: webhooks ----------
app.get("/api/webhooks", async () => listWebhooks());
app.post("/api/webhooks", async (req, reply) => {
  const body = z.object({ url: z.string().url(), events: z.array(z.string()).default(["*"]) }).parse(req.body);
  const { webhook, secret } = createWebhook(body.url, body.events);
  return reply.code(201).send({ webhook, secret }); // secret shown once
});
app.delete("/api/webhooks/:id", async (req) => {
  const { id } = req.params as { id: string };
  deleteWebhook(id);
  return { ok: true };
});

// ---------- notification channels ----------
app.get("/api/channels", async () => listChannels());
app.post("/api/channels", async (req, reply) => {
  const body = z
    .object({
      type: z.enum(["ntfy", "gotify", "pushover", "discord", "slack", "telegram", "webhook", "email"]),
      name: z.string().min(1),
      config: z.record(z.string(), z.string()).default({}),
      events: z.array(z.string()).default(["*"]),
    })
    .parse(req.body);
  const ch = createChannel({ type: body.type as ChannelType, name: body.name, config: body.config, events: body.events });
  logEvent({ type: "alert.channel_added", severity: "notice", actor: currentUser(req)?.username ?? "admin", summary: `Added ${body.type} notification channel "${body.name}"`, ip: clientIp(req), meta: {} });
  return reply.code(201).send(ch);
});
app.put("/api/channels/:id/enabled", async (req) => {
  const { id } = req.params as { id: string };
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
  setChannelEnabled(id, enabled);
  return { ok: true };
});
app.delete("/api/channels/:id", async (req) => {
  const { id } = req.params as { id: string };
  deleteChannel(id);
  return { ok: true };
});
app.post("/api/channels/:id/test", async (req) => {
  const { id } = req.params as { id: string };
  return testChannel(id);
});

// ---------- MCP server (JSON-RPC over HTTP; session or Bearer token) ----------
app.post("/api/mcp", async (req, reply) => {
  const me = principal(req)!;
  const body = req.body as Record<string, unknown> | Record<string, unknown>[];
  const handle = (m: Record<string, unknown>) => handleMcp(me, m as never);
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(handle))).filter(Boolean);
    return reply.send(out);
  }
  const res = await handle(body);
  if (res === null) return reply.code(204).send();
  return reply.send(res);
});

// ---------- SSE event stream ----------
app.get("/api/events/sse", (req, reply) => {
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
  if (seeded.adminPassword) {
    app.log.warn(`First run — admin account created. Username: "tarun"  Password: "${seeded.adminPassword}"  (change it after signing in)`);
  }
  // Render the data plane on boot so nginx serves the managed hosts.
  const result = await applyConfig();
  app.log.info(`nginx apply on boot: ${result.message}`);
  // Daily auto-renewal + cert status refresh.
  startRenewalScheduler();
  // Metrics: tail nginx access logs; in dev, feed synthetic traffic through the same pipeline.
  startLogTailer();
  if (process.env.NODE_ENV !== "production" || process.env.NGINUX_DEMO_TRAFFIC === "1") {
    startDemoTraffic();
    app.log.info("demo traffic generator on (dev) — feeding the metrics pipeline");
  }
  // Uptime monitoring + alert routing + brute-force auto-ban.
  startUptimeMonitor();
  initAlertEngine();
  startBanEngine();
});

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

