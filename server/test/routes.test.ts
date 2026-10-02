// Route-level RBAC via app.inject() (no port bound). This is where most of the
// access-control audit fixes live, so it's the highest-value regression surface.
// Importing index.ts builds the app inert (import.meta.main is false under test).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { setupTestEnv } from "./helpers.ts";

setupTestEnv();
const { app } = await import("../src/index.ts");
const { createSession } = await import("../src/auth.ts");
const { db } = await import("../src/db.ts");

// Helpers to forge a session cookie for a given role (seeded admin exists already).
function makeUser(role: string, scope = "") {
  const id = `u_${role}_${Math.floor(performance.now() * 1000)}`;
  db.prepare("INSERT INTO users (id, username, email, passwordHash, role, scope, twofaEnabled, backupCodes, twofaLastCounter, mustChangePassword, createdAt) VALUES (?,?,?,?,?,?,0,'[]',-1,0,?)")
    .run(id, `${id}`, "", "x", role, scope, new Date().toISOString());
  return id;
}
function cookieFor(userId: string): string {
  const token = createSession(userId, "test", "127.0.0.1");
  return `nginux_session=${token}`;
}

before(async () => { await app.ready(); });

test("health is open (no auth)", async () => {
  const r = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(r.statusCode, 200);
});

test("unauthenticated API calls are rejected", async () => {
  for (const url of ["/api/hosts", "/api/logs/recent", "/api/config/versions", "/api/topology"]) {
    const r = await app.inject({ method: "GET", url });
    assert.equal(r.statusCode, 401, `${url} should be 401 unauthenticated`);
  }
});

test("readonly user cannot read /api/logs/recent or /api/config/versions (audit RBAC)", async () => {
  const cookie = cookieFor(makeUser("readonly"));
  for (const url of ["/api/logs/recent", "/api/config/versions", "/api/events/sse"]) {
    const r = await app.inject({ method: "GET", url, headers: { cookie } });
    assert.equal(r.statusCode, 403, `${url} should be 403 for readonly`);
  }
});

test("admin can read the gated routes", async () => {
  // The seeded admin has mustChangePassword=1; clear it so it can pass beyond the gate.
  db.prepare("UPDATE users SET mustChangePassword = 0 WHERE role = 'admin'").run();
  const adminId = (db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get() as { id: string }).id;
  const cookie = cookieFor(adminId);
  const r = await app.inject({ method: "GET", url: "/api/config/versions", headers: { cookie } });
  assert.equal(r.statusCode, 200);
});

test("POST /api/notifications/dismiss persists per-user dismissals and never suppresses non-dismissible notices", async () => {
  const { createHost, replaceAllHosts } = await import("../src/repo.ts");
  const { saveSettings } = await import("../src/db.ts");
  const { makeHost } = await import("./helpers.ts");

  replaceAllHosts([]);
  saveSettings({ ssoLoginUrl: "https://auth.example.com/nginux-login", ssoCookieDomain: ".example.com", ssoForwardSecret: "" });
  // Triggers a dismissible warning (forward-secret-missing) and a non-dismissible
  // critical notice (stream-shared-cookie:<id>) at the same time.
  const webHost = createHost(makeHost({ domain: "app.example.com", ssl: false, requireLogin: true }));
  const streamHost = createHost(makeHost({ domain: "raw.example.com", protocol: "sni", listenPort: 8443, ssl: false }));

  const adminA = cookieFor(makeUser("admin"));
  const adminB = cookieFor(makeUser("admin"));

  const initialRes = await app.inject({ method: "GET", url: "/api/notifications", headers: { cookie: adminA } });
  assert.equal(initialRes.statusCode, 200);
  const initial = initialRes.json() as Array<{ id: string; dismissible: boolean }>;
  assert.ok(initial.some((n) => n.id === "forward-secret-missing" && n.dismissible === true));
  const criticalId = `stream-shared-cookie:${streamHost.id}`;
  assert.ok(initial.some((n) => n.id === criticalId && n.dismissible === false));

  // Admin A dismisses both the dismissible warning and attempts to dismiss the non-dismissible critical notice.
  const dismissRes = await app.inject({
    method: "POST",
    url: "/api/notifications/dismiss",
    headers: { cookie: adminA },
    payload: { ids: ["forward-secret-missing", criticalId, "port-forward-reminder"] },
  });
  assert.equal(dismissRes.statusCode, 200);

  // Admin A no longer receives the dismissible warning, but STILL receives the non-dismissible critical notice.
  const afterA = (await app.inject({ method: "GET", url: "/api/notifications", headers: { cookie: adminA } })).json() as Array<{ id: string }>;
  assert.equal(afterA.some((n) => n.id === "forward-secret-missing"), false);
  assert.equal(afterA.some((n) => n.id === criticalId), true);

  // Admin B is unaffected by Admin A's dismissal.
  const afterB = (await app.inject({ method: "GET", url: "/api/notifications", headers: { cookie: adminB } })).json() as Array<{ id: string }>;
  assert.equal(afterB.some((n) => n.id === "forward-secret-missing"), true);

  replaceAllHosts([]);
  void webHost;
});
