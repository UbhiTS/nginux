// RBAC + agent-path injection boundary for the MCP tool layer (tools.ts).
//
// tools.ts opens the DB and reads on-disk paths at import time (via db.ts,
// repo.ts, nginx.ts, geoip.ts, certs.ts, metrics.ts, …), so it MUST be imported
// dynamically AFTER setupTestEnv() or it would read the real dev DB.
//
// The security invariants pinned here:
//  - scopesForRole mirrors REST RBAC (readonly/scoped are read-only via MCP).
//  - canCallTool blocks a non-admin USER from adminOnly tools, but a scoped
//    TOKEN that was deliberately granted the scope passes (intended asymmetry).
//  - sanitizeHostPatch strips DB-managed + security-posture fields and rejects
//    nginx-directive injection - the agent path is not a privilege bypass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTestEnv } from "./helpers.ts";

setupTestEnv();
const { sanitizeHostPatch, canCallTool, scopesForRole, needsApproval } = await import("../src/tools.ts");
const { saveSettings } = await import("../src/db.ts");

// ---- principal builders (match the real Principal shape from tools.ts) ----
type Role = "admin" | "editor" | "readonly" | "scoped";
function userPrincipal(role: Role) {
  return {
    kind: "user" as const,
    name: `${role}-user`,
    scopes: scopesForRole(role),
    user: {
      id: "u1", username: `${role}-user`, email: "x@example.com", role,
      scope: "", twofaEnabled: false, mustChangePassword: false,
      createdAt: "2026-01-01T00:00:00Z", lastLoginAt: null,
    },
  };
}
function tokenPrincipal(scopes: ("read" | "report" | "control" | "security")[], trust: "trusted" | "untrusted" = "trusted") {
  return { kind: "agent" as const, id: "tok1", name: "agent-token", scopes, trust };
}

// -------------------------------------------------------------------------
// 1. scopesForRole mirrors the REST RBAC.
// -------------------------------------------------------------------------
test("scopesForRole: admin + editor get the full scope set", () => {
  assert.deepEqual(scopesForRole("admin"), ["read", "report", "control", "security"]);
  assert.deepEqual(scopesForRole("editor"), ["read", "report", "control", "security"]);
});
test("scopesForRole: readonly + scoped are read-only via MCP", () => {
  assert.deepEqual(scopesForRole("readonly"), ["read"]);
  assert.deepEqual(scopesForRole("scoped"), ["read"]);
});

// -------------------------------------------------------------------------
// 2. canCallTool - scope gating + adminOnly asymmetry.
// -------------------------------------------------------------------------
test("canCallTool: readonly user is blocked from control, allowed for read", () => {
  const readonly = userPrincipal("readonly");
  assert.equal(canCallTool(readonly, { scope: "control" }), false);
  assert.equal(canCallTool(readonly, { scope: "read" }), true);
});

test("canCallTool: a non-admin (editor) USER is blocked from adminOnly tools", () => {
  const editor = userPrincipal("editor");
  // editor holds the security scope, so only adminOnly stops them.
  assert.equal(editor.scopes.includes("security"), true);
  assert.equal(canCallTool(editor, { scope: "security", adminOnly: true }), false);
});

test("canCallTool: an admin USER may run adminOnly tools", () => {
  const admin = userPrincipal("admin");
  assert.equal(canCallTool(admin, { scope: "security", adminOnly: true }), true);
});

test("canCallTool: a scoped TOKEN passes adminOnly (deliberate grant - intended asymmetry)", () => {
  // adminOnly gates non-admin *users*; a token only ever has scopes an admin
  // explicitly granted it, so holding the scope is sufficient.
  const token = tokenPrincipal(["security"]);
  assert.equal(canCallTool(token, { scope: "security", adminOnly: true }), true);
  // …but a token still needs the scope: no "security" scope -> blocked.
  assert.equal(canCallTool(tokenPrincipal(["read"]), { scope: "security", adminOnly: true }), false);
});

