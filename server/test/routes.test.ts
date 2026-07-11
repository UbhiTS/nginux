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
