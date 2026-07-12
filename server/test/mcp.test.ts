// MCP JSON-RPC handler (mcp.ts) RBAC + resource-gating regression tests.
//
// mcp.ts pulls in db.ts/repo.ts/auth.ts/certs.ts/metrics.ts/… which open the DB
// and read on-disk paths at import time, so it MUST be imported dynamically AFTER
// setupTestEnv() - otherwise it would touch the real dev DB and nginx tree.
//
// The invariants pinned here (audit fixes) all say the same thing: an MCP
// resource/tool is NOT an RBAC bypass. Every resources/read and tools/call is
// gated by the SAME (scope + adminOnly) rule as the equivalent REST/tool path:
//  - #4/#5  users://list is adminOnly: a report-scoped editor is refused; only an
//           admin gets the roster, and it isn't even advertised to a non-admin.
//  - #16    a scoped principal's topology reveals only the hosts it may see.
//  -        adminOnly tools (update_settings) refuse a non-admin USER; a control
//           tool refuses a token that lacks the 'control' scope; a report resource
//           refuses a bare 'read' token.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { setupTestEnv } from "./helpers.ts";
import { makeHost } from "./helpers.ts";
import type { Principal } from "../src/tools.ts"; // type-only: erased, no side effect

setupTestEnv();
const { handleMcp } = await import("../src/mcp.ts");
const { scopesForRole } = await import("../src/tools.ts");
const { createHost, getHostByDomain } = await import("../src/repo.ts");
const { createUser } = await import("../src/auth.ts");

// ---- principal builders (match the real Principal union from tools.ts) ----
type Role = "admin" | "editor" | "readonly" | "scoped";
function userPrincipal(role: Role, scope = ""): Principal {
  return {
    kind: "user",
    name: `${role}-user`,
    scopes: scopesForRole(role),
    user: {
      id: `u-${role}`, username: `${role}-user`, email: "x@example.com", role, scope,
      twofaEnabled: false, mustChangePassword: false,
      createdAt: "2026-01-01T00:00:00Z", lastLoginAt: null,
    },
  };
}
// A non-user (kind:"agent") token principal: only the scopes an admin granted it.
function tokenPrincipal(scopes: ("read" | "report" | "control" | "security")[]): Principal {
  return { kind: "agent", id: "tok1", name: "agent-token", scopes, trust: "trusted" };
}

const editor = userPrincipal("editor");
const admin = userPrincipal("admin");
const scoped = userPrincipal("scoped", "plex");
const readToken = tokenPrincipal(["read"]);

// A JSON-RPC request helper + typed accessor for the loosely-typed reply.
let seq = 0;
async function call(principal: Principal, method: string, params?: Record<string, unknown>) {
  const reply = await handleMcp(principal, { jsonrpc: "2.0", id: ++seq, method, params });
  return reply as any;
}
const isRpcError = (r: any) => r != null && "error" in r && !("result" in r);
const isRpcOk = (r: any) => r != null && "result" in r && !("error" in r);

before(async () => {
  // Seed a real user row so the admin's users://list roster is non-empty and its
  // presence/absence in a reply is an observable signal.
  await createUser({ username: "roster-admin", password: "pw-only-for-test", role: "admin" });
  // Two hosts for the scoped-topology case; UNIQUE(domain) makes re-seed a no-op.
  if (!getHostByDomain("plex.example.com")) createHost(makeHost({ name: "plex", domain: "plex.example.com", serverGroup: "media", serverIp: "10.0.0.10" }));
  if (!getHostByDomain("immich.example.com")) createHost(makeHost({ name: "immich", domain: "immich.example.com", serverGroup: "photos", serverIp: "10.0.0.11" }));
});

// ---------------------------------------------------------------------------
// 1. (#4/#5) users://list is adminOnly - a report-scoped EDITOR is refused,
//    an ADMIN gets the roster. If the editor ever gets the list, the adminOnly
//    gate on the resource read regressed.
// ---------------------------------------------------------------------------
test("#4/#5 resources/read users://list: editor refused, admin gets the roster", async () => {
  const editorRes = await call(editor, "resources/read", { uri: "users://list" });
  assert.ok(isRpcError(editorRes), "an editor (report scope, not admin) must be refused users://list");
  assert.equal("result" in editorRes, false, "the refusal must NOT carry the user roster");

  const adminRes = await call(admin, "resources/read", { uri: "users://list" });
  assert.ok(isRpcOk(adminRes), "an admin may read users://list");
  const text = adminRes.result.contents[0].text as string;
  assert.ok(text.includes("roster-admin"), "the admin roster must contain the seeded user");
});

