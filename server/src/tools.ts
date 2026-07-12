import { randomUUID } from "node:crypto";
import { db, getSettings, redactSettings, saveSettings } from "./db.ts";
import { listEvents, listUsers, logEvent, scopedAllows, securityExposure, securityOverview, type User } from "./auth.ts";
import { createHost, deleteHost, getHost, getHostByDomain, getTopology, listHosts, updateHost } from "./repo.ts";
import { deleteCert, ensureCert, getCert, getCertDetails, issue, listCerts, setAutoRenew } from "./certs.ts";
import { applyConfig, generateHostConfig, generateSniPassthrough, generateStreamConfig, redactConfig } from "./nginx.ts";
import { deleteGeoipDb, downloadGeoipDb, geoipStatus, writeGeoipConf } from "./geoip.ts";
import { addBan, listBans, removeBan } from "./bans.ts";
import { issueClientCert, listClientCerts, revokeClientCert, writeClientCrl } from "./clientcerts.ts";
import { getUptime } from "./uptime.ts";
import { hostStats, recentLogs, rangeSummary as metricsRangeSummary, summary as metricsSummary, trafficSeries } from "./metrics.ts";
import { PRESETS } from "./presets.ts";
import type { AgentPrincipal, Scope } from "./tokens.ts";
import { isHost, isHostname, isIpOrCidr } from "./validate.ts";
import { hostInput, isControlPlaneDomain, validName } from "./hostschema.ts";
import type { NewProxyHost, ProxyHost, Settings } from "./types.ts";

// Agents reach updateHost/createHost WITHOUT the REST zod schema, so validate
// here too. Fields an agent may never set via the generic update_service tool:
//  - raw-config / DB-managed (id, domain, customNginx, health, timestamps);
//  - security POSTURE fields. Weakening protection must not be possible through a
//    control-scope, auto-approvable edit. Raising the login gate has its own tool
//    (enable_login); lowering it requires the security scope + approval
//    (disable_login). The rest (mtls, countryLock, header/exploit toggles, IP
//    allow/deny) are admin-only via the REST UI - never via an agent tool.
const FORBIDDEN_TOOL_FIELDS = new Set([
  "id", "domain", "customNginx", "health", "certExpiresAt", "createdAt", "updatedAt",
  "requireLogin", "require2fa", "mtls", "countryLock", "securityHeaders", "hsts",
  "blockExploits", "ipAllow", "ipDeny",
]);

/** Strip forbidden fields, then validate the rest through the SAME schema the
 *  REST boundary uses (`hostInput`, partial). This is the agent-path security
 *  boundary; routing it through the shared schema means the field rules
 *  (injection sinks, enums, numeric bounds, iconUrl) can no longer drift looser
 *  than REST. Throws on bad input. Exported for regression tests. */
export function sanitizeHostPatch(raw: Record<string, unknown>): Partial<ProxyHost> {
  // 1. Drop fields an agent may never set: DB-managed / raw-config / security
  //    posture. Stripping BEFORE validation matters - these fields exist in the
  //    schema and would otherwise pass as "valid" (e.g. requireLogin:false).
  const candidate: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (FORBIDDEN_TOOL_FIELDS.has(k)) continue;
    candidate[k] = v;
  }
  // 2. Validate the remainder with the shared schema (partial: only-present fields).
  const parsed = hostInput.partial().safeParse(candidate);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => i.message).join("; ") || "Invalid host patch.");
  }
  return parsed.data as Partial<ProxyHost>;
}

export type Tier = "read" | "low" | "medium" | "high";
export type Principal = AgentPrincipal | { kind: "user"; name: string; scopes: Scope[]; user: User };

export interface Tool {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  tier: Tier;
  /** Restrict to admin users (and scoped tokens with the scope) - for ops a
   *  non-admin operator can't do in the REST UI either (settings, bans, users). */
  adminOnly?: boolean;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, principal?: Principal) => Promise<unknown> | unknown;
  summarize: (args: Record<string, unknown>) => string;
}

