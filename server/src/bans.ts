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

/** Delete expired rows; returns how many were removed. Run on a timer, not on the
 *  read path (a SELECT shouldn't issue a write). */
function pruneExpired(): number {
  return Number(db.prepare("DELETE FROM bans WHERE expiresAt IS NOT NULL AND expiresAt < ?").run(new Date().toISOString()).changes);
}

// Coalesce nginx reloads: an auto-ban storm (many bans within seconds) would
// otherwise trigger a reload per ban. Debounce so a burst yields one reload.
let applyTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleBannedApply(): void {
  if (applyTimer) return;
  applyTimer = setTimeout(() => { applyTimer = null; void applyConfig(); }, 750);
  applyTimer.unref?.();
}

export function listBans(): Ban[] {
  // Filter expired in the query (no write on read); the prune timer cleans the table.
  return (db.prepare("SELECT * FROM bans WHERE expiresAt IS NULL OR expiresAt > ? ORDER BY createdAt DESC")
    .all(new Date().toISOString()) as Row[]).map(toBan);
}

export function addBan(ip: string, reason: string, source: Ban["source"] = "manual", ttlMs = BAN_MS): Ban {
  const now = Date.now();
  db.prepare(
    "INSERT INTO bans (ip, reason, source, createdAt, expiresAt) VALUES (?,?,?,?,?) " +
    "ON CONFLICT(ip) DO UPDATE SET reason=excluded.reason, source=excluded.source, expiresAt=excluded.expiresAt",
  ).run(ip, reason, source, new Date(now).toISOString(), ttlMs ? new Date(now + ttlMs).toISOString() : null);
  writeBannedConf();
  scheduleBannedApply();
  return toBan(db.prepare("SELECT * FROM bans WHERE ip = ?").get(ip) as Row);
}

export function removeBan(ip: string): boolean {
  const changed = db.prepare("DELETE FROM bans WHERE ip = ?").run(ip).changes > 0;
  if (changed) { writeBannedConf(); scheduleBannedApply(); }
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

/** Loopback + private LAN + link-local + ULA. Auto-ban exists to stop INTERNET
 *  brute force; a LAN user (or family member) fat-fingering their password must
 *  not self-ban their device from every proxied service for 24h. Manual bans are
 *  unaffected - an admin can still ban a LAN IP explicitly. */
export function isLocalIp(ip: string): boolean {
  const h = ip.replace(/^::ffff:/i, "").toLowerCase(); // unwrap IPv4-mapped IPv6
  if (h === "::1" || h.startsWith("127.")) return true;
  if (/^(10\.|192\.168\.|169\.254\.)/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true; // 172.16.0.0/12
  if (/^(fe80:|f[cd])/.test(h)) return true; // IPv6 link-local + ULA
  return false;
}

export function startBanEngine(): void {
  writeBannedConf();
  // Prune expired rows every minute (not hourly) so a lifted ban stops denying at
  // nginx promptly - the deny-list is only rewritten when a row actually expires.
  setInterval(() => {
    try { if (pruneExpired() > 0) { writeBannedConf(); scheduleBannedApply(); } } catch { /* ignore */ }
  }, 60_000).unref?.();
  subscribe((e) => {
    if (e.type !== "login.failed") return;
    const ip = String(e.data?.ip ?? "").trim();
    if (!ip || isLocalIp(ip)) return; // never auto-ban loopback/LAN (internet brute-force only)
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