// The adminOnly gate is specifically the block - the editor CAN read a plain
// 'report' resource, proving 'report' scope alone isn't what stops users://list.
test("editor may read a report-scoped resource (audit://recent) - only adminOnly blocks it", async () => {
  const res = await call(editor, "resources/read", { uri: "audit://recent" });
  assert.ok(isRpcOk(res), "an editor holds the 'report' scope and may read the audit log");
});

// ---------------------------------------------------------------------------
// 2. resources/list is pre-filtered by (scope + adminOnly): an admin-only
//    resource isn't even advertised to a non-admin.
// ---------------------------------------------------------------------------
test("resources/list hides users://list from the editor but shows it to an admin", async () => {
  const editorList = await call(editor, "resources/list");
  const editorUris = editorList.result.resources.map((r: any) => r.uri);
  assert.equal(editorUris.includes("users://list"), false, "adminOnly resource must not be advertised to a non-admin");
  assert.equal(editorUris.includes("hosts://list"), true, "the editor should still see read/report resources");

  const adminList = await call(admin, "resources/list");
  const adminUris = adminList.result.resources.map((r: any) => r.uri);
  assert.equal(adminUris.includes("users://list"), true, "an admin must see the adminOnly users resource");
});

// A bare 'read' token sees only 'read'-scoped resources, never 'report' ones.
test("resources/list for a read-only token exposes only read-scoped resources", async () => {
  const list = await call(readToken, "resources/list");
  const uris = list.result.resources.map((r: any) => r.uri);
  assert.equal(uris.includes("hosts://list"), true, "read resource is visible to a read token");
  assert.equal(uris.includes("audit://recent"), false, "a report resource must not be advertised to a read token");
  assert.equal(uris.includes("users://list"), false, "the adminOnly resource stays hidden from a token too");
});

// ---------------------------------------------------------------------------
// 3. (#16) topology://current is filtered to a scoped principal's hosts - one
//    NginUX login must not leak the whole network map.
// ---------------------------------------------------------------------------
test("#16 resources/read topology://current is scoped to the caller's hosts", async () => {
  const res = await call(scoped, "resources/read", { uri: "topology://current" });
  assert.ok(isRpcOk(res), "a scoped user holds 'read' and may read the topology");
  const text = res.result.contents[0].text as string;
  assert.ok(text.includes("plex"), "an in-scope service must appear in the scoped topology");
  assert.equal(text.includes("immich"), false, "an out-of-scope service must be absent from the scoped topology");

  // Sanity: an admin sees BOTH - so the absence above is scoping, not a seed miss.
  const full = await call(admin, "resources/read", { uri: "topology://current" });
  const fullText = full.result.contents[0].text as string;
  assert.ok(fullText.includes("plex") && fullText.includes("immich"), "an admin sees the full topology");
});

// ---------------------------------------------------------------------------
// 4. tools/call gating: an adminOnly tool refuses a non-admin USER; a control
//    tool refuses a token that lacks the 'control' scope.
// ---------------------------------------------------------------------------
test("tools/call update_settings (adminOnly) refuses a non-admin editor", async () => {
  const res = await call(editor, "tools/call", { name: "update_settings", arguments: { patch: {} } });
  // tools/call surfaces the refusal as an isError content block, not a JSON-RPC error.
  assert.ok(isRpcOk(res), "tools/call returns a result envelope even on refusal");
  assert.equal(res.result.isError, true, "update_settings must be refused for a non-admin");
  const text = res.result.content[0].text as string;
  assert.match(text, /admin/i, "the refusal explains an admin is required");

  // Positive control: an admin is allowed past the adminOnly gate (settings write
  // succeeds - nginx apply no-ops under NODE_ENV=test).
  const okRes = await call(admin, "tools/call", { name: "update_settings", arguments: { patch: { instanceName: "n" } } });
  assert.equal(okRes.result.isError, false, "an admin may run update_settings");
});

test("tools/call update_service (control) refuses a read-only token lacking the scope", async () => {
  const res = await call(readToken, "tools/call", { name: "update_service", arguments: { id: "whatever" } });
  assert.ok(isRpcOk(res), "tools/call returns a result envelope even on refusal");
  assert.equal(res.result.isError, true, "a read-only token must be refused a control tool");
  const text = res.result.content[0].text as string;
  assert.match(text, /control/i, "the refusal names the missing 'control' scope");
});

// tools/list is likewise pre-filtered: a read token is not even offered control tools.
test("tools/list for a read-only token omits control/adminOnly tools", async () => {
  const list = await call(readToken, "tools/list");
  const names = list.result.tools.map((t: any) => t.name);
  assert.equal(names.includes("list_services"), true, "a read tool is offered to a read token");
  assert.equal(names.includes("update_service"), false, "a control tool is not offered to a read token");
  assert.equal(names.includes("update_settings"), false, "an adminOnly tool is not offered to a read token");
});