// -------------------------------------------------------------------------
// 3. REGRESSION: sanitizeHostPatch strips DB-managed + security-posture fields.
// -------------------------------------------------------------------------
test("sanitizeHostPatch strips every forbidden field but keeps allowed ones", () => {
  const out = sanitizeHostPatch({
    customNginx: "x", requireLogin: false, ipAllow: "1.2.3.4", mtls: true,
    countryLock: true, id: "z", domain: "evil.com", health: "down", name: "ok",
  });
  for (const forbidden of ["customNginx", "requireLogin", "ipAllow", "mtls", "countryLock", "id", "domain", "health"]) {
    assert.equal(forbidden in out, false, `must strip ${forbidden}`);
  }
  assert.equal(out.name, "ok");
});

// -------------------------------------------------------------------------
// 4. REGRESSION: sanitizeHostPatch rejects injection-prone input.
// -------------------------------------------------------------------------
test("sanitizeHostPatch throws on nginx-directive / traversal injection", () => {
  const bad: Record<string, unknown>[] = [
    { name: "a;b{}" },                          // metachars in name
    { forwardHost: "1.2.3.4; return 403" },      // directive injection via proxy_pass host
    { forwardScheme: "ftp" },                    // off-enum scheme
    { customHeaders: "X-Foo: a\nb" },            // newline breaks out of the header
    { pathRules: "/a 1.2.3.4:80 extra" },        // trailing junk after host:port
    { certDomain: "../etc" },                    // path traversal into cert dir
    { upstreams: "not-a-hostport" },             // not a host:port
  ];
  for (const patch of bad) {
    assert.throws(() => sanitizeHostPatch(patch), Error, JSON.stringify(patch));
  }
});

// -------------------------------------------------------------------------
// 5. sanitizeHostPatch lets a fully-valid patch through unchanged.
// -------------------------------------------------------------------------
test("sanitizeHostPatch passes a valid patch through", () => {
  const out = sanitizeHostPatch({
    name: "My App", forwardHost: "192.168.1.5", forwardScheme: "https",
    forwardPort: 8080, customHeaders: "X-Foo: bar", pathRules: "/api 10.0.0.1:3000",
  });
  assert.equal(out.name, "My App");
  assert.equal(out.forwardHost, "192.168.1.5");
  assert.equal(out.forwardScheme, "https");
  assert.equal(out.forwardPort, 8080);
  assert.equal(out.customHeaders, "X-Foo: bar");
  assert.equal(out.pathRules, "/api 10.0.0.1:3000");
});

// -------------------------------------------------------------------------
// 6. needsApproval - the agent auto-approval gate (coverage gap).
// PINNED SECURITY INVARIANT: a destructive (high-tier) tool ALWAYS needs a human;
// an UNTRUSTED agent always needs approval for a write; auto-approve only ever
// spares a TRUSTED agent from low/medium writes, and only when the admin opted in.
// -------------------------------------------------------------------------
test("needsApproval: read-tier never needs approval, for anyone", () => {
  assert.equal(needsApproval("read", userPrincipal("readonly")), false);
  assert.equal(needsApproval("read", tokenPrincipal(["read"], "untrusted")), false);
});

test("needsApproval: a human user is their own approver (no gate)", () => {
  assert.equal(needsApproval("high", userPrincipal("admin")), false);
  assert.equal(needsApproval("medium", userPrincipal("editor")), false);
});

test("needsApproval: high (destructive) tier ALWAYS gates an agent, even trusted + policy on", () => {
  saveSettings({ agentAutoApprove: true });
  assert.equal(needsApproval("high", tokenPrincipal(["control"], "trusted")), true, "destructive must never auto-run");
});

test("needsApproval: with auto-approve OFF, every agent write needs approval", () => {
  saveSettings({ agentAutoApprove: false });
  assert.equal(needsApproval("low", tokenPrincipal(["control"], "trusted")), true);
  assert.equal(needsApproval("medium", tokenPrincipal(["control"], "trusted")), true);
});

test("needsApproval: with auto-approve ON, only a TRUSTED agent skips low/medium", () => {
  saveSettings({ agentAutoApprove: true });
  assert.equal(needsApproval("low", tokenPrincipal(["control"], "trusted")), false, "trusted + policy on -> auto-run low");
  assert.equal(needsApproval("medium", tokenPrincipal(["control"], "trusted")), false, "trusted + policy on -> auto-run medium");
  assert.equal(needsApproval("low", tokenPrincipal(["control"], "untrusted")), true, "untrusted always needs approval");
  saveSettings({ agentAutoApprove: false }); // restore default for any later test
});
