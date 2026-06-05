import { randomUUID } from "node:crypto";
import { db, rowToHost } from "./db.ts";
import type { HealthStatus, NewProxyHost, ProxyHost, Topology, TopologyServer } from "./types.ts";

export function listHosts(): ProxyHost[] {
  return (db.prepare("SELECT * FROM hosts ORDER BY name").all() as Record<string, unknown>[]).map(
    rowToHost,
  );
}

export function getHost(id: string): ProxyHost | null {
  const row = db.prepare("SELECT * FROM hosts WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToHost(row) : null;
}

export function getHostByDomain(domain: string): ProxyHost | null {
  const row = db.prepare("SELECT * FROM hosts WHERE domain = ?").get(domain) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToHost(row) : null;
}

// Read-through cache for the forward-auth hot path: nginx calls
// /api/auth/forward on *every* request to a login-gated host, and host policy is
// read-mostly. Invalidated wholesale on any host mutation (create/update/delete/
// replace), so it can never serve stale policy. Bounded so probing many unknown
// domains can't grow it without limit.
const hostByDomainCache = new Map<string, ProxyHost | null>();
export function getHostByDomainCached(domain: string): ProxyHost | null {
  const hit = hostByDomainCache.get(domain);
  if (hit !== undefined) return hit;
  if (hostByDomainCache.size > 1000) hostByDomainCache.clear();
  const h = getHostByDomain(domain);
  hostByDomainCache.set(domain, h);
  return h;
}
function invalidateHostCache(): void {
  hostByDomainCache.clear();
}

export function createHost(input: NewProxyHost): ProxyHost {
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO hosts (id, name, iconUrl, domain, forwardScheme, forwardHost, forwardPort, preset,
      websockets, http2, ssl, requireLogin, require2fa, countryLock, serverGroup, serverIp,
      enabled, health, certExpiresAt, certDomain, maintenanceMode, securityHeaders, hsts, rateLimit,
      blockExploits, ipAllow, ipDeny, customHeaders, customNginx, upstreams, lbMethod,
      protocol, listenPort, pathRules, mtls, rateLimitKbps, maxConns, rateLimitRps, rateLimitBurst, createdAt, updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, input.name, input.iconUrl ?? "", input.domain, input.forwardScheme, input.forwardHost,
    input.forwardPort, input.preset, b(input.websockets), b(input.http2), b(input.ssl),
    b(input.requireLogin), b(input.require2fa), b(input.countryLock), input.serverGroup,
    input.serverIp, b(input.enabled), input.health ?? "unknown", input.certExpiresAt ?? null,
    input.certDomain ?? "",
    b(input.maintenanceMode ?? false), b(input.securityHeaders ?? true), b(input.hsts ?? false),
    b(input.rateLimit ?? false), b(input.blockExploits ?? true), input.ipAllow ?? "",
    input.ipDeny ?? "", input.customHeaders ?? "", input.customNginx ?? "",
    input.upstreams ?? "", input.lbMethod ?? "round_robin",
    input.protocol ?? "http", input.listenPort ?? 0, input.pathRules ?? "", b(input.mtls ?? false),
    input.rateLimitKbps ?? 0, input.maxConns ?? 0, input.rateLimitRps ?? 10, input.rateLimitBurst ?? 20, now, now,
  );
  invalidateHostCache();
  return getHost(id)!;
}

export function updateHost(id: string, patch: Partial<NewProxyHost>): ProxyHost | null {
  const existing = getHost(id);
  if (!existing) return null;
  const merged = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  db.prepare(`
    UPDATE hosts SET name=?, iconUrl=?, domain=?, forwardScheme=?, forwardHost=?, forwardPort=?,
      preset=?, websockets=?, http2=?, ssl=?, requireLogin=?, require2fa=?, countryLock=?,
      serverGroup=?, serverIp=?, enabled=?, health=?, certExpiresAt=?, certDomain=?,
      maintenanceMode=?, securityHeaders=?, hsts=?, rateLimit=?, blockExploits=?,
      ipAllow=?, ipDeny=?, customHeaders=?, customNginx=?, upstreams=?, lbMethod=?,
      protocol=?, listenPort=?, pathRules=?, mtls=?, rateLimitKbps=?, maxConns=?, rateLimitRps=?, rateLimitBurst=?, updatedAt=?
    WHERE id=?
  `).run(
    merged.name, merged.iconUrl ?? "", merged.domain, merged.forwardScheme, merged.forwardHost,
    merged.forwardPort, merged.preset, b(merged.websockets), b(merged.http2), b(merged.ssl),
    b(merged.requireLogin), b(merged.require2fa), b(merged.countryLock), merged.serverGroup,
    merged.serverIp, b(merged.enabled), merged.health, merged.certExpiresAt, merged.certDomain ?? "",
    b(merged.maintenanceMode), b(merged.securityHeaders), b(merged.hsts), b(merged.rateLimit),
    b(merged.blockExploits), merged.ipAllow, merged.ipDeny, merged.customHeaders, merged.customNginx,
    merged.upstreams ?? "", merged.lbMethod ?? "round_robin",
    merged.protocol ?? "http", merged.listenPort ?? 0, merged.pathRules ?? "", b(merged.mtls),
    merged.rateLimitKbps ?? 0, merged.maxConns ?? 0, merged.rateLimitRps ?? 10, merged.rateLimitBurst ?? 20, merged.updatedAt, id,
  );
  invalidateHostCache();
  return getHost(id);
}

export function deleteHost(id: string): boolean {
  const res = db.prepare("DELETE FROM hosts WHERE id = ?").run(id);
  // Cascade the rows keyed to this host so they aren't left orphaned. These
  // tables reference hostId by value (no SQL FK), so we clean them up here.
  db.prepare("DELETE FROM client_certs WHERE hostId = ?").run(id);
  db.prepare("DELETE FROM incidents WHERE hostId = ?").run(id);
  invalidateHostCache();
  return res.changes > 0;
}

/** Replace the entire host set (used by config restore). */
export function replaceAllHosts(hosts: ProxyHost[]): void {
  const insert = db.prepare(`
    INSERT INTO hosts (id, name, iconUrl, domain, forwardScheme, forwardHost, forwardPort, preset,
      websockets, http2, ssl, requireLogin, require2fa, countryLock, serverGroup, serverIp,
      enabled, health, certExpiresAt, certDomain, maintenanceMode, securityHeaders, hsts, rateLimit,
      blockExploits, ipAllow, ipDeny, customHeaders, customNginx, upstreams, lbMethod,
      protocol, listenPort, pathRules, mtls, rateLimitKbps, maxConns, rateLimitRps, rateLimitBurst, createdAt, updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM hosts").run();
    for (const h of hosts) {
      insert.run(
        h.id, h.name, h.iconUrl ?? "", h.domain, h.forwardScheme, h.forwardHost, h.forwardPort, h.preset,
        b(h.websockets), b(h.http2), b(h.ssl), b(h.requireLogin), b(h.require2fa), b(h.countryLock),
        h.serverGroup, h.serverIp, b(h.enabled), h.health, h.certExpiresAt ?? null, h.certDomain ?? "",
        b(h.maintenanceMode), b(h.securityHeaders), b(h.hsts), b(h.rateLimit), b(h.blockExploits),
        h.ipAllow ?? "", h.ipDeny ?? "", h.customHeaders ?? "", h.customNginx ?? "",
        h.upstreams ?? "", h.lbMethod ?? "round_robin", h.protocol ?? "http", h.listenPort ?? 0,
        h.pathRules ?? "", b(h.mtls), h.rateLimitKbps ?? 0, h.maxConns ?? 0,
        h.rateLimitRps ?? 10, h.rateLimitBurst ?? 20, h.createdAt, h.updatedAt,
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  invalidateHostCache();
}

/** Build the Internet → gateway → servers → services tree for the dashboard. */
export function getTopology(gateway: { publicIp: string; gatewayIp: string }): Topology {
  const hosts = listHosts();
  const byServer = new Map<string, TopologyServer>();

  for (const h of hosts) {
    const key = h.serverGroup || "default";
    if (!byServer.has(key)) {
      byServer.set(key, { name: key, ip: h.serverIp, status: "online", services: [] });
    }
    const server = byServer.get(key)!;
    server.services.push({
      id: h.id,
      name: h.name,
      iconUrl: h.iconUrl,
      domain: h.domain,
      port: h.forwardPort,
      health: h.health,
      requireLogin: h.requireLogin,
      enabled: h.enabled,
    });
  }

  // A server's status is the worst of its *enabled* services' statuses - a paused
  // service is intentionally offline, so it shouldn't drag the node to degraded.
  const rank: Record<HealthStatus, number> = { online: 0, unknown: 1, degraded: 2, down: 3 };
  for (const server of byServer.values()) {
    const active = server.services.filter((s) => s.enabled);
    server.status = active.length
      ? active.reduce<HealthStatus>((worst, s) => (rank[s.health] > rank[worst] ? s.health : worst), "online")
      : "unknown";
  }

  return {
    internet: { label: "Internet" },
    gateway,
    servers: [...byServer.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function b(v: boolean): number {
  return v ? 1 : 0;
}
