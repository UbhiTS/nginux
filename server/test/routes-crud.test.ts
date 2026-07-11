// Route-level RBAC + input-validation regression tests for the host-mutation and
// settings endpoints, driven through app.inject() (no port bound). Each case pins
// an access-control or injection-guard invariant so a future refactor that
// re-opens the hole fails loudly. Importing index.ts builds the app inert
// (import.meta.main is false under test); we forge session cookies directly
// against the isolated test DB.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { setupTestEnv, makeHost } from "./helpers.ts";

setupTestEnv();
const { app } = await import("../src/index.ts");
const { db, saveSettings } = await import("../src/db.ts");
const { createSession } = await import("../src/auth.ts");
const { createHost } = await import("../src/repo.ts");

// Seed a user row directly (bypassing the create-user API so we can pick the role,
// scope, and mustChangePassword flag freely). Mirrors routes-rbac.test.ts's helper.
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

// A minimal, schema-valid create payload (POST /api/hosts). name/domain/forwardHost/
// forwardPort are the only required fields; everything else has a zod default.
function createPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "svc",
    domain: "app.example.com",
    forwardHost: "192.168.1.60",
    forwardPort: 3000,
    forwardScheme: "http",
    ssl: true,
    ...overrides,
  };
}

const post = (url: string, cookie: string | undefined, payload: unknown) =>
  app.inject({ method: "POST", url, headers: cookie ? { cookie } : {}, payload });
const put = (url: string, cookie: string, payload: unknown) =>
  app.inject({ method: "PUT", url, headers: { cookie }, payload });

before(async () => {
  await app.ready();
});

// ---------------------------------------------------------------------------
// (1) Host-create RBAC: only admin/editor may expose a new service. readonly and
// scoped are refused BEFORE any config is written (requireRole admin/editor).
// ---------------------------------------------------------------------------
test("POST /api/hosts: readonly and scoped are forbidden; editor and admin succeed", async () => {
  const readonly = await post("/api/hosts", cookieFor(makeUser("readonly")), createPayload({ domain: "ro.example.com" }));
  assert.equal(readonly.statusCode, 403, "a readonly user must not create a service");

  const scoped = await post("/api/hosts", cookieFor(makeUser("scoped", "app.example.com")), createPayload({ domain: "app.example.com" }));
  assert.equal(scoped.statusCode, 403, "a scoped user must not create a service");

  const editor = await post("/api/hosts", cookieFor(makeUser("editor")), createPayload({ name: "editorsvc", domain: "editor-created.example.com" }));
  assert.equal(editor.statusCode, 201, "an editor may create a service");

  const admin = await post("/api/hosts", cookieFor(makeUser("admin")), createPayload({ name: "adminsvc", domain: "admin-created.example.com" }));
  assert.equal(admin.statusCode, 201, "an admin may create a service");
});

// ---------------------------------------------------------------------------
// (2) Host-update scope: a scoped user may only PUT a host in their scope. An
// out-of-scope scoped user is denied; the in-scope owner is allowed.
// ---------------------------------------------------------------------------
test("PUT /api/hosts/:id: scoped user confined to their scope", async () => {
  const plex = createHost(makeHost({ name: "plex", domain: "plex.example.com" }));

  const outOfScope = await put(`/api/hosts/${plex.id}`, cookieFor(makeUser("scoped", "other")), { forwardPort: 3001 });
  assert.ok(
    outOfScope.statusCode === 403 || outOfScope.statusCode === 404,
    `an out-of-scope scoped user must be denied (got ${outOfScope.statusCode})`,
  );

  const inScope = await put(`/api/hosts/${plex.id}`, cookieFor(makeUser("scoped", "plex")), { forwardPort: 3001 });
  assert.equal(inScope.statusCode, 200, "the in-scope scoped owner may update their service");
});

// ---------------------------------------------------------------------------
// (3) Host-delete RBAC: a scoped user may manage but NOT delete their service -
// delete is admin/editor only (requireRole), even for an in-scope host.
// ---------------------------------------------------------------------------
test("DELETE /api/hosts/:id: a scoped user is forbidden", async () => {
  const svc = createHost(makeHost({ name: "grafana", domain: "grafana.example.com" }));
  const r = await app.inject({
    method: "DELETE",
    url: `/api/hosts/${svc.id}`,
    headers: { cookie: cookieFor(makeUser("scoped", "grafana")) },
  });
  assert.equal(r.statusCode, 403, "a scoped user must not delete a service");
});

// ---------------------------------------------------------------------------
// (4) Input validation: nginx metacharacters in the domain and an out-of-range
// port are rejected with 400 before anything is written - even for an admin.
// ---------------------------------------------------------------------------
test("POST /api/hosts: admin input is still validated (metachars + port range)", async () => {
  const adminCookie = cookieFor(makeUser("admin"));

  const metachars = await post("/api/hosts", adminCookie, createPayload({ domain: "a;b{}" }));
  assert.equal(metachars.statusCode, 400, "a domain with nginx metacharacters must be rejected");

  const badPort = await post("/api/hosts", adminCookie, createPayload({ domain: "portcheck.example.com", forwardPort: 70000 }));
  assert.equal(badPort.statusCode, 400, "a forwardPort above 65535 must be rejected");
});

// ---------------------------------------------------------------------------
// (5) Settings injection guard (regression): allowedCountries is charset-guarded
// so a value carrying nginx/config metacharacters can never reach the generated
// geo map. A clean comma-separated list is accepted.
// ---------------------------------------------------------------------------
test("PUT /api/settings: allowedCountries rejects injection, accepts a clean list", async () => {
  const adminCookie = cookieFor(makeUser("admin"));

  const injected = await put("/api/settings", adminCookie, { allowedCountries: "JP;return 403" });
  assert.equal(injected.statusCode, 400, "allowedCountries with metacharacters must be rejected");

  const clean = await put("/api/settings", adminCookie, { allowedCountries: "JP,GB" });
  assert.equal(clean.statusCode, 200, "a clean comma-separated country list must be accepted");
});

// ---------------------------------------------------------------------------
// (6) Settings RBAC: writing settings is admin-only; an editor is refused.
// ---------------------------------------------------------------------------
test("PUT /api/settings: a non-admin (editor) is forbidden", async () => {
  const r = await put("/api/settings", cookieFor(makeUser("editor")), { instanceName: "hijacked" });
  assert.equal(r.statusCode, 403, "an editor must not change global settings");
});

// ---------------------------------------------------------------------------
// (7) Unauthenticated mutation: a POST with no session is refused at the auth
// guard (401) before reaching the handler.
// ---------------------------------------------------------------------------
test("POST /api/hosts: unauthenticated request is 401", async () => {
  const r = await post("/api/hosts", undefined, createPayload({ domain: "anon.example.com" }));
  assert.equal(r.statusCode, 401, "an unauthenticated create must be rejected");
});

// Keep the linter/test-runner happy about the (intentionally imported per the
// harness contract) saveSettings binding without exercising it here.
void saveSettings;
