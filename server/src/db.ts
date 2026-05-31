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

// Memoize prepared statements by SQL text. Every db.prepare(sql) in the codebase
// reuses one compiled statement instead of recompiling on each call — a free win
// on hot paths (session lookup, host list, audit insert, metrics, etc.). Safe
// because node:sqlite is synchronous: a statement is bound + executed per call
// with no overlapping iteration. DDL still goes through db.exec, untouched.
{
  const compile = db.prepare.bind(db);
  const cache = new Map<string, ReturnType<typeof compile>>();
  db.prepare = ((sql: string) => {
    let stmt = cache.get(sql);
    if (!stmt) { stmt = compile(sql); cache.set(sql, stmt); }
    return stmt;
  }) as typeof db.prepare;
}

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
    mustChangePassword INTEGER NOT NULL DEFAULT 0,
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
    domain      TEXT NOT NULL DEFAULT '',
    name        TEXT NOT NULL,
    serial      TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    notAfter    TEXT NOT NULL,
    createdAt   TEXT NOT NULL,
    revokedAt   TEXT
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
  baseDomain: "example.com",
  publicUrl: "",
  theme: "dark",
  letsEncryptEmail: "",
  homeCountry: "",
  publicIp: "",
  gatewayIp: "192.168.1.1",
  dnsProvider: "none",
  godaddyApiKey: "",
  godaddySecret: "",
  cloudflareApiToken: "",
  maxmindLicenseKey: "",
  acmeStaging: false,
  agentAutoApprove: false,
  gitOpsEnabled: false,
};

// Settings fields that hold third-party credentials — never expose these to a
// non-admin, and never include them in an unauthenticated/low-privilege view.
export const SECRET_SETTING_KEYS = [
  "godaddyApiKey",
  "godaddySecret",
  "cloudflareApiToken",
  "maxmindLicenseKey",
] as const;

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

/** Mask credential fields for non-admin callers. A configured secret becomes a
 *  "set" placeholder so the UI can show it exists without leaking the value. */
export function redactSettings(s: Settings): Settings {
  const out = { ...s } as unknown as Record<string, unknown>;
  for (const k of SECRET_SETTING_KEYS) {
    out[k] = String(out[k] ?? "") ? "••••••••" : "";
  }
  return out as unknown as Settings;
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
  // Demo hosts/certs are for local dev & screenshots only. NEVER seed a real
  // deployment (the published image runs with NODE_ENV=production), and never
  // re-seed once initialized — otherwise deleting every service would bring the
  // demo data back on the next restart.
  if (process.env.NODE_ENV === "production") return;
  const already = db.prepare("SELECT 1 FROM settings WHERE key = 'demoSeeded'").get();
  if (already) return;
  db.prepare("INSERT INTO settings (key, value) VALUES ('demoSeeded', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'").run();

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
