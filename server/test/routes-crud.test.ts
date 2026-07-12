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

const get = (url: string, cookie: string) => app.inject({ method: "GET", url, headers: { cookie } });

// ---------------------------------------------------------------------------
// (8) REGRESSION (audit): a scoped user manages their service but may not change
// its ROUTING/POSTURE. Repointing to a different host, hijacking the domain, or
// flipping TLS is forbidden; moving to a new PORT on the same box is allowed
// (legitimate management, and can't pivot to a different machine).
// ---------------------------------------------------------------------------
test("PUT /api/hosts/:id: scoped owner may change forwardPort but NOT forwardHost/domain/ssl", async () => {
  const svc = createHost(makeHost({ id: "scoped-fields", name: "scopedfields", domain: "scoped-fields.example.com" }));
  const owner = cookieFor(makeUser("scoped", "scopedfields"));

  const port = await put(`/api/hosts/${svc.id}`, owner, { forwardPort: 3001 });
  assert.equal(port.statusCode, 200, "a scoped owner may move their app to a new port on the same box");

  for (const [field, patch] of [
    ["forwardHost", { forwardHost: "10.9.9.9" }],   // repoint to a different machine (SSRF pivot)
    ["forwardScheme", { forwardScheme: "https" }],   // routing/posture
    ["domain", { domain: "admin.example.com" }],     // domain hijack
    ["ssl", { ssl: false }],                          // TLS posture
  ] as const) {
    const r = await put(`/api/hosts/${svc.id}`, owner, patch);
    assert.equal(r.statusCode, 403, `a scoped user must not change ${field}`);
  }
});

// ---------------------------------------------------------------------------
// (9) REGRESSION (audit): the per-host metrics endpoints reveal which services
// exist + their volume, so they're admin/editor-only. A scoped user must not be
// able to enumerate out-of-scope hosts through the Network Map data feeds.
// ---------------------------------------------------------------------------
test("GET metrics/traffic feeds are denied to a scoped user (host enumeration guard)", async () => {
  const scoped = cookieFor(makeUser("scoped", "grafana"));
  for (const url of ["/api/metrics/hosts", "/api/metrics/host-stats", "/api/traffic", "/api/metrics/summary"]) {
    const r = await get(url, scoped);
    assert.equal(r.statusCode, 403, `${url} must be forbidden to a scoped user`);
  }
  // …but an admin can read them.
  const admin = cookieFor(makeUser("admin"));
  const ok = await get("/api/metrics/hosts", admin);
  assert.equal(ok.statusCode, 200, "an admin may read the per-host traffic feed");
});

// ---------------------------------------------------------------------------
// (10) REGRESSION (audit): the control-plane-domain hijack guard must fire on a
// PORT-ONLY update, not just a domain change. A host already on the sign-in
// portal domain, repointed off :6767, would break sign-in for every gated
// service - so a port-only PUT that creates that state must be refused.
// ---------------------------------------------------------------------------
test("PUT /api/hosts/:id: port-only edit that repoints the portal domain off the control plane is 409", async () => {
  saveSettings({ ssoLoginUrl: "https://portal.example.com" });
  // A host correctly forwarding the portal domain to the control plane (:6767).
  const portal = createHost(makeHost({ id: "portal-host", name: "portal", domain: "portal.example.com", forwardPort: 6767 }));
  const admin = cookieFor(makeUser("admin"));

  // Changing ONLY the port to something other than 6767 would break the sign-in
  // portal - the guard must reject it even though the domain is unchanged.
  const bad = await put(`/api/hosts/${portal.id}`, admin, { forwardPort: 8080 });
  assert.equal(bad.statusCode, 409, "a port-only edit that breaks the sign-in portal must be refused");

  // An unrelated edit that leaves domain + port intact is still allowed.
  const ok = await put(`/api/hosts/${portal.id}`, admin, { name: "Portal (renamed)" });
  assert.equal(ok.statusCode, 200, "an unrelated field edit on the portal host must still succeed");
  saveSettings({ ssoLoginUrl: "" }); // restore default so later tests aren't affected
});

