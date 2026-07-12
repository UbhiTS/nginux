// Shared host-write validation (server/src/hostschema.ts).
//
// The whole point of this module is that the REST boundary (`hostInput`) and the
// agent/MCP path (`sanitizeHostPatch`, which now runs through `hostInput.partial()`)
// validate IDENTICALLY, so a field rule can never again be looser on one path than
// the other (audit findings 1.1 + 1.3). These tests pin that parity, the
// previously-missing agent-path bounds, and the no-default-injection invariant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTestEnv } from "./helpers.ts";

setupTestEnv();
const { hostInput, isControlPlaneDomain } = await import("../src/hostschema.ts");
const { sanitizeHostPatch } = await import("../src/tools.ts");
const { saveSettings } = await import("../src/db.ts");

// REST accepts iff zod parse succeeds; agent accepts iff sanitizeHostPatch doesn't throw.
const restAccepts = (patch: Record<string, unknown>) => hostInput.partial().safeParse(patch).success;
const agentAccepts = (patch: Record<string, unknown>) => {
  try { sanitizeHostPatch(patch); return true; } catch { return false; }
};

// -------------------------------------------------------------------------
// 1. PARITY: the REST and agent paths agree on every non-forbidden field.
//    (Forbidden fields are excluded - the agent path deliberately STRIPS those,
//    which is asymmetry-by-design, tested separately below.)
// -------------------------------------------------------------------------
const VALID_PATCHES: Record<string, unknown>[] = [
  { name: "My App" },
  { forwardHost: "192.168.1.5", forwardPort: 8080, forwardScheme: "https" },
  { customHeaders: "X-Foo: bar" },
  { pathRules: "/api 10.0.0.1:3000" },
  { upstreams: "10.0.0.2:8080" },
  { certDomain: "app.example.com" },
  { iconUrl: "https://cdn.jsdelivr.net/gh/x/y.png" },
  { rateLimitRps: 50 },
  { serverIp: "192.168.1.9" },
  { preset: "custom", websockets: true, http2: false },
];
const INVALID_PATCHES: Record<string, unknown>[] = [
  { name: "a;b{}" },                       // nginx metachars in name
  { forwardHost: "1.2.3.4; return 403" },   // directive injection via proxy_pass host
  { forwardScheme: "ftp" },                 // off-enum scheme
  { forwardPort: 70000 },                   // out of range (agent path used to miss this)
  { forwardPort: 0 },                       // out of range
  { customHeaders: "X-Foo: a\nevil" },      // second line has no header name
  { pathRules: "/a 1.2.3.4:80 extra" },     // trailing junk after host:port
  { certDomain: "../etc" },                 // traversal into the cert dir
  { upstreams: "not-a-hostport" },          // not a host:port
  { iconUrl: "javascript:alert(1)" },       // non-CDN, non-data icon URL
  { rateLimitRps: 999999 },                 // above the cap
];

test("REST and agent paths ACCEPT the same valid patches (no drift)", () => {
  for (const p of VALID_PATCHES) {
    assert.equal(restAccepts(p), true, `REST should accept ${JSON.stringify(p)}`);
    assert.equal(agentAccepts(p), true, `agent should accept ${JSON.stringify(p)}`);
  }
});

test("REST and agent paths REJECT the same invalid patches (no drift)", () => {
  for (const p of INVALID_PATCHES) {
    assert.equal(restAccepts(p), false, `REST should reject ${JSON.stringify(p)}`);
    assert.equal(agentAccepts(p), false, `agent should reject ${JSON.stringify(p)}`);
    // The invariant that matters: the two paths reach the SAME verdict.
    assert.equal(restAccepts(p), agentAccepts(p), `paths disagree on ${JSON.stringify(p)}`);
  }
});

// -------------------------------------------------------------------------
// 2. The agent path now enforces bounds it previously MISSED (the drift the
//    audit flagged): out-of-range ports, numeric caps, and iconUrl.
// -------------------------------------------------------------------------
test("agent path now rejects an out-of-range forwardPort (previously silently accepted)", () => {
  assert.throws(() => sanitizeHostPatch({ forwardPort: 70000 }), /forward|port|number|less|greater|expected/i);
  assert.throws(() => sanitizeHostPatch({ forwardPort: -1 }));
});

test("agent path now validates iconUrl (only a pinned CDN or an uploaded image)", () => {
  assert.throws(() => sanitizeHostPatch({ iconUrl: "javascript:alert(1)" }));
  assert.doesNotThrow(() => sanitizeHostPatch({ iconUrl: "https://cdn.jsdelivr.net/gh/a/b.svg" }));
  assert.doesNotThrow(() => sanitizeHostPatch({ iconUrl: "" }));
});

// -------------------------------------------------------------------------
// 3. Forbidden fields are STILL stripped (security posture stays agent-proof)
//    and the stripping happens even when the value is otherwise "valid".
// -------------------------------------------------------------------------
test("agent path strips security-posture fields even when the value is valid", () => {
  const out = sanitizeHostPatch({ requireLogin: false, mtls: false, ipAllow: "1.2.3.4", name: "ok", forwardPort: 3000 });
  assert.equal("requireLogin" in out, false, "requireLogin must be stripped, not honoured");
  assert.equal("mtls" in out, false, "mtls must be stripped");
  assert.equal("ipAllow" in out, false, "ipAllow must be stripped");
  assert.equal(out.name, "ok", "a legitimate field survives");
  assert.equal(out.forwardPort, 3000, "a legitimate field survives");
});

// -------------------------------------------------------------------------
// 4. INVARIANT: partial validation must NOT inject schema defaults. If it did,
//    an agent PATCH of one field would carry defaults for every other field and
//    overwrite the existing host on update. (Pins the zod behaviour we rely on.)
// -------------------------------------------------------------------------
test("sanitizeHostPatch returns ONLY the fields that were sent (no default injection)", () => {
  const out = sanitizeHostPatch({ forwardPort: 8080 });
  assert.deepEqual(Object.keys(out), ["forwardPort"], "a one-field patch must stay one field");
  assert.deepEqual(sanitizeHostPatch({}), {}, "an empty patch must stay empty (no defaults)");
});

// -------------------------------------------------------------------------
// 5. The control-plane hijack guard is the single shared implementation.
// -------------------------------------------------------------------------
test("isControlPlaneDomain flags a portal-domain host pointed off :6767, allows :6767", () => {
  saveSettings({ ssoLoginUrl: "https://portal.example.com" });
  assert.equal(isControlPlaneDomain("portal.example.com", 8080), true, "off the control plane -> hijack");
  assert.equal(isControlPlaneDomain("portal.example.com", 6767), false, "forwarding TO the control plane is allowed");
  assert.equal(isControlPlaneDomain("other.example.com", 8080), false, "a different domain is unaffected");
  saveSettings({ ssoLoginUrl: "" });
  assert.equal(isControlPlaneDomain("portal.example.com", 8080), false, "no SSO URL configured -> nothing to protect");
});
