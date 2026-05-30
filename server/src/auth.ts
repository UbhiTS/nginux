import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { db, getSettings } from "./db.ts";
import { listHosts } from "./repo.ts";
import { generateSecret } from "./totp.ts";
import { emitEvent } from "./events.ts";

export type Role = "admin" | "editor" | "readonly" | "scoped";

export interface User {
  id: string;
  username: string;
  email: string;
  role: Role;
  scope: string;
  twofaEnabled: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

const SESSION_COOKIE = "nginux_session";
const SESSION_TTL_MS = 7 * 86400_000;
const IS_PROD = process.env.NODE_ENV === "production";
// A fixed bogus hash so an unknown username still costs one scrypt — closes the
// timing oracle that would otherwise reveal which usernames exist.
const DUMMY_HASH = hashPassword("nginux-dummy-password-for-constant-time");

// ---------- password hashing (scrypt) ----------
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const hash = scryptSync(password, Buffer.from(saltHex, "hex"), 64);
  const expected = Buffer.from(hashHex, "hex");
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

/** Change a user's password after verifying the current one; clears the
 *  "must change" flag. Returns false if the current password is wrong. */
export function changePassword(userId: string, currentPassword: string, newPassword: string): boolean {
  const r = db.prepare("SELECT passwordHash FROM users WHERE id = ?").get(userId) as Record<string, unknown> | undefined;
  if (!r) return false;
  if (!verifyPassword(currentPassword, String(r.passwordHash))) return false;
  db.prepare("UPDATE users SET passwordHash = ?, mustChangePassword = 0 WHERE id = ?").run(hashPassword(newPassword), userId);
  return true;
}

/** Admin reset: set a user's password without their current one, force a change
 *  on their next login, and kill their existing sessions. */
export function adminSetPassword(userId: string, newPassword: string): boolean {
  const exists = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  if (!exists) return false;
  db.prepare("UPDATE users SET passwordHash = ?, mustChangePassword = 1 WHERE id = ?").run(hashPassword(newPassword), userId);
  destroyUserSessions(userId);
  return true;
}

// ---------- user mapping ----------
type Row = Record<string, unknown>;
function toUser(r: Row): User {
  return {
    id: String(r.id),
    username: String(r.username),
    email: String(r.email),
    role: r.role as Role,
    scope: String(r.scope),
    twofaEnabled: !!r.twofaEnabled,
    mustChangePassword: !!r.mustChangePassword,
    createdAt: String(r.createdAt),
    lastLoginAt: r.lastLoginAt ? String(r.lastLoginAt) : null,
  };
}

export function listUsers(): User[] {
  return (db.prepare("SELECT * FROM users ORDER BY createdAt").all() as Row[]).map(toUser);
}

export function getUserById(id: string): User | null {
  const r = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
  return r ? toUser(r) : null;
}

function getRawByUsername(username: string): Row | undefined {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username) as Row | undefined;
}

