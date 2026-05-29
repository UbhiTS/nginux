import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProxyHost, Settings } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Data dir is overridable via env so the container can mount a volume.
const DATA_DIR = process.env.NGINUX_DATA_DIR ?? join(__dirname, "..", "data");
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = join(DATA_DIR, "nginux.db");

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;   -- safe + fast with WAL
  PRAGMA busy_timeout = 5000;    -- wait instead of throwing SQLITE_BUSY under concurrency
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS hosts (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    emoji         TEXT NOT NULL DEFAULT '⚙️',
    domain        TEXT NOT NULL UNIQUE,
    forwardScheme TEXT NOT NULL DEFAULT 'http',
    forwardHost   TEXT NOT NULL,
    forwardPort   INTEGER NOT NULL,
    preset        TEXT NOT NULL DEFAULT 'custom',
    websockets    INTEGER NOT NULL DEFAULT 0,
    http2         INTEGER NOT NULL DEFAULT 1,
    ssl           INTEGER NOT NULL DEFAULT 1,
    requireLogin  INTEGER NOT NULL DEFAULT 0,
    require2fa    INTEGER NOT NULL DEFAULT 0,
    countryLock   INTEGER NOT NULL DEFAULT 0,
    serverGroup   TEXT NOT NULL DEFAULT 'default',
    serverIp      TEXT NOT NULL DEFAULT '',
    enabled       INTEGER NOT NULL DEFAULT 1,
    health        TEXT NOT NULL DEFAULT 'unknown',
    certExpiresAt TEXT,
    maintenanceMode INTEGER NOT NULL DEFAULT 0,
    securityHeaders INTEGER NOT NULL DEFAULT 1,
    hsts            INTEGER NOT NULL DEFAULT 0,
    rateLimit       INTEGER NOT NULL DEFAULT 0,
    blockExploits   INTEGER NOT NULL DEFAULT 0,
    ipAllow         TEXT NOT NULL DEFAULT '',
    ipDeny          TEXT NOT NULL DEFAULT '',
    customHeaders   TEXT NOT NULL DEFAULT '',
    customNginx     TEXT NOT NULL DEFAULT '',
    upstreams       TEXT NOT NULL DEFAULT '',
    lbMethod        TEXT NOT NULL DEFAULT 'round_robin',
    protocol        TEXT NOT NULL DEFAULT 'http',
    listenPort      INTEGER NOT NULL DEFAULT 0,
    pathRules       TEXT NOT NULL DEFAULT '',
    mtls            INTEGER NOT NULL DEFAULT 0,
    rateLimitKbps   INTEGER NOT NULL DEFAULT 0,
    maxConns        INTEGER NOT NULL DEFAULT 0,
    createdAt     TEXT NOT NULL,
    updatedAt     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    email         TEXT NOT NULL DEFAULT '',
    passwordHash  TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'admin',
    scope         TEXT NOT NULL DEFAULT '',
    twofaSecret   TEXT,
    twofaEnabled  INTEGER NOT NULL DEFAULT 0,
    backupCodes   TEXT NOT NULL DEFAULT '[]',
    createdAt     TEXT NOT NULL,
    lastLoginAt   TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token     TEXT PRIMARY KEY,
    userId    TEXT NOT NULL,
    device    TEXT NOT NULL DEFAULT '',
    ip        TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL,
    expiresAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_events (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT NOT NULL,
    type     TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    actor    TEXT NOT NULL DEFAULT '',
    summary  TEXT NOT NULL,
    ip       TEXT NOT NULL DEFAULT '',
    meta     TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS certificates (
    domain    TEXT PRIMARY KEY,
    status    TEXT NOT NULL DEFAULT 'none',
    issuer    TEXT NOT NULL DEFAULT '',
    method    TEXT NOT NULL DEFAULT 'selfsigned',
    notBefore TEXT,
    notAfter  TEXT,
    sans      TEXT NOT NULL DEFAULT '[]',
    wildcard  INTEGER NOT NULL DEFAULT 0,
    autoRenew INTEGER NOT NULL DEFAULT 1,
    lastError TEXT,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS api_tokens (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    prefix     TEXT NOT NULL,
    tokenHash  TEXT NOT NULL,
    scopes     TEXT NOT NULL DEFAULT '["read"]',
    trust      TEXT NOT NULL DEFAULT 'untrusted',
    createdAt  TEXT NOT NULL,
    lastUsedAt TEXT,
    revoked    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS approvals (
    id        TEXT PRIMARY KEY,
    ts        TEXT NOT NULL,
    agent     TEXT NOT NULL,
    tool      TEXT NOT NULL,
    args      TEXT NOT NULL DEFAULT '{}',
    tier      TEXT NOT NULL,
    summary   TEXT NOT NULL DEFAULT '',
    status    TEXT NOT NULL DEFAULT 'pending',
    result    TEXT,
    decidedBy TEXT,
    decidedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS webhooks (
    id             TEXT PRIMARY KEY,
    url            TEXT NOT NULL,
    events         TEXT NOT NULL DEFAULT '["*"]',
    secret         TEXT NOT NULL,
    lastStatus     TEXT,
    lastDeliveryAt TEXT,
    createdAt      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS incidents (
    id        TEXT PRIMARY KEY,
    hostId    TEXT NOT NULL,
    host      TEXT NOT NULL,
    startedAt TEXT NOT NULL,
    endedAt   TEXT
  );

  CREATE TABLE IF NOT EXISTS channels (
    id         TEXT PRIMARY KEY,
    type       TEXT NOT NULL,
    name       TEXT NOT NULL,
    config     TEXT NOT NULL DEFAULT '{}',
    events     TEXT NOT NULL DEFAULT '["*"]',
    enabled    INTEGER NOT NULL DEFAULT 1,
    lastStatus TEXT,
    createdAt  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS client_certs (
    id          TEXT PRIMARY KEY,
    hostId      TEXT NOT NULL,
    name        TEXT NOT NULL,
    serial      TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    notAfter    TEXT NOT NULL,
    createdAt   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bans (
    ip        TEXT PRIMARY KEY,
    reason    TEXT NOT NULL DEFAULT '',
    source    TEXT NOT NULL DEFAULT 'manual',
    createdAt TEXT NOT NULL,
    expiresAt TEXT
  );

  CREATE TABLE IF NOT EXISTS config_versions (
    id        TEXT PRIMARY KEY,
    ts        TEXT NOT NULL,
    label     TEXT NOT NULL,
    actor     TEXT NOT NULL DEFAULT '',
    hostsJson TEXT NOT NULL,
    settingsJson TEXT NOT NULL DEFAULT '{}',
    hostCount INTEGER NOT NULL DEFAULT 0
  );
`);

// Add any columns missing from an older hosts table (idempotent migration).
function migrateHosts() {
  const cols = new Set((db.prepare("PRAGMA table_info(hosts)").all() as Record<string, unknown>[]).map((c) => String(c.name)));
  const additions: [string, string][] = [
    ["maintenanceMode", "INTEGER NOT NULL DEFAULT 0"],
    ["securityHeaders", "INTEGER NOT NULL DEFAULT 1"],
    ["hsts", "INTEGER NOT NULL DEFAULT 0"],
    ["rateLimit", "INTEGER NOT NULL DEFAULT 0"],
    ["blockExploits", "INTEGER NOT NULL DEFAULT 0"],
    ["ipAllow", "TEXT NOT NULL DEFAULT ''"],
    ["ipDeny", "TEXT NOT NULL DEFAULT ''"],
    ["customHeaders", "TEXT NOT NULL DEFAULT ''"],
    ["customNginx", "TEXT NOT NULL DEFAULT ''"],
    ["upstreams", "TEXT NOT NULL DEFAULT ''"],
    ["lbMethod", "TEXT NOT NULL DEFAULT 'round_robin'"],
    ["protocol", "TEXT NOT NULL DEFAULT 'http'"],
    ["listenPort", "INTEGER NOT NULL DEFAULT 0"],
    ["pathRules", "TEXT NOT NULL DEFAULT ''"],
    ["mtls", "INTEGER NOT NULL DEFAULT 0"],
    ["rateLimitKbps", "INTEGER NOT NULL DEFAULT 0"],
    ["maxConns", "INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [name, def] of additions) {
    if (!cols.has(name)) db.exec(`ALTER TABLE hosts ADD COLUMN ${name} ${def}`);
  }
}
migrateHosts();

// Indexes on hot query paths (filtered/ordered scans that grow over time).
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sessions_userId   ON sessions(userId);
  CREATE INDEX IF NOT EXISTS idx_sessions_expiresAt ON sessions(expiresAt);
  CREATE INDEX IF NOT EXISTS idx_audit_type_ts      ON audit_events(type, ts);
  CREATE INDEX IF NOT EXISTS idx_audit_ts           ON audit_events(ts);
  CREATE INDEX IF NOT EXISTS idx_client_certs_host  ON client_certs(hostId);
  CREATE INDEX IF NOT EXISTS idx_incidents_host     ON incidents(hostId, endedAt);
  CREATE INDEX IF NOT EXISTS idx_bans_expiresAt     ON bans(expiresAt);
  CREATE INDEX IF NOT EXISTS idx_approvals_status   ON approvals(status, ts);
`);

/** Trim the audit log so it can't grow without bound. Keeps recent rows by time
 *  and an absolute cap by count; returns how many rows were removed. */
export function pruneAuditLog(retainDays = Number(process.env.NGINUX_AUDIT_RETAIN_DAYS ?? 90), hardCap = 50_000): number {
  const cutoff = new Date(Date.now() - retainDays * 86400_000).toISOString();
  let removed = Number(db.prepare("DELETE FROM audit_events WHERE ts < ?").run(cutoff).changes);
  removed += Number(db.prepare(
    "DELETE FROM audit_events WHERE id NOT IN (SELECT id FROM audit_events ORDER BY id DESC LIMIT ?)",
  ).run(hardCap).changes);
  return removed;
}

/** Cheap liveness probe for the health endpoint. */
export function dbOk(): boolean {
  try { db.prepare("SELECT 1").get(); return true; } catch { return false; }
}

/** Close the database cleanly (called on shutdown). */
export function closeDb(): void {
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* ignore */ }
  db.close();
}

// ---- row <-> domain mapping (sqlite stores booleans as 0/1) ----
type HostRow = Record<string, unknown>;

export function rowToHost(r: HostRow): ProxyHost {
  return {
    id: String(r.id),
    name: String(r.name),
    emoji: String(r.emoji),
    domain: String(r.domain),
    forwardScheme: r.forwardScheme as ProxyHost["forwardScheme"],
    forwardHost: String(r.forwardHost),
    forwardPort: Number(r.forwardPort),
    preset: String(r.preset),
    websockets: !!r.websockets,
    http2: !!r.http2,
    ssl: !!r.ssl,
    requireLogin: !!r.requireLogin,
    require2fa: !!r.require2fa,
    countryLock: !!r.countryLock,
    serverGroup: String(r.serverGroup),
    serverIp: String(r.serverIp),
    enabled: !!r.enabled,
    health: r.health as ProxyHost["health"],
    certExpiresAt: r.certExpiresAt ? String(r.certExpiresAt) : null,
    maintenanceMode: !!r.maintenanceMode,
    securityHeaders: r.securityHeaders === undefined ? true : !!r.securityHeaders,
    hsts: !!r.hsts,
    rateLimit: !!r.rateLimit,
    blockExploits: !!r.blockExploits,
    ipAllow: r.ipAllow ? String(r.ipAllow) : "",
    ipDeny: r.ipDeny ? String(r.ipDeny) : "",
    customHeaders: r.customHeaders ? String(r.customHeaders) : "",
    customNginx: r.customNginx ? String(r.customNginx) : "",
    upstreams: r.upstreams ? String(r.upstreams) : "",
    lbMethod: (r.lbMethod as ProxyHost["lbMethod"]) ?? "round_robin",
    protocol: (r.protocol as ProxyHost["protocol"]) ?? "http",
    listenPort: Number(r.listenPort ?? 0),
    pathRules: r.pathRules ? String(r.pathRules) : "",
    mtls: !!r.mtls,
    rateLimitKbps: Number(r.rateLimitKbps ?? 0),
    maxConns: Number(r.maxConns ?? 0),
    createdAt: String(r.createdAt),
    updatedAt: String(r.updatedAt),
  };
}

// ---- settings ----
const DEFAULT_SETTINGS: Settings = {
  instanceName: "Home Lab",
  baseDomain: "ubhi.io",
  publicUrl: "https://proxy.ubhi.io",
  theme: "dark",
  letsEncryptEmail: "",
  homeCountry: "CA",
  publicIp: "203.0.113.10",
  gatewayIp: "192.168.1.1",
  dnsProvider: "none",
  godaddyApiKey: "",
  godaddySecret: "",
  cloudflareApiToken: "",
  acmeStaging: false,
  agentAutoApprove: true,
  gitOpsEnabled: false,
};

export function getSettings(): Settings {
  const rows = db.prepare("SELECT key, value FROM settings").all() as Array<{
    key: string;
    value: string;
  }>;
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const merged = { ...DEFAULT_SETTINGS, ...map } as Record<string, unknown>;
  merged.acmeStaging = String(merged.acmeStaging) === "true"; // stored as string
  merged.agentAutoApprove = String(merged.agentAutoApprove) === "true";
  merged.gitOpsEnabled = String(merged.gitOpsEnabled) === "true";
  return merged as unknown as Settings;
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const stmt = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  for (const [k, v] of Object.entries(patch)) stmt.run(k, String(v));
  return getSettings();
}

// ---- one-time seed so the empty state is never intimidating ----
function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86400_000).toISOString();
}

export function seedIfEmpty(): void {
  const count = (
    db.prepare("SELECT COUNT(*) AS n FROM hosts").get() as { n: number }
  ).n;
  if (count > 0) return;

  const now = new Date().toISOString();
  const seed: Array<Partial<ProxyHost> & { id: string }> = [
    { id: "plex", name: "Plex", emoji: "🎬", domain: "plex.ubhi.io", forwardHost: "192.168.1.50", forwardPort: 32400, preset: "plex", websockets: true, requireLogin: true, require2fa: true, countryLock: true, serverGroup: "media-server", serverIp: "192.168.1.50", health: "online", certExpiresAt: daysFromNow(67) },
    { id: "immich", name: "Immich", emoji: "📷", domain: "photos.ubhi.io", forwardHost: "192.168.1.50", forwardPort: 2283, preset: "immich", websockets: true, requireLogin: true, require2fa: true, serverGroup: "media-server", serverIp: "192.168.1.50", health: "online", certExpiresAt: daysFromNow(67) },
    { id: "nextcloud", name: "Nextcloud", emoji: "☁️", domain: "cloud.ubhi.io", forwardHost: "192.168.1.60", forwardPort: 443, forwardScheme: "https", preset: "nextcloud", requireLogin: false, serverGroup: "apps-server", serverIp: "192.168.1.60", health: "degraded", certExpiresAt: daysFromNow(30) },
    { id: "ha", name: "Home Assistant", emoji: "🏠", domain: "ha.ubhi.io", forwardHost: "192.168.1.60", forwardPort: 8123, preset: "homeassistant", websockets: true, requireLogin: true, require2fa: true, serverGroup: "apps-server", serverIp: "192.168.1.60", health: "online", certExpiresAt: daysFromNow(67) },
    { id: "vault", name: "Vaultwarden", emoji: "🔐", domain: "vault.ubhi.io", forwardHost: "192.168.1.60", forwardPort: 8080, preset: "vaultwarden", websockets: true, requireLogin: true, require2fa: true, serverGroup: "apps-server", serverIp: "192.168.1.60", health: "online", certExpiresAt: daysFromNow(67) },
    { id: "grafana", name: "Grafana", emoji: "📊", domain: "grafana.ubhi.io", forwardHost: "192.168.1.70", forwardPort: 3000, preset: "grafana", websockets: true, requireLogin: false, serverGroup: "monitor-vm", serverIp: "192.168.1.70", health: "down", certExpiresAt: daysFromNow(52) },
  ];

  const insert = db.prepare(`
    INSERT INTO hosts (id, name, emoji, domain, forwardScheme, forwardHost, forwardPort, preset,
      websockets, http2, ssl, requireLogin, require2fa, countryLock, serverGroup, serverIp,
      enabled, health, certExpiresAt, createdAt, updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  const insertCert = db.prepare(`
    INSERT INTO certificates (domain, status, issuer, method, notBefore, notAfter, sans, wildcard, autoRenew, updatedAt)
    VALUES (?,?,?,?,?,?,?,0,1,?)
  `);

  for (const h of seed) {
    insert.run(
      h.id, h.name!, h.emoji!, h.domain!, h.forwardScheme ?? "http", h.forwardHost!, h.forwardPort!, h.preset ?? "custom",
      h.websockets ? 1 : 0, 1, 1, h.requireLogin ? 1 : 0, h.require2fa ? 1 : 0, h.countryLock ? 1 : 0,
      h.serverGroup ?? "default", h.serverIp ?? "", 1, h.health ?? "unknown", h.certExpiresAt ?? null, now, now,
    );
    if (h.certExpiresAt) {
      const days = (Date.parse(h.certExpiresAt) - Date.now()) / 86400_000;
      const status = days < 0 ? "expired" : days < 30 ? "expiring" : "valid";
      insertCert.run(h.domain!, status, "Let's Encrypt", "dns-01", now, h.certExpiresAt, JSON.stringify([h.domain]), now);
    }
  }
}