// ---------------------------------------------------------------------------
// (11) Config-diff preview (feature): dry-run a create/update/delete and return
// the nginx-config diff WITHOUT writing or reloading. Admin/editor only (the diff
// spans every host's file); bad input is 400; an unknown id is 404.
// ---------------------------------------------------------------------------
test("POST /api/config/preview: a create dry-run returns the added config file, without persisting", async () => {
  const admin = cookieFor(makeUser("admin"));
  const r = await post("/api/config/preview", admin, {
    mode: "create",
    host: createPayload({ name: "previewsvc", domain: "preview-new.example.com" }),
  });
  assert.equal(r.statusCode, 200, "an admin may preview a create");
  const body = r.json() as { changed: boolean; files: Array<{ name: string; status: string; additions: number }> };
  const added = body.files.find((f) => f.name === "preview-new.example.com.conf");
  assert.ok(added && added.status === "added", "the proposed host's file must show as added");
  assert.ok(added.additions > 0, "an added file has additions");
  // Preview must NOT have created the host.
  const list = await app.inject({ method: "GET", url: "/api/hosts", headers: { cookie: admin } });
  assert.ok(!(list.json() as Array<{ domain: string }>).some((h) => h.domain === "preview-new.example.com"), "preview must not persist the host");
});

test("POST /api/config/preview: a scoped user is forbidden (diff spans all hosts)", async () => {
  const r = await post("/api/config/preview", cookieFor(makeUser("scoped", "whatever")), {
    mode: "create", host: createPayload({ domain: "nope.example.com" }),
  });
  assert.equal(r.statusCode, 403, "a scoped user must not preview the whole config set");
});

test("POST /api/config/preview: invalid proposed host is 400; unknown update id is 404", async () => {
  const admin = cookieFor(makeUser("admin"));
  const bad = await post("/api/config/preview", admin, { mode: "create", host: { name: "a;b{}", domain: "x.example.com", forwardHost: "1.2.3.4", forwardPort: 3000 } });
  assert.equal(bad.statusCode, 400, "an injection-laden proposed host must be rejected");

  const missing = await post("/api/config/preview", admin, { mode: "update", id: "no-such-host", host: { forwardPort: 3001 } });
  assert.equal(missing.statusCode, 404, "previewing an update to a nonexistent host is 404");
});

// ---------------------------------------------------------------------------
// (12) Self-update endpoints are admin-only (an editor manages services but not
// the platform itself). GET /status returns the cached build identity (no network).
// ---------------------------------------------------------------------------
test("GET /api/update/status is admin-only and reports the running build", async () => {
  const editor = await app.inject({ method: "GET", url: "/api/update/status", headers: { cookie: cookieFor(makeUser("editor")) } });
  assert.equal(editor.statusCode, 403, "an editor may not read platform update status");

  const admin = await app.inject({ method: "GET", url: "/api/update/status", headers: { cookie: cookieFor(makeUser("admin")) } });
  assert.equal(admin.statusCode, 200, "an admin may read update status");
  const body = admin.json() as { current: string; canSelfUpdate: boolean };
  assert.ok(typeof body.current === "string" && body.current.length > 0, "status reports the current version");
  // canSelfUpdate depends on a live Docker socket, which varies by runner (GitHub's
  // ubuntu runners have one) - assert the type, not a fixed value.
  assert.equal(typeof body.canSelfUpdate, "boolean", "self-update capability is a boolean");
});

test("POST /api/update/apply is admin-only", async () => {
  const editor = await app.inject({ method: "POST", url: "/api/update/apply", headers: { cookie: cookieFor(makeUser("editor")) } });
  assert.equal(editor.statusCode, 403, "an editor may not trigger a self-update");
});