export function createUser(input: {
  username: string;
  email?: string;
  password: string;
  role?: Role;
  scope?: string;
}): User {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO users (id, username, email, passwordHash, role, scope, twofaEnabled, backupCodes, createdAt)
     VALUES (?,?,?,?,?,?,0,'[]',?)`,
  ).run(
    id,
    input.username,
    input.email ?? "",
    hashPassword(input.password),
    input.role ?? "readonly",
    input.scope ?? "",
    new Date().toISOString(),
  );
  return getUserById(id)!;
}

export function deleteUser(id: string): boolean {
  return db.prepare("DELETE FROM users WHERE id = ?").run(id).changes > 0;
}

// ---------- 2FA ----------
export function beginTwofaSetup(userId: string): { secret: string } {
  const secret = generateSecret();
  db.prepare("UPDATE users SET twofaSecret = ? WHERE id = ?").run(secret, userId);
  return { secret };
}

export function getTwofaSecret(userId: string): string | null {
  const r = db.prepare("SELECT twofaSecret FROM users WHERE id = ?").get(userId) as Row | undefined;
  return r?.twofaSecret ? String(r.twofaSecret) : null;
}

const hashCode = (c: string) => createHash("sha256").update(c).digest("hex");

export function enableTwofa(userId: string): string[] {
  // Show the user strong (80-bit) codes once; store only their hashes at rest.
  const codes = Array.from({ length: 8 }, () => randomBytes(10).toString("hex"));
  db.prepare("UPDATE users SET twofaEnabled = 1, backupCodes = ? WHERE id = ?").run(
    JSON.stringify(codes.map(hashCode)),
    userId,
  );
  return codes;
}

/** Consume a one-time backup code (constant-time match); true if it was valid. */
export function useBackupCode(userId: string, code: string): boolean {
  const r = db.prepare("SELECT backupCodes FROM users WHERE id = ?").get(userId) as Row | undefined;
  if (!r?.backupCodes) return false;
  const stored: string[] = JSON.parse(String(r.backupCodes));
  const target = Buffer.from(hashCode(code.trim()), "hex");
  let matchIdx = -1;
  stored.forEach((h, i) => {
    const buf = Buffer.from(h, "hex");
    if (buf.length === target.length && timingSafeEqual(buf, target)) matchIdx = i;
  });
  if (matchIdx === -1) return false;
  stored.splice(matchIdx, 1);
  db.prepare("UPDATE users SET backupCodes = ? WHERE id = ?").run(JSON.stringify(stored), userId);
  return true;
}

export function userNeeds2fa(username: string): boolean {
  const r = getRawByUsername(username);
  return !!r && !!r.twofaEnabled;
}

// ---------- credential check ----------
export function checkCredentials(username: string, password: string): Row | null {
  const r = getRawByUsername(username);
  // Always run one scrypt so unknown vs. known usernames take the same time.
  const ok = verifyPassword(password, r ? String(r.passwordHash) : DUMMY_HASH);
  return r && ok ? r : null;
}

// ---------- sessions ----------
export function createSession(userId: string, device: string, ip: string): string {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  db.prepare(
    "INSERT INTO sessions (token, userId, device, ip, createdAt, expiresAt) VALUES (?,?,?,?,?,?)",
  ).run(
    token,
    userId,
    device,
    ip,
    new Date(now).toISOString(),
    new Date(now + SESSION_TTL_MS).toISOString(),
  );
  db.prepare("UPDATE users SET lastLoginAt = ? WHERE id = ?").run(new Date(now).toISOString(), userId);
  return token;
}

export function userForSession(token: string | undefined): User | null {
  if (!token) return null;
  const s = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token) as Row | undefined;
  if (!s) return null;
  if (Date.parse(String(s.expiresAt)) < Date.now()) {
    destroySession(token);
    return null;
  }
  return getUserById(String(s.userId));
}

export function destroySession(token: string): void {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function destroyUserSessions(userId: string): void {
  db.prepare("DELETE FROM sessions WHERE userId = ?").run(userId);
}

export function listSessions(): Array<{ token: string; userId: string; username: string; device: string; ip: string; lastActive: string }> {
  const rows = db
    .prepare(
      `SELECT s.token, s.userId, s.device, s.ip, s.createdAt, u.username
       FROM sessions s JOIN users u ON u.id = s.userId ORDER BY s.createdAt DESC`,
    )
    .all() as Row[];
  return rows.map((r) => ({
    token: String(r.token),
    userId: String(r.userId),
    username: String(r.username),
    device: String(r.device),
    ip: String(r.ip),
    lastActive: String(r.createdAt),
  }));
}

// ---------- cookies ----------
export function parseCookie(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(v.join("="));
  }
  return out;
}

// `Secure` in production (the control plane must be served over HTTPS); left
// off in dev so http://localhost still works. Override with NGINUX_SECURE_COOKIES.
const SECURE_COOKIE = process.env.NGINUX_SECURE_COOKIES
  ? process.env.NGINUX_SECURE_COOKIES === "1" || process.env.NGINUX_SECURE_COOKIES === "true"
  : IS_PROD;
const secureFlag = SECURE_COOKIE ? "; Secure" : "";

export function sessionCookie(token: string): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secureFlag}`;
}
export function clearCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secureFlag}`;
}
export { SESSION_COOKIE };

// ---------- audit log ----------
export interface AuditEvent {
  id: number;
  ts: string;
  type: string;
  severity: "info" | "notice" | "warn" | "danger";
  actor: string;
  summary: string;
  ip: string;
  meta: Record<string, unknown>;
}

export function logEvent(e: Omit<AuditEvent, "id" | "ts"> & { ts?: string }): void {
  db.prepare(
    "INSERT INTO audit_events (ts, type, severity, actor, summary, ip, meta) VALUES (?,?,?,?,?,?,?)",
  ).run(
    e.ts ?? new Date().toISOString(),
    e.type,
    e.severity,
    e.actor,
    e.summary,
    e.ip ?? "",
    JSON.stringify(e.meta ?? {}),
  );
  // Stream to SSE subscribers + webhooks (skip backdated seed events).
  if (!e.ts) emitEvent(e.type, { actor: e.actor, summary: e.summary, severity: e.severity, ip: e.ip, ...e.meta });
}

export function listEvents(opts: { type?: string; limit?: number } = {}): AuditEvent[] {
  const limit = opts.limit ?? 100;
  const rows = opts.type
    ? (db.prepare("SELECT * FROM audit_events WHERE type LIKE ? ORDER BY id DESC LIMIT ?").all(opts.type + "%", limit) as Row[])
    : (db.prepare("SELECT * FROM audit_events ORDER BY id DESC LIMIT ?").all(limit) as Row[]);
  return rows.map((r) => ({
    id: Number(r.id),
    ts: String(r.ts),
    type: String(r.type),
    severity: r.severity as AuditEvent["severity"],
    actor: String(r.actor),
    summary: String(r.summary),
    ip: String(r.ip),
    meta: JSON.parse(String(r.meta)),
  }));
}

// ---------- security posture ----------
export function securityExposure() {
  return listHosts().map((h) => ({
    id: h.id,
    name: h.name,
    emoji: h.emoji,
    domain: h.domain,
    https: h.ssl,
    login: h.requireLogin,
    twofa: h.require2fa,
    countryLock: h.countryLock,
    wellProtected: h.ssl && h.requireLogin,
  }));
}

export function securityOverview() {
  const hosts = listHosts();
  const exposed = hosts.length;
  const unprotected = hosts.filter((h) => h.ssl && !h.requireLogin).length;
  const noCountry = hosts.filter((h) => !h.countryLock).length;
  // simple posture score: start at 100, subtract for gaps
  let score = 100;
  score -= unprotected * 8;
  score -= noCountry * 2;
  score = Math.max(40, Math.min(100, score));
  const failed24h = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_events WHERE type = 'login.failed' AND ts > ?",
      )
      .get(new Date(Date.now() - 86400_000).toISOString()) as Row
  ).n as number;
  return {
    score,
    rating: score >= 90 ? "Strong" : score >= 70 ? "Good" : "Needs work",
    exposed,
    unprotected,
    failedLogins24h: failed24h,
    activeSessions: (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as Row).n as number,
  };
}

// ---------- seed ----------
export function seedAuthIfEmpty(): { usingDefault: boolean } {
  const count = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as Row).n as number;
  if (count > 0) return { usingDefault: false };

  // Ships with a well-known default (admin/admin) and forces a change on first
  // login. An operator can instead set NGINUX_ADMIN_PASSWORD to skip the default.
  const envPw = process.env.NGINUX_ADMIN_PASSWORD;
  const adminPassword = envPw || "admin";
  const usingDefault = !envPw;
  const settings = getSettings();

  const admin = createUser({
    username: "admin",
    email: settings.letsEncryptEmail || "admin@example.com",
    password: adminPassword,
    role: "admin",
  });
  if (usingDefault) {
    db.prepare("UPDATE users SET mustChangePassword = 1 WHERE id = ?").run(admin.id);
  }

  // Demo accounts + sample history are for dev/screenshots only — never seed
  // functional extra accounts (with stored TOTP secrets) into a real deployment.
  if (!IS_PROD) {
    const priya = createUser({ username: "priya", email: "priya@home", password: randomBytes(9).toString("hex"), role: "editor" });
    const media = createUser({ username: "media", email: "shared device", password: randomBytes(9).toString("hex"), role: "scoped", scope: "plex, ha" });
    createUser({ username: "guest", email: "temporary access", password: randomBytes(9).toString("hex"), role: "readonly" });
    for (const u of [priya, media]) {
      beginTwofaSetup(u.id);
      enableTwofa(u.id);
    }
    const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
    logEvent({ type: "login.success", severity: "info", actor: "admin", summary: "Signed in with password", ip: "203.0.113.10", meta: { location: "Home, CA" }, ts: ago(6) });
    logEvent({ type: "login.success", severity: "notice", actor: "priya", summary: "Signed in from a new device", ip: "203.0.113.45", meta: { location: "Pune, IN", newDevice: true }, ts: ago(3) });
    logEvent({ type: "login.failed", severity: "danger", actor: "unknown", summary: "47 failed logins — IP auto-banned", ip: "198.51.100.211", meta: { location: "Russia", count: 47 }, ts: ago(2) });
    logEvent({ type: "host.updated", severity: "notice", actor: "admin", summary: "Disabled login on cloud.ubhi.io", ip: "203.0.113.10", meta: {}, ts: ago(12) });
  }
  logEvent({ type: "system.seed", severity: "info", actor: "system", summary: "Initial admin account created", ip: "", meta: {} });
  return { usingDefault };
}
