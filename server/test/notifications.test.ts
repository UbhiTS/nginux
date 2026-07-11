// Notification-banner logic (src/notifications.ts): which plain-language heads-up
// notices are surfaced, and to whom. Manager (admin/editor) callers unlock the
// operational/security notices; everyone sees service-reachability problems.
// NOTE: the data-plane liveness check is production-only, and NODE_ENV is "test"
// here (set by setupTestEnv), so no 'dataplane-down' / 'port-forward-reminder'
// notices are ever produced below.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupTestEnv, makeHost } from "./helpers.ts";

const env = setupTestEnv();
const { buildNotifications } = await import("../src/notifications.ts");
const { createHost, replaceAllHosts } = await import("../src/repo.ts");
const { saveSettings, db } = await import("../src/db.ts");

// Give a host's cert store row an explicit expiry so the cert-expiring branch can
// be exercised deterministically (buildNotifications derives daysRemaining from
// notAfter, not from the stored status).
function seedCert(domain: string, notAfter: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO certificates (domain, status, issuer, method, notBefore, notAfter, sans, wildcard, autoRenew, updatedAt)
     VALUES (?,?,?,?,?,?,?,0,1,?)`,
  ).run(domain, "valid", "Let's Encrypt", "http-01", now, notAfter, JSON.stringify([domain]), now);
}
const daysOut = (n: number) => new Date(Date.now() + n * 86400_000).toISOString();

// The DB is a single file shared across tests in this process, so wipe the host +
// cert state and reset the login-gate settings before each case for isolation.
beforeEach(() => {
  replaceAllHosts([]);
  db.prepare("DELETE FROM certificates").run();
  saveSettings({ ssoLoginUrl: "", ssoForwardSecret: "" });
});

// 1. SSL host with no real cert on disk → temporary/self-signed cert warning.
test("manager sees a temporary-certificate warning for an SSL host with no real cert on disk", async () => {
  createHost(makeHost({ domain: "a.example.com", ssl: true, protocol: "http", requireLogin: false }));

  const notes = await buildNotifications({ isManager: true });
  const cert = notes.find((n) => n.id.startsWith("bootstrap-cert:"));

  assert.ok(cert, "expected a bootstrap-cert notice");
  assert.equal(cert!.severity, "warning");
  assert.match(cert!.title, /temporary certificate/);
  assert.match(cert!.message, /self-signed/);
  assert.equal(cert!.dismissible, true);
});

// The negative of case 1: a real fullchain.pem on disk suppresses the warning.
test("an SSL host WITH a real fullchain.pem on disk does not warn about a temporary cert", async () => {
  const domain = "real.example.com";
  const certPath = join(env.dir, "certs", domain); // CERT_DIR == <tmp>/certs
  mkdirSync(certPath, { recursive: true });
  writeFileSync(join(certPath, "fullchain.pem"), "-----BEGIN CERTIFICATE-----\n");
  createHost(makeHost({ domain, ssl: true, protocol: "http", requireLogin: false }));

  const notes = await buildNotifications({ isManager: true });
  assert.equal(notes.find((n) => n.id.startsWith("bootstrap-cert:")), undefined);
});

// 2. Login-gated host but no sign-in URL → visitors would get a bare 401.
test("manager sees a 'no sign-in URL' warning for a login-gated host when ssoLoginUrl is empty", async () => {
  createHost(makeHost({ domain: "b.example.com", ssl: false, requireLogin: true }));

  const notes = await buildNotifications({ isManager: true });
  const sso = notes.find((n) => n.id === "sso-login-url-missing");

  assert.ok(sso, "expected an sso-login-url-missing notice");
  assert.equal(sso!.severity, "warning");
  assert.match(sso!.title, /sign anyone in/);
  assert.equal(sso!.dismissible, true);
});

// A configured sign-in URL + forward secret clears both login-gate warnings.
test("configuring ssoLoginUrl and a forward secret clears the login-gate warnings", async () => {
  saveSettings({ ssoLoginUrl: "https://auth.example.com/login", ssoForwardSecret: "s3cret" });
  createHost(makeHost({ domain: "e.example.com", ssl: false, requireLogin: true }));

  const notes = await buildNotifications({ isManager: true });
  assert.equal(notes.find((n) => n.id === "sso-login-url-missing"), undefined);
  assert.equal(notes.find((n) => n.id === "forward-secret-missing"), undefined);
});

// A sign-in URL but no forward secret → the weaker-gate warning fires alone.
test("login-gated host with a sign-in URL but no forward secret warns about the weak gate", async () => {
  saveSettings({ ssoLoginUrl: "https://auth.example.com/login", ssoForwardSecret: "" });
  createHost(makeHost({ domain: "f.example.com", ssl: false, requireLogin: true }));

  const notes = await buildNotifications({ isManager: true });
  assert.equal(notes.find((n) => n.id === "sso-login-url-missing"), undefined);
  const fs = notes.find((n) => n.id === "forward-secret-missing");
  assert.ok(fs, "expected a forward-secret-missing notice");
  assert.match(fs!.title, /isn't fully secured/);
});

// A cert under 14 days from expiry → warning-level cert-expiring notice.
test("a certificate under 14 days from expiry produces a warning-level cert-expiring notice", async () => {
  createHost(makeHost({ domain: "g.example.com", name: "Gee", ssl: false }));
  seedCert("g.example.com", daysOut(5));

  const notes = await buildNotifications({ isManager: true });
  const exp = notes.find((n) => n.id.startsWith("cert-expiring:"));

  assert.ok(exp, "expected a cert-expiring notice");
  assert.equal(exp!.severity, "warning");
  assert.match(exp!.title, /expiring soon/);
});

// An already-expired cert escalates the same notice to critical.
test("an already-expired certificate produces a critical cert-expiring notice", async () => {
  createHost(makeHost({ domain: "h.example.com", name: "Aitch", ssl: false }));
  seedCert("h.example.com", daysOut(-2));

  const notes = await buildNotifications({ isManager: true });
  const exp = notes.find((n) => n.id.startsWith("cert-expiring:"));

  assert.ok(exp, "expected a cert-expiring notice");
  assert.equal(exp!.severity, "critical");
  assert.match(exp!.title, /expired/);
});

// 3. Non-manager sees ONLY service-reachability notices; every manager-only notice
//    is withheld even when the host trips all of their conditions.
test("a non-manager never sees manager-only notices, only service-reachability ones", async () => {
  // Trips temp-cert (ssl+http, no cert on disk), sso + forward-secret (login-gated),
  // and cert-expiring (near-expiry cert) - all manager-only.
  createHost(makeHost({ domain: "c.example.com", name: "Cee", ssl: true, protocol: "http", requireLogin: true, health: "online" }));
  seedCert("c.example.com", daysOut(3));
  // A down host so there IS a reachability notice a non-manager should still see.
  createHost(makeHost({ domain: "d.example.com", name: "Downer", ssl: false, health: "down" }));

  const notes = await buildNotifications({ isManager: false });

  // Manager-only notices are absent.
  assert.equal(notes.find((n) => n.id.startsWith("bootstrap-cert:")), undefined);
  assert.equal(notes.find((n) => n.id === "sso-login-url-missing"), undefined);
  assert.equal(notes.find((n) => n.id === "forward-secret-missing"), undefined);
  assert.equal(notes.find((n) => n.id.startsWith("cert-expiring:")), undefined);

  // But the reachability notice is visible.
  const svc = notes.find((n) => n.id.startsWith("services-down:"));
  assert.ok(svc, "non-manager should still see a services-down notice");
  assert.match(svc!.title, /Can't reach/);
});

// 4. Clean state (no hosts) → no false-positive cert/sso warnings for a manager.
test("clean state with no hosts yields no false-positive cert/sso warnings for a manager", async () => {
  const notes = await buildNotifications({ isManager: true });

  assert.equal(notes.find((n) => n.id.startsWith("bootstrap-cert:")), undefined);
  assert.equal(notes.find((n) => n.id === "sso-login-url-missing"), undefined);
  assert.equal(notes.find((n) => n.id === "forward-secret-missing"), undefined);
  assert.equal(notes.find((n) => n.id.startsWith("cert-expiring:")), undefined);
  // Nothing at all in the test env (data-plane checks are production-only).
  assert.deepEqual(notes, []);
});