// ---------------------------------------------------------------------------
// (13) Enforce-2FA policy (feature 4.9): when require2faForManagers is on, an
// admin/editor without 2FA is confined to the enrollment flow; read-only/scoped
// and already-enrolled managers are unaffected.
// ---------------------------------------------------------------------------
test("require2faForManagers confines a manager without 2FA to the enrollment flow", async () => {
  saveSettings({ require2faForManagers: true });
  const admin = cookieFor(makeUser("admin")); // makeUser sets twofaEnabled = 0

  // /me still works and reports the pending enrollment.
  const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: admin } });
  assert.equal(me.statusCode, 200, "/me stays reachable");
  assert.equal((me.json() as { mustEnable2fa: boolean }).mustEnable2fa, true, "the flag surfaces to the SPA");

  // A normal endpoint is blocked with the mustEnable2fa marker.
  const hosts = await app.inject({ method: "GET", url: "/api/hosts", headers: { cookie: admin } });
  assert.equal(hosts.statusCode, 403, "a manager owing 2FA can't reach the app");
  assert.equal((hosts.json() as { mustEnable2fa?: boolean }).mustEnable2fa, true, "…with the enrollment marker");

  // The enrollment endpoint itself stays reachable (setup requires the password,
  // so a 403 for the wrong reason would be a different error; we only assert it is
  // NOT the mustEnable2fa confinement).
  const setup = await app.inject({ method: "POST", url: "/api/auth/2fa/setup", headers: { cookie: admin }, payload: { password: "wrong" } });
  assert.notEqual((setup.json() as { mustEnable2fa?: boolean }).mustEnable2fa, true, "the enrollment path is not self-blocked");
  saveSettings({ require2faForManagers: false });
});

// ---------------------------------------------------------------------------
// (14) Bulk actions (feature 4.5): one action across many services, admin/editor
// only, with a single reload. delete/disable/maintenance verified.
// ---------------------------------------------------------------------------
test("POST /api/hosts/batch applies one action to many services (admin/editor only)", async () => {
  const a = createHost(makeHost({ id: "bulk-a", name: "bulka", domain: "bulk-a.example.com", enabled: true, maintenanceMode: false }));
  const b = createHost(makeHost({ id: "bulk-b", name: "bulkb", domain: "bulk-b.example.com", enabled: true, maintenanceMode: false }));
  const admin = cookieFor(makeUser("admin"));

  // A readonly user is refused.
  const ro = await post("/api/hosts/batch", cookieFor(makeUser("readonly")), { ids: [a.id], action: "disable" });
  assert.equal(ro.statusCode, 403, "readonly may not run bulk actions");

  // Disable both in one call.
  const dis = await post("/api/hosts/batch", admin, { ids: [a.id, b.id], action: "disable" });
  assert.equal(dis.statusCode, 200);
  assert.equal((dis.json() as { affected: number }).affected, 2, "both services affected");
  const after = await app.inject({ method: "GET", url: "/api/hosts", headers: { cookie: admin } });
  const rows = after.json() as Array<{ id: string; enabled: boolean }>;
  assert.equal(rows.find((h) => h.id === a.id)?.enabled, false, "a disabled");
  assert.equal(rows.find((h) => h.id === b.id)?.enabled, false, "b disabled");

  // Maintenance on for one, then delete both.
  const maint = await post("/api/hosts/batch", admin, { ids: [a.id], action: "maintenance-on" });
  assert.equal((maint.json() as { affected: number }).affected, 1);

  const del = await post("/api/hosts/batch", admin, { ids: [a.id, b.id], action: "delete" });
  assert.equal((del.json() as { affected: number }).affected, 2, "both deleted");
  const gone = await app.inject({ method: "GET", url: "/api/hosts", headers: { cookie: admin } });
  const remaining = gone.json() as Array<{ id: string }>;
  assert.ok(!remaining.some((h) => h.id === a.id || h.id === b.id), "both services removed");
});

