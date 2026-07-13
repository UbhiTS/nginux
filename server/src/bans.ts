import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./db.ts";
import { logEvent } from "./auth.ts";
import { subscribe } from "./events.ts";
import { applyConfig } from "./nginx.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BANNED_FILE = process.env.NGINX_BANNED_FILE ?? join(__dirname, "..", "..", "nginx", "banned.conf");
// Stream (L4 TCP/UDP/SNI) proxies live in nginx's stream{} context, where the http-scope
// `geo $nginux_banned` map is invisible and there is no `if`/`return 403`. So the same ban
// list is ALSO emitted as ngx_stream_access `deny <ip>;` lines, included at stream{} scope
// and inherited by every stream server (which define no allow/deny of their own — so, unlike
// the http path, plain deny lines are not shadowed). (Security audit follow-up 2026-07-12.)
export const STREAM_BANNED_FILE = process.env.NGINX_STREAM_BANNED_FILE ?? join(__dirname, "..", "..", "nginx", "stream_banned.conf");

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

/** Replace the whole ban list (backup restore), in one transaction, then rewrite
 *  the nginx deny-list. Returns how many bans were restored. */
export function replaceAllBans(bans: Ban[]): number {
  const insert = db.prepare(
    "INSERT OR REPLACE INTO bans (ip, reason, source, createdAt, expiresAt) VALUES (?,?,?,?,?)",
  );
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM bans").run();
    for (const b of bans) {
      insert.run(b.ip, b.reason ?? "", b.source ?? "manual", b.createdAt ?? new Date().toISOString(), b.expiresAt ?? null);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  writeBannedConf();
  scheduleBannedApply();
  return bans.length;
}

/** Write the deny-list snippet included by the base nginx http block. */
export function writeBannedConf(): void {
  // Ensure the parent dir of BOTH ban files exists before writing. A missing dir here
  // (e.g. STREAM_BANNED_FILE defaulting under /app when its env var isn't set) makes
  // writeFileSync throw at BOOT and, because the entrypoint supervises it, crash-loops
  // the whole container - so this must never be able to fail on a fresh install. (v0.1.6)
  for (const dir of new Set([dirname(BANNED_FILE), dirname(STREAM_BANNED_FILE)])) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  // A `geo` map (http scope), NOT `deny` lines. Each generated server block enforces it
  // with `if ($nginux_banned) return 403;`. Unlike http-level `deny` — which nginx's
  // access module STOPS inheriting the moment a server defines its own allow/deny (per
  // ipAllow/ipDeny) — a variable check applies unconditionally, so bans are no longer
  // silently bypassed on the exact hosts an admin bothered to lock down. Mirrors how the
  // country-lock ($nginux_allowed_country) already works. (Security audit 2026-07-12.)
  const bans = listBans();
  const entries = bans.map((b) => `    ${b.ip} 1;`).join("\n");
  writeFileSync(
    BANNED_FILE,
    `# Managed by NginUX - auto + manual IP bans (geo map; enforced per-server via $nginux_banned)\ngeo $nginux_banned {\n    default 0;\n${entries}${entries ? "\n" : ""}}\n`,
  );
  // Stream-context sibling: ngx_stream_access deny lines, inherited by every stream server.
  // A matched deny drops the connection after the handshake; an empty list (comment only) is
  // a valid, includable file that denies nothing. Same ban set, same source of truth.
  const denyLines = bans.map((b) => `    deny ${b.ip};`).join("\n");
  writeFileSync(
    STREAM_BANNED_FILE,
    `# Managed by NginUX - stream-scope IP bans (ngx_stream_access; inherited by all stream servers)\n${denyLines}${denyLines ? "\n" : ""}`,
  );
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
