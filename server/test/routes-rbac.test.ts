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
const { createHost, getHost, getHostByDomain } = await import("../src/repo.ts");
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
// (#8b) The gate FAILS CLOSED for a host it can't resolve, for EVERY role — not
// just scoped users. nginx only forward-auths managed (requireLogin) hosts and always
// stamps X-Original-Host, so an unresolvable host is abnormal (config drift, or an
// input shape the lookup misses); admitting it would silently skip the per-host
// require2fa/scope checks. This is the recurrence class ("unauth reaches services"):
// the *default* for an unidentifiable gated request must be deny, not allow.
// Regression for the 2026-07-12 audit.
// ---------------------------------------------------------------------------
test("#8b forward-auth fails closed for an unresolvable host (fully-privileged, non-scoped session)", async () => {
  const uid = makeUser("editor", "", 0); // real-password, non-scoped, no 2FA
  const r = await app.inject({
    method: "GET",
    url: "/api/auth/forward",
    headers: {
      "x-nginux-forward-secret": FWD_SECRET,
      "x-original-host": "not-a-managed-host.example.com",
      cookie: cookieFor(uid),
    },
  });
  assert.equal(r.statusCode, 401, "a gated request for an unknown host must be denied, not admitted with 200");
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

test("webhook creation audit records only scheme + host/port, never URL credentials", async () => {
  const admin = cookieFor(makeUser("admin"));
  const http = await app.inject({
    method: "POST",
    url: "/api/webhooks",
    headers: { cookie: admin },
    payload: {
      url: "https://collector-user:TOPSECRET@hooks.example.com:8443/private/token-path?api_key=TOPSECRET",
      // Do not match webhook.created, so this regression makes no outbound request.
      events: ["security.ip_banned"],
    },
  });
  assert.equal(http.statusCode, 201);
  const httpAudit = db.prepare("SELECT summary FROM audit_events WHERE type = 'webhook.created' ORDER BY id DESC LIMIT 1").get() as { summary: string };
  assert.equal(httpAudit.summary, "Created webhook → https://hooks.example.com:8443");
  assert.doesNotMatch(httpAudit.summary, /TOPSECRET|collector-user|private|api_key/);

  const syslog = await app.inject({
    method: "POST",
    url: "/api/webhooks",
    headers: { cookie: admin },
    payload: { url: "syslog+tcp://siem.example.com:6514", events: ["security.ip_banned"] },
  });
  assert.equal(syslog.statusCode, 201);
  const syslogAudit = db.prepare("SELECT summary FROM audit_events WHERE type = 'webhook.created' ORDER BY id DESC LIMIT 1").get() as { summary: string };
  assert.equal(syslogAudit.summary, "Created webhook → syslog+tcp://siem.example.com:6514");
});

test("certificate routes reject internal names and do not report deletion of untracked paths", async () => {
  const editor = cookieFor(makeUser("editor"));
  const reserved = await app.inject({
    method: "DELETE",
    url: "/api/certificates/acme-account.key",
    headers: { cookie: editor },
  });
  assert.equal(reserved.statusCode, 400, "the ACME account-key filename is never a domain route target");

  const missing = await app.inject({
    method: "DELETE",
    url: "/api/certificates/not-tracked.example.com",
    headers: { cookie: editor },
  });
  assert.equal(missing.statusCode, 404, "only a tracked certificate may be deleted");
});

test("non-admin host reads redact custom nginx secrets and an empty PUT cannot erase them", async () => {
  const marker = "upstream-admin-secret-DO-NOT-LEAK";
  const host = createHost(makeHost({
    id: `raw-secret-${Math.random().toString(36).slice(2, 8)}`,
    domain: `raw-secret-${Math.random().toString(36).slice(2, 8)}.example.com`,
    customNginx: `proxy_set_header Authorization "Bearer ${marker}";`,
  }));
  const readonly = cookieFor(makeUser("readonly"));
  const detail = await app.inject({ method: "GET", url: `/api/hosts/${host.id}`, headers: { cookie: readonly } });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().customNginx, "");
  assert.doesNotMatch(detail.payload, new RegExp(marker));

  const config = await app.inject({ method: "GET", url: `/api/hosts/${host.id}/config`, headers: { cookie: readonly } });
  assert.equal(config.statusCode, 200);
  assert.doesNotMatch(config.payload, new RegExp(marker), "generated config for a non-admin must omit raw admin directives");

  const editor = cookieFor(makeUser("editor"));
  const update = await app.inject({
    method: "PUT", url: `/api/hosts/${host.id}`, headers: { cookie: editor },
    payload: { name: "safe rename", customNginx: "" },
  });
  assert.equal(update.statusCode, 200, "the redacted full-form placeholder is ignored rather than rejected");
  assert.match(getHost(host.id)?.customNginx ?? "", new RegExp(marker), "an editor cannot erase an admin's directive with an empty value");
});

test("already-throttled login traffic is memory/audit bounded and not webhook-amplified", async () => {
  const before = Number((db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n);
  for (let i = 0; i < 80; i++) {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "198.51.100.77",
      payload: { username: `missing-throttle-user`, password: "wrong-password" },
    });
    assert.ok(r.statusCode === 401 || r.statusCode === 429);
  }
  const after = Number((db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n);
  assert.ok(after - before <= 12, `80 requests should create only initial failures + one throttled audit (created ${after - before})`);
});

test("sensitive mutation matrix rejects unauthenticated and readonly callers before parsing or side effects", async () => {
  const readonly = cookieFor(makeUser("readonly"));
  const cases: Array<[string, string]> = [
    ["PUT", "/api/settings"],
    ["POST", "/api/tokens"], ["DELETE", "/api/tokens/not-found"],
    ["POST", "/api/webhooks"], ["DELETE", "/api/webhooks/not-found"],
    ["POST", "/api/channels"], ["PUT", "/api/channels/not-found/enabled"],
    ["PUT", "/api/channels/not-found/routing"], ["POST", "/api/channels/not-found/test"],
    ["DELETE", "/api/channels/not-found"],
    ["POST", "/api/agents/approvals/not-found/approve"], ["POST", "/api/agents/approvals/not-found/deny"],
    ["POST", "/api/certificates/example.com/issue"], ["POST", "/api/certificates/example.com/renew"],
    ["PUT", "/api/certificates/example.com/autorenew"], ["POST", "/api/certificates/import"],
    ["DELETE", "/api/certificates/example.com"],
    ["POST", "/api/bans"], ["DELETE", "/api/bans/203.0.113.10"],
    ["POST", "/api/geoip/download"], ["DELETE", "/api/geoip"],
    ["POST", "/api/security-profiles"], ["PUT", "/api/security-profiles/not-found"],
    ["DELETE", "/api/security-profiles/not-found"], ["POST", "/api/security-profiles/not-found/apply"],
    ["POST", "/api/update/check"], ["POST", "/api/update/apply"],
    ["POST", "/api/config/restore"], ["POST", "/api/config/import"],
  ];
  for (const [method, url] of cases) {
    const unauth = await app.inject({ method: method as never, url, payload: {} });
    assert.equal(unauth.statusCode, 401, `${method} ${url} must reject unauthenticated callers before input parsing`);
    const underprivileged = await app.inject({ method: method as never, url, headers: { cookie: readonly }, payload: {} });
    assert.equal(underprivileged.statusCode, 403, `${method} ${url} must reject readonly callers before input parsing`);
  }
});