// ---------------------------------------------------------------------------
// (15) Backup/restore bundle (feature 4.2): admin-only; an encrypted backup
// round-trips through the HTTP endpoints.
// ---------------------------------------------------------------------------
test("POST /api/config/backup + /restore round-trip an encrypted bundle (admin-only)", async () => {
  createHost(makeHost({ id: "bk1", name: "bk", domain: "bk-backup.example.com" }));
  const admin = cookieFor(makeUser("admin"));

  // Editors can't back up (full config dump).
  const editor = await post("/api/config/backup", cookieFor(makeUser("editor")), {});
  assert.equal(editor.statusCode, 403, "editor may not export a backup");

  // Encrypted backup.
  const bk = await post("/api/config/backup", admin, { passphrase: "backup-pass-123", includeSecrets: true });
  assert.equal(bk.statusCode, 200);
  const body = bk.json() as { encrypted: boolean; blob: { magic: string } };
  assert.equal(body.encrypted, true);
  assert.equal(body.blob.magic, "nginux-encrypted", "the payload is an encrypted envelope");

  // Restoring with the right passphrase succeeds.
  const good = await post("/api/config/restore", admin, { blob: body.blob, passphrase: "backup-pass-123" });
  assert.equal(good.statusCode, 200, "restore with the correct passphrase works");
  assert.ok((good.json() as { hosts: number }).hosts >= 1);

  // The wrong passphrase is a clean 400, not a crash.
  const bad = await post("/api/config/restore", admin, { blob: body.blob, passphrase: "nope" });
  assert.equal(bad.statusCode, 400, "wrong passphrase -> 400");
});

// ---------------------------------------------------------------------------
// (16) Security profiles (feature 4.4): create + apply a named security bundle
// to services, admin/editor only.
// ---------------------------------------------------------------------------
test("POST /api/security-profiles + apply sets the profile's fields on target hosts", async () => {
  const admin = cookieFor(makeUser("admin"));
  const svc = createHost(makeHost({ id: "prof-svc", name: "prof", domain: "prof.example.com", requireLogin: false, hsts: false }));

  // Readonly can't manage profiles.
  const ro = await app.inject({ method: "GET", url: "/api/security-profiles", headers: { cookie: cookieFor(makeUser("readonly")) } });
  assert.equal(ro.statusCode, 403);

  // Create a profile.
  const create = await post("/api/security-profiles", admin, { name: "Strict", fields: { requireLogin: true, hsts: true, blockExploits: true } });
  assert.equal(create.statusCode, 201);
  const profId = (create.json() as { id: string }).id;

  // Apply it to the service.
  const apply = await post(`/api/security-profiles/${profId}/apply`, admin, { ids: [svc.id] });
  assert.equal(apply.statusCode, 200);
  assert.equal((apply.json() as { affected: number }).affected, 1);

  // The host now has the profile's security fields.
  const after = await app.inject({ method: "GET", url: `/api/hosts/${svc.id}`, headers: { cookie: admin } });
  const host = after.json() as { requireLogin: boolean; hsts: boolean };
  assert.equal(host.requireLogin, true, "profile applied requireLogin");
  assert.equal(host.hsts, true, "profile applied hsts");
});

test("require2faForManagers leaves read-only/scoped users and enrolled managers alone", async () => {
  saveSettings({ require2faForManagers: true });
  // A readonly user is not a manager -> unaffected.
  const ro = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookieFor(makeUser("readonly")) } });
  assert.notEqual((ro.json() as { mustEnable2fa?: boolean }).mustEnable2fa, true, "read-only is exempt");

  // An admin who already has 2FA -> unaffected.
  const enrolledId = makeUser("admin");
  db.prepare("UPDATE users SET twofaEnabled = 1 WHERE id = ?").run(enrolledId);
  const enrolled = await app.inject({ method: "GET", url: "/api/hosts", headers: { cookie: cookieFor(enrolledId) } });
  assert.equal(enrolled.statusCode, 200, "an admin with 2FA already enrolled is unaffected");
  saveSettings({ require2faForManagers: false });
});
