// Regression locks for the 2026-07-12 security-audit fixes. Each test pins a specific
// hardening so a future change that re-opens the hole fails loudly. Grouped by the
// finding it defends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTestEnv } from "./helpers.ts";

setupTestEnv();
const tools = await import("../src/tools.ts");
const { settingsInput } = await import("../src/settingsschema.ts");
const { createHost, getHostByDomain, getHostByDomainCached } = await import("../src/repo.ts");
const { generateHostConfig } = await import("../src/nginx.ts");
const { restoreBundle } = await import("../src/backup.ts");
const { makeHost } = await import("./helpers.ts");

// ---------- agent tool path (the recurring bypass class) ----------

test("sanitizeHostPatch strips transport/TLS fields (protocol, listenPort, ssl, preset)", () => {
  const out = tools.sanitizeHostPatch({ protocol: "sni", listenPort: 22, ssl: false, preset: "wordpress", forwardPort: 8080 });
  assert.equal("protocol" in out, false, "protocol must not pass the agent path (stream-passthrough bypass)");
  assert.equal("listenPort" in out, false);
  assert.equal("ssl" in out, false, "ssl:false HTTPS->plaintext downgrade must not pass the agent path");
  assert.equal("preset" in out, false);
  assert.equal(out.forwardPort, 8080, "a legitimate routing field still passes");
});

test("enable_login cannot LOWER require2fa (only raises protection)", async () => {
  const h = createHost(makeHost({ id: "h_2fa", domain: "vault2fa.example.com", requireLogin: true, require2fa: true }));
  const { getHost } = await import("../src/repo.ts");
  // enable_login({id}) with require2fa OMITTED must NOT strip an existing require2fa=true
  // (an auto-approvable control-scope agent stripping the second factor).
  await tools.TOOLS.enable_login.handler({ id: h.id });
  assert.equal(getHost(h.id)?.require2fa, true, "omitting require2fa must NOT strip require2fa=true");
  // It still RAISES: on a host without 2FA, enable_login({id, require2fa:true}) turns it on.
  const h2 = createHost(makeHost({ id: "h_no2fa", domain: "plain.example.com", requireLogin: false, require2fa: false }));
  await tools.TOOLS.enable_login.handler({ id: h2.id, require2fa: true });
  assert.equal(getHost(h2.id)?.require2fa, true);
});

test("canCallTool: adminOnly denies a low-scope token, allows a security token / admin user", () => {
  const reportTok = { kind: "token" as const, scopes: ["read", "report"] as const };
  const securityTok = { kind: "token" as const, scopes: ["read", "report", "control", "security"] as const };
  const adminUser = { kind: "user" as const, scopes: ["read", "report", "control", "security"] as const, user: { role: "admin" } };
  const editorUser = { kind: "user" as const, scopes: ["read", "report", "control", "security"] as const, user: { role: "editor" } };
  const listUsers = { scope: "report" as const, adminOnly: true };
  assert.equal(tools.canCallTool(reportTok as never, listUsers), false, "a report token must NOT reach an adminOnly tool (user-roster leak)");
  assert.equal(tools.canCallTool(securityTok as never, listUsers), true, "a security-scope token may (top trust)");
  assert.equal(tools.canCallTool(adminUser as never, listUsers), true);
  assert.equal(tools.canCallTool(editorUser as never, listUsers), false, "an editor user is not admin");
});

test("callTool (the INVOCATION gate, not just listing) denies a report token an adminOnly tool", async () => {
  const reportTok = { kind: "token", name: "probe", scopes: ["read", "report"] } as never;
  const r = await tools.callTool(reportTok, "list_users", {});
  assert.equal((r as { status: string }).status, "error", "report token must be denied at INVOCATION (list_users roster leak)");
  const securityTok = { kind: "token", name: "sec", scopes: ["read", "report", "control", "security"] } as never;
  const ok = await tools.callTool(securityTok, "list_users", {});
  assert.notEqual((ok as { status: string }).status, "error", "a security-scope token may still invoke it");
});

// ---------- forward-auth host resolution (the under-auth fail-open class) ----------

test("host lookup is case-insensitive and wildcard-aware for forward-auth", () => {
  createHost(makeHost({ id: "h_case", name: "Vault", domain: "Vault.Home.Lan", requireLogin: true, require2fa: true }));
  createHost(makeHost({ id: "h_wild", name: "Apps", domain: "*.apps.example.com", requireLogin: true }));
  // nginx stamps a lowercased, concrete $host; the gate must still resolve the policy.
  assert.ok(getHostByDomainCached("vault.home.lan"), "case-mismatched domain must resolve (was fail-open)");
  assert.equal(getHostByDomainCached("vault.home.lan")?.require2fa, true);
  assert.ok(getHostByDomainCached("grafana.apps.example.com"), "a subdomain must resolve to its *.parent host");
  // Duplicate detection stays EXACT (a specific host can coexist under a wildcard).
  assert.equal(getHostByDomain("grafana.apps.example.com"), null, "wildcard fallback must NOT leak into exact dup detection");
});

// ---------- nginx data-plane: bans immune to allow/deny non-inheritance ----------

test("every generated server block enforces the global ban variable", () => {
  const conf = generateHostConfig(makeHost({ domain: "svc.example.com", ipAllow: "203.0.113.0/24" }));
  assert.match(conf, /if \(\$nginux_banned\) \{ return 403; \}/, "server block must check $nginux_banned even with ipAllow set");
});

// ---------- settings sinks (nginx directive injection via PUT /api/settings or restore) ----------

test("settingsInput rejects an ssoForwardSecret / ssoLoginUrl that could break out of an nginx directive", () => {
  assert.equal(settingsInput.safeParse({ ssoForwardSecret: 'x";\n return 200;\n #' }).success, false, "forward secret with quotes/;/newline must be rejected");
  assert.equal(settingsInput.safeParse({ ssoForwardSecret: "abc123DEF-_." }).success, true, "a normal hex-ish secret is accepted");
  assert.equal(settingsInput.safeParse({ ssoLoginUrl: 'https://ok.com" ; return 200; #' }).success, false, "unanchored URL injection must be rejected");
  assert.equal(settingsInput.safeParse({ ssoLoginUrl: "https://nginux.example.com" }).success, true);
});

// ---------- backup restore parity (untrusted portable bundle) ----------

function bundle(over: Record<string, unknown> = {}) {
  return { magic: "nginux-backup", schema: 1, hosts: [], settings: {}, bans: [], channels: [], ...over };
}

test("restore rejects a bundle that injects into ssoForwardSecret", () => {
  assert.throws(() => restoreBundle(bundle({ settings: { ssoForwardSecret: 'x";\n return 200;\n #' } })), /Invalid backup bundle/i);
});

test("restore rejects a bundle whose ban IP isn't a valid IP/CIDR (deny-list injection)", () => {
  assert.throws(() => restoreBundle(bundle({ bans: [{ ip: "all;\n return 444", reason: "x", source: "manual" }] })), /Invalid backup bundle|IP or CIDR/i);
});