const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  required,
});

// ---------- host visibility (scoped users only see hosts in their scope) ----------
// scopedAllows is the shared canonical predicate from auth.ts (imported above) so
// REST, MCP tools, and MCP resources cannot drift.
function canSeeHost(p: Principal | undefined, host: Pick<ProxyHost, "id" | "name" | "domain">): boolean {
  if (p?.kind === "user" && p.user.role === "scoped") return scopedAllows(p.user, host);
  return true; // tokens & non-scoped users: feature-scope already gates the tool
}
function visibleHosts(p: Principal | undefined): ProxyHost[] {
  const hosts = listHosts();
  return p?.kind === "user" && p.user.role === "scoped" ? hosts.filter((h) => scopedAllows(p.user, h)) : hosts;
}

/** Which feature-scopes a logged-in user's role grants when calling tools via
 *  MCP - mirrors the REST RBAC so the agent path can't be a privilege bypass. */
export function scopesForRole(role: User["role"]): Scope[] {
  switch (role) {
    case "admin":
    case "editor":
      return ["read", "report", "control", "security"];
    default: // readonly + scoped: read-only via MCP (scoped is host-filtered)
      return ["read"];
  }
}

const SETTING_KEYS: (keyof Settings)[] = [
  "instanceName", "baseDomain", "theme", "letsEncryptEmail", "homeCountry",
  "publicIp", "gatewayIp", "dnsProvider", "godaddyApiKey", "godaddySecret", "cloudflareApiToken",
  "maxmindLicenseKey", "acmeStaging", "agentAutoApprove", "gitOpsEnabled",
];

const hostConfigFor = (h: ProxyHost): string =>
  h.protocol === "sni" ? generateSniPassthrough([h])
    : h.protocol === "tcp" || h.protocol === "udp" ? generateStreamConfig(h)
      : generateHostConfig(h);

/** Apply after a host mutation; if nginx REJECTS the config (the whole conf.d is
 *  validated atomically), run `revert` to undo the DB change, re-apply the now
 *  last-good state, and throw. Without this an agent-created bad host stays in the
 *  DB and poisons EVERY future apply (bans, cert renewals, unrelated edits all
 *  regenerate + re-fail `nginx -t`). Mirrors the revert the REST routes do. */
async function applyOrRevert(revert: () => void): Promise<void> {
  const apply = await applyConfig();
  if (!apply.ok && apply.nginxAvailable) {
    revert();
    await applyConfig(); // re-apply the reverted, last-good config
    throw new Error(apply.message || "nginx rejected the change, so it was rolled back.");
  }
}