// ---------------------------------------------------------------------------
// 5. A 'report'-scoped resource refuses a bare 'read' TOKEN.
// ---------------------------------------------------------------------------
test("resources/read audit://recent refuses a read-only token (lacks 'report')", async () => {
  const res = await call(readToken, "resources/read", { uri: "audit://recent" });
  assert.ok(isRpcError(res), "a read-only token must not read the report-scoped audit log");
  assert.equal("result" in res, false, "the refusal must not carry the audit contents");

  // …but the same token may read a 'read'-scoped resource (positive control).
  const okRes = await call(readToken, "resources/read", { uri: "hosts://list" });
  assert.ok(isRpcOk(okRes), "a read token may read a read-scoped resource");
});

// An unknown resource is a JSON-RPC -32602 error, distinct from a permission denial.
test("resources/read of an unknown uri is a -32602 error", async () => {
  const res = await call(admin, "resources/read", { uri: "nope://x" });
  assert.ok(isRpcError(res), "unknown resource must error");
  assert.equal(res.error.code, -32602);
});

// ---------------------------------------------------------------------------
// 6. Protocol sanity: initialize / tools/list / resources/list / ping /
//    notifications / unknown-method are all well-formed.
// ---------------------------------------------------------------------------
test("initialize returns a well-formed handshake", async () => {
  const res = await call(admin, "initialize");
  assert.ok(isRpcOk(res));
  assert.equal(res.result.serverInfo.name, "nginux");
  assert.equal(typeof res.result.protocolVersion, "string");
  for (const cap of ["tools", "resources", "prompts"]) assert.ok(cap in res.result.capabilities, `capability ${cap}`);
});

test("tools/list and resources/list return non-empty, well-formed lists for an admin", async () => {
  const tools = await call(admin, "tools/list");
  assert.ok(Array.isArray(tools.result.tools) && tools.result.tools.length > 0);
  for (const t of tools.result.tools) {
    assert.equal(typeof t.name, "string");
    assert.equal(typeof t.description, "string");
    assert.ok(t.inputSchema && typeof t.inputSchema === "object");
  }
  const resources = await call(admin, "resources/list");
  assert.ok(Array.isArray(resources.result.resources) && resources.result.resources.length > 0);
  for (const r of resources.result.resources) assert.equal(r.mimeType, "application/json");
});

test("prompts/list, ping, notifications, and unknown methods behave", async () => {
  const prompts = await call(admin, "prompts/list");
  assert.ok(Array.isArray(prompts.result.prompts) && prompts.result.prompts.length > 0);
  // The catalog carries argument schemas now (spec-compatible).
  for (const p of prompts.result.prompts) {
    assert.ok(typeof p.name === "string" && typeof p.description === "string");
    assert.ok(Array.isArray(p.arguments), "each prompt advertises its arguments");
  }

  const ping = await call(admin, "ping");
  assert.ok(isRpcOk(ping));

  // notifications get NO reply (null).
  const note = await handleMcp(admin, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(note, null);

  const unknown = await call(admin, "totally/unknown");
  assert.ok(isRpcError(unknown));
  assert.equal(unknown.error.code, -32601);
});

test("prompts/get renders messages, validates required args, and rejects unknown names", async () => {
  // A known prompt with its required arg renders a well-formed user message.
  const got = await call(admin, "prompts/get", { name: "expose_service", arguments: { service: "Grafana" } });
  assert.ok(isRpcOk(got), "prompts/get on a known prompt returns a result");
  assert.equal(typeof got.result.description, "string");
  assert.ok(Array.isArray(got.result.messages) && got.result.messages.length > 0, "messages are returned");
  const m = got.result.messages[0];
  assert.equal(m.role, "user");
  assert.equal(m.content.type, "text");
  assert.ok(m.content.text.includes("Grafana"), "the argument is templated into the message");

  // An arg-less prompt renders too.
  const weekly = await call(admin, "prompts/get", { name: "weekly_security_review" });
  assert.ok(isRpcOk(weekly) && weekly.result.messages.length > 0);

  // A missing REQUIRED argument is a -32602 invalid-params error.
  const missing = await call(admin, "prompts/get", { name: "expose_service", arguments: {} });
  assert.ok(isRpcError(missing));
  assert.equal(missing.error.code, -32602);
  assert.ok(/service/i.test(missing.error.message), "the error names the missing argument");

  // An unknown prompt name is -32602.
  const unknown = await call(admin, "prompts/get", { name: "no_such_prompt" });
  assert.ok(isRpcError(unknown));
  assert.equal(unknown.error.code, -32602);
});
