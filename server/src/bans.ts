import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./db.ts";
import { logEvent } from "./auth.ts";
import { subscribe } from "./events.ts";
import { applyConfig } from "./nginx.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BANNED_FILE = process.env.NGINX_BANNED_FILE ?? join(__dirname, "..", "..", "nginx", "banned.conf");

// auto-ban policy
const THRESHOLD = 5; // failures
const WINDOW_MS = 5 * 60_000; // within 5 minutes
const BAN_MS = 24 * 3600_000; // ban for 24h

export interface Ban {
  ip: string;
  reason: string;
  source: "manual" | "auto" | "geoip";
  createdAt: string;
  expiresAt: string | null;
}

type Row = Record<string, unknown>;
const toBan = (r: Row): Ban => ({
  ip: String(r.ip), reason: String(r.reason), source: r.source as Ban["source"],
  createdAt: String(r.createdAt), expiresAt: r.expiresAt ? String(r.expiresAt) : null,
});

function pruneExpired() {
  db.prepare("DELETE FROM bans WHERE expiresAt IS NOT NULL AND expiresAt < ?").run(new Date().toISOString());
}

export function listBans(): Ban[] {
  pruneExpired();
  return (db.prepare("SELECT * FROM bans ORDER BY createdAt DESC").all() as Row[]).map(toBan);
}

export function addBan(ip: string, reason: string, source: Ban["source"] = "manual", ttlMs = BAN_MS): Ban {
  const now = Date.now();
  db.prepare(
    "INSERT INTO bans (ip, reason, source, createdAt, expiresAt) VALUES (?,?,?,?,?) " +
    "ON CONFLICT(ip) DO UPDATE SET reason=excluded.reason, source=excluded.source, expiresAt=excluded.expiresAt",
  ).run(ip, reason, source, new Date(now).toISOString(), ttlMs ? new Date(now + ttlMs).toISOString() : null);
  writeBannedConf();
  void applyConfig();
  return toBan(db.prepare("SELECT * FROM bans WHERE ip = ?").get(ip) as Row);
}

export function removeBan(ip: string): boolean {
  const changed = db.prepare("DELETE FROM bans WHERE ip = ?").run(ip).changes > 0;
  if (changed) { writeBannedConf(); void applyConfig(); }
  return changed;
}

/** Write the deny-list snippet included by the base nginx http block. */
export function writeBannedConf(): void {
  if (!existsSync(dirname(BANNED_FILE))) mkdirSync(dirname(BANNED_FILE), { recursive: true });
  const lines = listBans().map((b) => `deny ${b.ip};`);
  writeFileSync(BANNED_FILE, `# Managed by NginUX - auto + manual IP bans\n${lines.join("\n")}\n`);
}

// ---- auto-ban engine ----
const failures = new Map<string, number[]>();

export function startBanEngine(): void {
  writeBannedConf();
  subscribe((e) => {
    if (e.type !== "login.failed") return;
    const ip = String(e.data?.ip ?? "").trim();
    if (!ip || ip === "127.0.0.1") return;
    const now = Date.now();
    const hits = (failures.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
    hits.push(now);
    failures.set(ip, hits);
    if (hits.length >= THRESHOLD) {
      failures.delete(ip);
      addBan(ip, `Brute force: ${hits.length} failed logins in ${WINDOW_MS / 60000}m`, "auto");
      logEvent({ type: "security.ip_banned", severity: "danger", actor: "fail2ban", summary: `Auto-banned ${ip} (brute force)`, ip, meta: { source: "auto" } });
    }
  });
}

export { BANNED_FILE };