export const TOOLS: Record<string, Tool> = {
  // ---------------- read: basic (readonly/scoped-visible) ----------------
  list_services: {
    name: "list_services", title: "List services", scope: "read", tier: "read",
    description: "All proxy hosts with status, routes and protection.",
    inputSchema: obj({}), summarize: () => "list services",
    handler: (_a, p) => visibleHosts(p),
  },
  get_service: {
    name: "get_service", title: "Get a service", scope: "read", tier: "read",
    description: "Full detail for one host by id.",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    summarize: (a) => `get service ${a.id}`,
    handler: (a, p) => { const h = getHost(String(a.id)); return h && canSeeHost(p, h) ? h : null; },
  },
  get_service_config: {
    name: "get_service_config", title: "View generated nginx config", scope: "read", tier: "read",
    description: "The nginx config NginUX generates for one host.",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    summarize: (a) => `config for service ${a.id}`,
    handler: (a, p) => { const h = getHost(String(a.id)); if (!h || !canSeeHost(p, h)) return null; return { domain: h.domain, config: redactConfig(hostConfigFor(h)) }; },
  },
  get_service_uptime: {
    name: "get_service_uptime", title: "Service uptime", scope: "read", tier: "read",
    description: "Availability %, recent checks and incidents for a host.",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    summarize: (a) => `uptime for service ${a.id}`,
    handler: (a, p) => { const h = getHost(String(a.id)); if (!h || !canSeeHost(p, h)) return null; return getUptime(String(a.id)); },
  },
  list_client_certs: {
    name: "list_client_certs", title: "List mTLS client certs", scope: "read", tier: "read",
    description: "Issued client certificates for a host (metadata only).",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    summarize: (a) => `list client certs for ${a.id}`,
    handler: (a, p) => { const h = getHost(String(a.id)); if (!h || !canSeeHost(p, h)) return null; return listClientCerts(String(a.id)); },
  },
  get_topology: {
    name: "get_topology", title: "Network topology", scope: "read", tier: "read",
    description: "Servers, services and the gateway, for the network map.",
    inputSchema: obj({}), summarize: () => "topology",
    handler: (_a, p) => { const s = getSettings(); return getTopology({ publicIp: s.publicIp, gatewayIp: s.gatewayIp }, visibleHosts(p)); },
  },
  list_presets: {
    name: "list_presets", title: "List app presets", scope: "read", tier: "read",
    description: "Built-in app presets (Plex, Home Assistant, …) and their defaults.",
    inputSchema: obj({}), summarize: () => "list presets",
    handler: () => Object.values(PRESETS),
  },
  get_geoip_status: {
    name: "get_geoip_status", title: "GeoIP status", scope: "read", tier: "read",
    description: "Whether the MaxMind GeoIP database is installed and active.",
    inputSchema: obj({}), summarize: () => "geoip status",
    handler: () => geoipStatus(),
  },
  get_settings: {
    name: "get_settings", title: "Get settings", scope: "read", tier: "read",
    description: "Instance settings. Provider credentials are always redacted.",
    inputSchema: obj({}), summarize: () => "get settings",
    handler: () => redactSettings(getSettings()), // never expose real secrets to a caller
  },
  get_health: {
    name: "get_health", title: "Health check", scope: "read", tier: "read",
    description: "NginUX control-plane health.",
    inputSchema: obj({}), summarize: () => "health",
    handler: () => ({ status: "ok", time: new Date().toISOString() }),
  },

  // ---------------- read: sensitive (admin/editor or report-scoped token) ----------------
  list_certificates: {
    name: "list_certificates", title: "List certificates", scope: "report", tier: "read",
    description: "All certificates with expiry, issuer and status.",
    inputSchema: obj({}), summarize: () => "list certificates",
    handler: () => listCerts(),
  },
  get_certificate: {
    name: "get_certificate", title: "Certificate detail", scope: "report", tier: "read",
    description: "Parsed detail for the cert file of a domain (issuer, SANs, key, expiry).",
    inputSchema: obj({ domain: { type: "string" } }, ["domain"]),
    summarize: (a) => `certificate detail ${a.domain}`,
    handler: (a) => { if (!isHostname(String(a.domain))) throw new Error("Invalid domain."); return getCertDetails(String(a.domain)); },
  },
  get_security_audit: {
    name: "get_security_audit", title: "Security audit", scope: "report", tier: "read",
    description: "What's exposed and the overall security posture/score.",
    inputSchema: obj({}), summarize: () => "security audit",
    handler: () => ({ overview: securityOverview(), exposure: securityExposure() }),
  },
  get_metrics: {
    name: "get_metrics", title: "Traffic metrics", scope: "report", tier: "read",
    description: "Request/bandwidth totals, p95, error rate, top IPs/paths/countries. Pass range (live|1h|4h|1d|7d|30d) to scope every panel to that window; omit for the cumulative snapshot.",
    inputSchema: obj({ range: { type: "string", enum: ["live", "1h", "4h", "1d", "7d", "30d"] } }),
    summarize: (a) => (a.range ? `metrics ${a.range}` : "metrics summary"),
    handler: (a) => (a.range ? metricsRangeSummary(String(a.range)) : metricsSummary()),
  },
  get_traffic: {
    name: "get_traffic", title: "Traffic series", scope: "report", tier: "read",
    description: "Time series of traffic for a range (live|1h|4h|1d|7d|30d).",
    inputSchema: obj({ range: { type: "string" } }),
    summarize: (a) => `traffic ${a.range ?? "1d"}`,
    handler: (a) => ({ series: trafficSeries(String(a.range ?? "1d")), hosts: hostStats(String(a.range ?? "live")) }),
  },
  list_bans: {
    name: "list_bans", title: "List IP bans", scope: "report", tier: "read",
    description: "Active IP bans (manual + auto/fail2ban).",
    inputSchema: obj({}), summarize: () => "list bans",
    handler: () => listBans(),
  },
  recent_logs: {
    name: "recent_logs", title: "Recent access logs", scope: "report", tier: "read",
    description: "Recent access-log lines (optionally filtered).",
    inputSchema: obj({ filter: { type: "string" }, limit: { type: "number" } }),
    summarize: (a) => `recent logs${a.filter ? ` (${a.filter})` : ""}`,
    handler: (a) => recentLogs(a.filter ? String(a.filter) : undefined, a.limit ? Math.min(1000, Math.max(1, Number(a.limit))) : 100),
  },
  list_audit_events: {
    name: "list_audit_events", title: "Audit log", scope: "report", tier: "read",
    description: "Recent audit/security events (optionally by type).",
    inputSchema: obj({ type: { type: "string" }, limit: { type: "number" } }),
    summarize: (a) => `audit events${a.type ? ` (${a.type})` : ""}`,
    handler: (a) => listEvents({ type: a.type ? String(a.type) : undefined, limit: a.limit ? Math.min(1000, Math.max(1, Number(a.limit))) : 100 }),
  },
  list_users: {
    name: "list_users", title: "List users", scope: "report", tier: "read", adminOnly: true,
    description: "User accounts (username, role, 2FA, last login) - no secrets.",
    inputSchema: obj({}), summarize: () => "list users",
    handler: () => listUsers(),
  },

  // ---------------- control: services ----------------
  create_service: {
    name: "create_service", title: "Expose a service", scope: "control", tier: "medium",
    description: "Create a proxy host (DNS-ready) and serve it over HTTPS.",
    inputSchema: obj({
      name: { type: "string" }, domain: { type: "string" }, forwardHost: { type: "string" },
      forwardPort: { type: "number" }, forwardScheme: { type: "string", enum: ["http", "https"] },
      preset: { type: "string" }, ssl: { type: "boolean" }, websockets: { type: "boolean" },
      http2: { type: "boolean" }, requireLogin: { type: "boolean" }, require2fa: { type: "boolean" },
    }, ["name", "domain", "forwardHost", "forwardPort"]),
    summarize: (a) => `expose ${a.name} at ${a.domain}`,
    handler: async (a) => {
      const domain = String(a.domain), forwardHost = String(a.forwardHost);
      if (!validName(String(a.name))) throw new Error("Invalid name.");
      if (!isHostname(domain)) throw new Error("Invalid domain.");
      if (!isHost(forwardHost)) throw new Error("Invalid forwardHost.");
      const port = Number(a.forwardPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid forwardPort.");
      // Mirror the REST guards: clear duplicate-domain error, and don't let an
      // agent repoint NginUX's own portal domain away from the control plane.
      if (getHostByDomain(domain)) throw new Error(`${domain} is already in use.`);
      if (isControlPlaneDomain(domain, port)) throw new Error("That domain is where NginUX itself runs; forward it to the control plane on port 6767 or pick another.");
      const host = createHost({
        name: String(a.name), domain,
        forwardScheme: a.forwardScheme === "https" ? "https" : "http", forwardHost, forwardPort: port,
        preset: String(a.preset ?? "custom"), websockets: a.websockets === true, http2: a.http2 !== false,
        ssl: a.ssl !== false, requireLogin: a.requireLogin !== false, require2fa: a.require2fa === true,
        countryLock: false, serverGroup: forwardHost, serverIp: forwardHost, enabled: true,
      } as NewProxyHost);
      if (host.ssl) { try { await ensureCert(host.domain); } catch { /* non-fatal */ } }
      await applyOrRevert(() => deleteHost(host.id));
      return host;
    },
  },
  update_service: {
    name: "update_service", title: "Update a service", scope: "control", tier: "medium",
    description: "Edit a host's routing or options (cannot set raw nginx directives).",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    summarize: (a) => `update service ${a.id}`,
    handler: async (a) => { const { id, ...patch } = a; const prev = getHost(String(id)); const h = updateHost(String(id), sanitizeHostPatch(patch)); await applyOrRevert(() => { if (prev) updateHost(String(id), prev); }); return h; },
  },
  set_service_enabled: {
    name: "set_service_enabled", title: "Enable/pause a service", scope: "control", tier: "low",
    description: "Serve (enabled=true) or pause (enabled=false) a host without deleting it.",
    inputSchema: obj({ id: { type: "string" }, enabled: { type: "boolean" } }, ["id", "enabled"]),
    summarize: (a) => `${a.enabled === false ? "pause" : "serve"} service ${a.id}`,
    handler: async (a) => { const prev = getHost(String(a.id)); const h = updateHost(String(a.id), { enabled: a.enabled !== false }); await applyOrRevert(() => { if (prev) updateHost(String(a.id), prev); }); return h; },
  },
  enable_login: {
    name: "enable_login", title: "Require login on a host", scope: "control", tier: "low",
    description: "Add the NginUX login gate back to a host (raises protection).",
    inputSchema: obj({ id: { type: "string" }, require2fa: { type: "boolean" } }, ["id"]),
    summarize: (a) => `require login on service ${a.id}`,
    handler: async (a) => { const prev = getHost(String(a.id)); const h = updateHost(String(a.id), { requireLogin: true, require2fa: a.require2fa === true }); await applyOrRevert(() => { if (prev) updateHost(String(a.id), prev); }); return h; },
  },

  // ---------------- control: certificates ----------------
  issue_cert: {
    name: "issue_cert", title: "Issue/renew certificate", scope: "control", tier: "low",
    description: "Issue or renew a certificate (selfsigned | http-01 | dns-01).",
    inputSchema: obj({ domain: { type: "string" }, method: { type: "string", enum: ["selfsigned", "http-01", "dns-01"] } }, ["domain"]),
    summarize: (a) => `issue ${a.method ?? "selfsigned"} cert for ${a.domain}`,
    handler: async (a) => { if (!isHostname(String(a.domain))) throw new Error("Invalid domain."); const c = await issue(String(a.domain), (a.method as "selfsigned") ?? "selfsigned"); await applyConfig(); return c; },
  },
  renew_cert: {
    name: "renew_cert", title: "Renew certificate", scope: "control", tier: "low",
    description: "Renew an existing certificate using its current method.",
    inputSchema: obj({ domain: { type: "string" } }, ["domain"]),
    summarize: (a) => `renew cert for ${a.domain}`,
    handler: async (a) => { if (!isHostname(String(a.domain))) throw new Error("Invalid domain."); const cur = getCert(String(a.domain)); const c = await issue(String(a.domain), cur?.method ?? "selfsigned"); await applyConfig(); return c; },
  },
  set_cert_autorenew: {
    name: "set_cert_autorenew", title: "Toggle cert auto-renew", scope: "control", tier: "low",
    description: "Enable or disable automatic renewal for a domain's certificate.",
    inputSchema: obj({ domain: { type: "string" }, on: { type: "boolean" } }, ["domain", "on"]),
    summarize: (a) => `${a.on ? "enable" : "disable"} auto-renew for ${a.domain}`,
    handler: (a) => { if (!isHostname(String(a.domain))) throw new Error("Invalid domain."); setAutoRenew(String(a.domain), a.on !== false); return getCert(String(a.domain)); },
  },
  delete_certificate: {
    name: "delete_certificate", title: "Delete certificate", scope: "control", tier: "medium",
    description: "Delete a domain's certificate (it falls back to the bootstrap cert).",
    inputSchema: obj({ domain: { type: "string" } }, ["domain"]),
    summarize: (a) => `delete certificate for ${a.domain}`,
    handler: async (a) => { if (!isHostname(String(a.domain))) throw new Error("Invalid domain."); deleteCert(String(a.domain)); const apply = await applyConfig(); return { ok: true, apply }; },
  },
  issue_client_cert: {
    name: "issue_client_cert", title: "Issue mTLS client cert", scope: "control", tier: "medium",
    description: "Issue a client certificate for a host's mTLS CA (returns the key once).",
    inputSchema: obj({ id: { type: "string" }, name: { type: "string" } }, ["id", "name"]),
    summarize: (a) => `issue client cert "${a.name}" for ${a.id}`,
    handler: async (a) => { const h = getHost(String(a.id)); if (!h) throw new Error("Service not found."); return issueClientCert(h.id, h.domain, String(a.name)); },
  },

  // ---------------- control: GeoIP ----------------
  geoip_download: {
    name: "geoip_download", title: "Download GeoIP database", scope: "control", tier: "medium",
    description: "Download the MaxMind GeoLite2-Country DB (needs a license key in settings).",
    inputSchema: obj({}), summarize: () => "download GeoIP database",
    handler: async () => {
      const r = await downloadGeoipDb();
      writeGeoipConf();
      const apply = await applyConfig();
      if (!apply.ok && apply.nginxAvailable) { deleteGeoipDb(); writeGeoipConf(); await applyConfig(); throw new Error(`nginx rejected the geo config: ${apply.message}`); }
      return { ok: true, sizeBytes: r.sizeBytes, status: geoipStatus() };
    },
  },
  geoip_delete: {
    name: "geoip_delete", title: "Remove GeoIP database", scope: "control", tier: "medium",
    description: "Remove the GeoIP database (country lock falls back to allow-all).",
    inputSchema: obj({}), summarize: () => "remove GeoIP database",
    handler: async () => { deleteGeoipDb(); writeGeoipConf(); const apply = await applyConfig(); return { ok: true, apply }; },
  },

  // ---------------- security / destructive ----------------
  disable_login: {
    name: "disable_login", title: "Disable login on a host", scope: "security", tier: "high",
    description: "Remove the NginUX login gate - makes the host publicly reachable.",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    summarize: (a) => `disable login on service ${a.id}`,
    handler: async (a) => { const h = updateHost(String(a.id), { requireLogin: false, require2fa: false }); await applyConfig(); return h; },
  },
  delete_service: {
    name: "delete_service", title: "Delete a service", scope: "control", tier: "high",
    description: "Remove a host entirely (takes it offline).",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    summarize: (a) => `delete service ${a.id}`,
    handler: async (a) => { const ok = deleteHost(String(a.id)); await applyConfig(); return { ok }; },
  },
  revoke_client_cert: {
    name: "revoke_client_cert", title: "Revoke mTLS client cert", scope: "security", tier: "high",
    description: "Revoke a client certificate (publishes the CRL so nginx refuses it).",
    inputSchema: obj({ id: { type: "string" }, certId: { type: "string" } }, ["id", "certId"]),
    summarize: (a) => `revoke client cert ${a.certId} on ${a.id}`,
    handler: async (a) => {
      const h = getHost(String(a.id)); if (!h) throw new Error("Service not found.");
      if (!listClientCerts(h.id).some((c) => c.id === String(a.certId))) throw new Error("Certificate not found for this service.");
      const ok = revokeClientCert(String(a.certId));
      if (ok) { writeClientCrl(h.domain); await applyConfig(); }
      return { ok };
    },
  },
  add_ban: {
    name: "add_ban", title: "Ban an IP", scope: "security", tier: "low", adminOnly: true,
    description: "Block an IP/CIDR at the proxy.",
    inputSchema: obj({ ip: { type: "string" }, reason: { type: "string" } }, ["ip"]),
    summarize: (a) => `ban ${a.ip}`,
    handler: (a) => { if (!isIpOrCidr(String(a.ip))) throw new Error("Invalid IP or CIDR."); return addBan(String(a.ip), String(a.reason ?? "Banned via API"), "manual"); },
  },
  remove_ban: {
    name: "remove_ban", title: "Unban an IP", scope: "security", tier: "medium", adminOnly: true,
    description: "Remove an IP/CIDR from the ban list.",
    inputSchema: obj({ ip: { type: "string" } }, ["ip"]),
    summarize: (a) => `unban ${a.ip}`,
    handler: (a) => ({ ok: removeBan(String(a.ip)) }),
  },

  // ---------------- admin: settings ----------------
  update_settings: {
    name: "update_settings", title: "Update settings", scope: "security", tier: "high", adminOnly: true,
    description: "Change instance settings (e.g. homeCountry, dnsProvider, letsEncryptEmail). Provider credentials can be set but never read back.",
    inputSchema: obj({ patch: { type: "object" } }, ["patch"]),
    summarize: () => "update settings",
    handler: async (a) => {
      const raw = (a.patch as Record<string, unknown>) ?? {};
      const patch: Partial<Settings> = {};
      for (const k of SETTING_KEYS) if (k in raw) (patch as Record<string, unknown>)[k] = raw[k];
      saveSettings(patch);
      writeGeoipConf();
      await applyConfig();
      return redactSettings(getSettings());
    },
  },
};

export function toolCatalog() {
  return Object.values(TOOLS).map((t) => ({
    name: t.name, title: t.title, description: t.description, scope: t.scope, tier: t.tier, adminOnly: !!t.adminOnly, inputSchema: t.inputSchema,
  }));
}

/** True if this caller is allowed to invoke the tool (scope + adminOnly). */
export function canCallTool(principal: Principal, t: { scope: Scope; adminOnly?: boolean }): boolean {
  if (!principal.scopes.includes(t.scope)) return false;
  if (t.adminOnly && principal.kind === "user" && principal.user.role !== "admin") return false;
  return true;
}

/** The subset of the catalog this caller can actually use. */
export function toolCatalogFor(principal: Principal) {
  return toolCatalog().filter((t) => canCallTool(principal, t));
}

// ---------- approvals ----------
export interface Approval {
  id: string;
  ts: string;
  agent: string;
  tool: string;
  args: Record<string, unknown>;
  tier: Tier;
  summary: string;
  status: "pending" | "executed" | "denied";
  result: unknown;
  decidedBy: string | null;
  decidedAt: string | null;
}

type Row = Record<string, unknown>;
function toApproval(r: Row): Approval {
  return {
    id: String(r.id), ts: String(r.ts), agent: String(r.agent), tool: String(r.tool),
    args: JSON.parse(String(r.args)), tier: r.tier as Tier, summary: String(r.summary),
    status: r.status as Approval["status"], result: r.result ? JSON.parse(String(r.result)) : null,
    decidedBy: r.decidedBy ? String(r.decidedBy) : null, decidedAt: r.decidedAt ? String(r.decidedAt) : null,
  };
}

export function listApprovals(status?: string): Approval[] {
  const rows = status
    ? (db.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY ts DESC").all(status) as Row[])
    : (db.prepare("SELECT * FROM approvals ORDER BY ts DESC LIMIT 100").all() as Row[]);
  return rows.map(toApproval);
}

// ---------- dispatch ----------
export interface ToolResult {
  status: "ok" | "pending_approval" | "error";
  tool: string;
  tier?: Tier;
  result?: unknown;
  approvalId?: string;
  message?: string;
}

export function needsApproval(tier: Tier, principal: Principal): boolean {
  if (tier === "read") return false;
  if (principal.kind === "user") return false; // a human in the UI is the approver
  if (tier === "high") return true; // never auto-approve destructive
  const policy = getSettings().agentAutoApprove;
  if (!policy) return true;
  if (principal.trust !== "trusted") return true; // only trusted agents auto-run
  return false; // low/medium for a trusted agent auto-runs
}

export async function callTool(principal: Principal, name: string, rawArgs: Record<string, unknown>): Promise<ToolResult> {
  const tool = TOOLS[name];
  if (!tool) return { status: "error", tool: name, message: `Unknown tool: ${name}` };
  if (!principal.scopes.includes(tool.scope)) {
    return { status: "error", tool: name, message: `This caller lacks the "${tool.scope}" scope needed for ${name}.` };
  }
  // adminOnly tools: a non-admin USER may not run them (matches the REST UI).
  // Agent tokens still need the scope, which an admin granted deliberately.
  if (tool.adminOnly && principal.kind === "user" && principal.user.role !== "admin") {
    return { status: "error", tool: name, message: `${name} requires an admin.` };
  }
  const args = rawArgs ?? {};

  if (needsApproval(tool.tier, principal)) {
    const id = randomUUID();
    const summary = tool.summarize(args);
    db.prepare(
      "INSERT INTO approvals (id, ts, agent, tool, args, tier, summary, status) VALUES (?,?,?,?,?,?,?, 'pending')",
    ).run(id, new Date().toISOString(), principal.name, name, JSON.stringify(args), tool.tier, summary);
    logEvent({ type: "agent.approval_requested", severity: "notice", actor: principal.name, summary: `Wants to ${summary}`, ip: "", meta: { tool: name, tier: tool.tier, approvalId: id } });
    return { status: "pending_approval", tool: name, tier: tool.tier, approvalId: id, message: `Queued for human approval: ${summary}` };
  }

  try {
    const result = await tool.handler(args, principal);
    logEvent({ type: "agent.tool_called", severity: "info", actor: principal.name, summary: tool.summarize(args), ip: "", meta: { tool: name, tier: tool.tier } });
    return { status: "ok", tool: name, tier: tool.tier, result };
  } catch (err) {
    return { status: "error", tool: name, message: err instanceof Error ? err.message : "Tool failed." };
  }
}

export async function decideApproval(id: string, approve: boolean, decidedBy: string): Promise<Approval | null> {
  const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Row | undefined;
  if (!row) return null;
  const ap = toApproval(row);
  if (ap.status !== "pending") return ap;

  if (!approve) {
    db.prepare("UPDATE approvals SET status='denied', decidedBy=?, decidedAt=? WHERE id=?").run(decidedBy, new Date().toISOString(), id);
    logEvent({ type: "agent.approval_denied", severity: "notice", actor: decidedBy, summary: `Denied: ${ap.summary}`, ip: "", meta: { tool: ap.tool } });
    return toApproval(db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Row);
  }

  const tool = TOOLS[ap.tool];
  let result: unknown = null;
  try {
    result = tool ? await tool.handler(ap.args) : { error: "tool no longer exists" };
  } catch (err) {
    result = { error: err instanceof Error ? err.message : "execution failed" };
  }
  db.prepare("UPDATE approvals SET status='executed', result=?, decidedBy=?, decidedAt=? WHERE id=?").run(
    JSON.stringify(result), decidedBy, new Date().toISOString(), id,
  );
  logEvent({ type: "agent.approved", severity: "notice", actor: decidedBy, summary: `Approved: ${ap.summary}`, ip: "", meta: { tool: ap.tool } });
  return toApproval(db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Row);
}
