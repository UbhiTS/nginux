// Deep route-level RBAC regression tests, driven through app.inject() (no port
// bound). Each case below pins a specific access-control audit fix so a future
// refactor that re-opens the hole fails loudly. Importing index.ts builds the app
// inert (import.meta.main is false under test); we forge session cookies + API
// tokens directly against the isolated test DB.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { setupTestEnv } from "./helpers.ts";
import { makeHost } from "./helpers.ts";

setupTestEnv();
const { app } = await import("../src/index.ts");
const { db, saveSettings } = await import("../src/db.ts");
const { createSession, listUsers, updateUserRole, countAdmins } = await import("../src/auth.ts");
const { createHost, getHostByDomain } = await import("../src/repo.ts");
const { createToken } = await import("../src/tokens.ts");

// The per-host login-gate shared secret nginx sends on the forward-auth subrequest.
const FWD_SECRET = "fwd-secret-abcdef0123456789";

// Seed a user row directly (bypassing the create-user API so we can pick the role,
// scope, and mustChangePassword flag freely). Mirrors routes.test.ts's helper.
function makeUser(role: string, scope = "", mustChange = 0): string {
  const id = `u_${role}_${Math.floor(performance.now() * 1000)}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    "INSERT INTO users (id, username, email, passwordHash, role, scope, twofaEnabled, backupCodes, twofaLastCounter, mustChangePassword, createdAt) VALUES (?,?,?,?,?,?,0,'[]',-1,?,?)",
  ).run(id, id, "", "x", role, scope, mustChange, new Date().toISOString());
  return id;
}
function cookieFor(userId: string): string {
  return `nginux_session=${createSession(userId, "t", "127.0.0.1")}`;
}
// Create a host once; a second call for the same domain is a no-op (hosts.domain
// is UNIQUE, and several cases below deliberately reference the same domain).
function ensureHost(overrides: Parameters<typeof makeHost>[0]): void {
  const h = makeHost(overrides);
  if (!getHostByDomain(h.domain)) createHost(h);
}
// Mint an API token and capture its raw bearer value (only returned once).
function mintToken(scopes: Array<"read" | "report" | "control" | "security">): string {
  return createToken({ name: `tok_${scopes.join("-")}_${Math.random().toString(36).slice(2, 8)}`, scopes }).token;
}

before(async () => {
  await app.ready();
  // index.ts auto-generates a random forward secret on boot; pin it to a known
  // value so the forward-auth tests can present the matching header.
  saveSettings({ ssoForwardSecret: FWD_SECRET });
});

// ---------------------------------------------------------------------------
// (#8) A temporary/default-password session must NOT satisfy a per-host login
// gate. Otherwise the fresh-install admin/admin default would reach every backend.
// ---------------------------------------------------------------------------
test("#8 forward-auth rejects a mustChangePassword session, then allows once cleared", async () => {
  ensureHost({ name: "plex", domain: "plex.example.com", requireLogin: true });
  const uid = makeUser("admin", "", 1); // temp-password admin
  const headers = {
    "x-nginux-forward-secret": FWD_SECRET,
    "x-original-host": "plex.example.com",
    cookie: cookieFor(uid),
  };

  const blocked = await app.inject({ method: "GET", url: "/api/auth/forward", headers });
  assert.equal(blocked.statusCode, 401, "temp-password session must not pass the login gate");

  // Clear the temp-password flag; the same identity now satisfies the gate.
  db.prepare("UPDATE users SET mustChangePassword = 0 WHERE id = ?").run(uid);
  const allowed = await app.inject({ method: "GET", url: "/api/auth/forward", headers });
  assert.equal(allowed.statusCode, 200, "a real-password admin session should pass the login gate");
});

// ---------------------------------------------------------------------------
// The forward-auth endpoint is only usefully callable with the shared secret;
// nginx sends it on every subrequest. A caller that omits it is refused.
// ---------------------------------------------------------------------------
test("forward-auth requires the shared secret header", async () => {
  const uid = makeUser("admin", "", 0);
  const r = await app.inject({
    method: "GET",
    url: "/api/auth/forward",
    headers: { "x-original-host": "plex.example.com", cookie: cookieFor(uid) },
  });
  assert.equal(r.statusCode, 401, "missing x-nginux-forward-secret must be rejected");
});

// ---------------------------------------------------------------------------
// (#7) Access logs carry client IPs, so a token needs the 'report' scope (mirrors
// the recent_logs MCP tool). A bare 'read' token must not read them.
// ---------------------------------------------------------------------------
test("#7 /api/logs/recent enforces token scope: 'read' forbidden, 'report' allowed", async () => {
  const readTok = mintToken(["read"]);
  const forbidden = await app.inject({
    method: "GET",
    url: "/api/logs/recent",
    headers: { authorization: `Bearer ${readTok}` },
  });
  assert.equal(forbidden.statusCode, 403, "a 'read'-only token must not read access logs");

  const reportTok = mintToken(["report"]);
  const allowed = await app.inject({
    method: "GET",
    url: "/api/logs/recent",
    headers: { authorization: `Bearer ${reportTok}` },
  });
  assert.equal(allowed.statusCode, 200, "a 'report'-scoped token may read access logs");
});

// ---------------------------------------------------------------------------
// (#16) A scoped principal's topology must only reveal the services it may see -
// one NginUX login must not leak the full network map.
// ---------------------------------------------------------------------------
test("#16 /api/topology is filtered to a scoped user's services", async () => {
  ensureHost({ name: "plex", domain: "plex.example.com" });
  ensureHost({ name: "immich", domain: "immich.example.com" });
  const uid = makeUser("scoped", "plex");

  const r = await app.inject({ method: "GET", url: "/api/topology", headers: { cookie: cookieFor(uid) } });
  assert.equal(r.statusCode, 200);
  const body = r.payload;
  assert.ok(body.includes("plex.example.com"), "an in-scope service must appear in the topology");
  assert.ok(!body.includes("immich"), "an out-of-scope service must be absent from the topology");
});

// ---------------------------------------------------------------------------
// CSRF: a cookie-authenticated mutation carrying a cross-origin Origin is refused
// before it can change state, even for a fully-privileged admin session.
// ---------------------------------------------------------------------------
test("cross-origin cookie mutation is blocked (CSRF guard)", async () => {
  const cookie = cookieFor(makeUser("admin", "", 0));
  const r = await app.inject({
    method: "POST",
    url: "/api/hosts",
    headers: { cookie, origin: "https://evil.example.com", host: "localhost" },
    payload: { name: "x" },
  });
  assert.equal(r.statusCode, 403, "a cross-origin admin POST must be blocked");
});

// ---------------------------------------------------------------------------
// (#6) The live audit/security SSE feed carries login-failure client IPs, bans,
// and user changes - gate it like the pull endpoint (admin/editor or 'report'
// token). A bare 'read' token is refused BEFORE the stream is hijacked.
// ---------------------------------------------------------------------------
test("#6 /api/events/sse rejects a 'read'-scope token", async () => {
  const readTok = mintToken(["read"]);
  const r = await app.inject({
    method: "GET",
    url: "/api/events/sse",
    headers: { authorization: `Bearer ${readTok}` },
  });
  assert.equal(r.statusCode, 403, "a 'read'-only token must not open the security event stream");
});

// ---------------------------------------------------------------------------
// Session management: list exposes a non-secret sid (never the token) + flags the
// caller's own session; an admin can revoke any session; non-admins can't.
// ---------------------------------------------------------------------------
test("sessions: admin lists sid+current (no token) and can revoke one", async () => {
  const adminId = makeUser("admin");
  const victimId = makeUser("editor");
  createSession(victimId, "phone", "10.0.0.9");
  const adminCookie = cookieFor(adminId);

  const listed = (await app.inject({ method: "GET", url: "/api/sessions", headers: { cookie: adminCookie } })).json() as Array<Record<string, unknown>>;
  const victim = listed.find((s) => s.username === victimId);
  assert.ok(victim?.sid, "victim session is listed with a sid");
  assert.equal("token" in victim!, false, "the raw session token is never returned");
  assert.ok(listed.some((s) => s.current === true), "the admin's own session is flagged current");

  const del = await app.inject({ method: "DELETE", url: `/api/sessions/${victim!.sid}`, headers: { cookie: adminCookie } });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(del.json(), { ok: true });

  const after = (await app.inject({ method: "GET", url: "/api/sessions", headers: { cookie: adminCookie } })).json() as Array<Record<string, unknown>>;
  assert.equal(after.some((s) => s.sid === victim!.sid), false, "the revoked session is gone");
});

test("sessions: a non-admin can neither list nor revoke", async () => {
  const editorId = makeUser("editor");
  assert.equal((await app.inject({ method: "GET", url: "/api/sessions", headers: { cookie: cookieFor(editorId) } })).statusCode, 403);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/sessions/deadbeefdeadbeef", headers: { cookie: cookieFor(editorId) } })).statusCode, 403);
});

// ---------------------------------------------------------------------------
// Role change in place (promote/demote without delete+recreate), with a
// last-admin guard so the instance can't be locked out of admin.
// ---------------------------------------------------------------------------
test("role change: admin promotes a user in place", async () => {
  const adminId = makeUser("admin");
  const targetId = makeUser("readonly");
  const res = await app.inject({ method: "PATCH", url: `/api/users/${targetId}/role`, headers: { cookie: cookieFor(adminId) }, payload: { role: "editor" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().role, "editor");
});

test("role change: the last admin cannot be demoted", async () => {
  const soleAdmin = makeUser("admin");
  // Collapse to a single admin so the guard is exercised deterministically.
  for (const u of listUsers()) if (u.role === "admin" && u.id !== soleAdmin) updateUserRole(u.id, "editor");
  assert.equal(countAdmins(), 1, "exactly one admin remains");
  const res = await app.inject({ method: "PATCH", url: `/api/users/${soleAdmin}/role`, headers: { cookie: cookieFor(soleAdmin) }, payload: { role: "editor" } });
  assert.equal(res.statusCode, 400);
  assert.match(String(res.json().error), /last admin/i);
  assert.equal(countAdmins(), 1, "the demotion was refused; the admin is intact");
});

test("role change: a non-admin can't change roles", async () => {
  const editorId = makeUser("editor");
  const targetId = makeUser("readonly");
  const res = await app.inject({ method: "PATCH", url: `/api/users/${targetId}/role`, headers: { cookie: cookieFor(editorId) }, payload: { role: "admin" } });
  assert.equal(res.statusCode, 403);
});

// ---------------------------------------------------------------------------
// Route-split guard matrix. The routes were extracted from index.ts into
// server/src/routes/*.ts; this pins that EVERY sensitive endpoint still (a) rejects
// unauthenticated callers and (b) enforces its role floor — so any future extraction
// that silently drops a requireAdmin/requireRole fails this test loudly. This is the
// exact "unauthenticated / under-privileged reaches an admin surface" regression class.
// ---------------------------------------------------------------------------
test("route-split guard matrix: extracted endpoints keep auth + RBAC", async () => {
  const readonly = cookieFor(makeUser("readonly"));
  const editor = cookieFor(makeUser("editor"));
  const adminOnly = [
    "/api/users", "/api/tokens", "/api/webhooks", "/api/channels",
    "/api/agents/approvals", "/api/agents/overview", "/api/update/status",
    "/api/sessions", "/api/config/export",
  ];
  const adminEditor = [
    "/api/audit", "/api/security/overview", "/api/security/exposure",
    "/api/security/blocked", "/api/certificates", "/api/bans",
  ];
  for (const url of [...adminOnly, ...adminEditor]) {
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 401, `${url} must reject unauthenticated`);
  }
  for (const url of adminOnly) {
    assert.equal((await app.inject({ method: "GET", url, headers: { cookie: readonly } })).statusCode, 403, `${url} must reject readonly`);
    assert.equal((await app.inject({ method: "GET", url, headers: { cookie: editor } })).statusCode, 403, `${url} is admin-only, must reject editor`);
  }
  for (const url of adminEditor) {
    assert.equal((await app.inject({ method: "GET", url, headers: { cookie: readonly } })).statusCode, 403, `${url} must reject readonly`);
    assert.equal((await app.inject({ method: "GET", url, headers: { cookie: editor } })).statusCode, 200, `${url} must allow editor`);
  }
});
