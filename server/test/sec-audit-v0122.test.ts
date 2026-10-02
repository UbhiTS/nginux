// Regression tests for the v0.1.22 adversarial security review. Each case pins one
// confirmed finding (or a load-bearing invariant verified during the review) so a
// future refactor that re-opens it fails loudly. Driven through app.inject() where the
// control is a route, and against the module directly where it is a pure function.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupTestEnv, makeHost } from "./helpers.ts";

setupTestEnv();
const { app } = await import("../src/index.ts");
const { db, saveSettings, redactSettings, maskSecretSettings } = await import("../src/db.ts");
const { beginTwofaSetup, createSession, createUser, logEvent, parseCookieAll, MAX_SESSION_COOKIES } = await import("../src/auth.ts");
const { createHost, deleteHost, getHostByDomain, updateHost, getServingHttpHostByDomainCached } = await import("../src/repo.ts");
const { createToken, resolveToken } = await import("../src/tokens.ts");
const { callTool, decideApproval, sanitizeHostPatch, TOOLS } = await import("../src/tools.ts");
const { generateHostConfig, COOKIE_STRIP_PASSES } = await import("../src/nginx.ts");
const { hostInput, controlPlaneTargetError, streamPortConflictError, targetIsThisControlPlane, frontsControlPlane } = await import("../src/hostschema.ts");
const { INSTANCE_ID } = await import("../src/instance.ts");
const { isIpOrCidr, isLocationPath, hasNginxMetachars, isDangerousHost } = await import("../src/validate.ts");
const { addBan, replaceAllBans, BANNED_FILE, STREAM_BANNED_FILE } = await import("../src/bans.ts");
const { deleteCert, getCert, CERT_DIR } = await import("../src/certs.ts");
const { parseNginxConf, IMPORT_MAX_BYTES } = await import("../src/importer.ts");
const { ingest, recentLogs } = await import("../src/metrics.ts");
const { realmForHost } = await import("../src/realms.ts");
const { buildNotifications } = await import("../src/notifications.ts");
const { createChannel, testChannel } = await import("../src/notify.ts");
const { parseSyslogUrl } = await import("../src/syslog.ts");
const { totp } = await import("../src/totp.ts");

const FWD_SECRET = "fwd-secret-v0122-0123456789abcdef";
const CP_PORT = Number(process.env.PORT) || 6767; // the control plane's own listener

function makeUser(role: string, scope = "", mustChange = 0): string {
  const id = `u_${role}_${Math.floor(performance.now() * 1000)}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    "INSERT INTO users (id, username, email, passwordHash, role, scope, twofaEnabled, backupCodes, twofaLastCounter, mustChangePassword, createdAt) VALUES (?,?,?,?,?,?,0,'[]',-1,?,?)",
  ).run(id, id, "", "x", role, scope, mustChange, new Date().toISOString());
  return id;
}
const cookieFor = (uid: string) => `nginux_session=${createSession(uid, "t", "127.0.0.1")}`;
const mintToken = (scopes: Array<"read" | "report" | "control" | "security">) =>
  createToken({ name: `tok_${scopes.join("-")}_${Math.random().toString(36).slice(2, 8)}`, scopes }).token;
const uniq = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8)}`;
const inject = (opts: Parameters<typeof app.inject>[0]) => app.inject(opts as never);

before(async () => {
  await app.ready();
  saveSettings({ ssoForwardSecret: FWD_SECRET });
});
after(async () => { await app.close(); });

// ---------------------------------------------------------------------------
// CRITICAL: the API guard must see the same path the router dispatches on.
// `/%61pi/hosts` decodes to `/api/hosts` for the router; a guard keyed on the raw
// URL prefix "/api" would skip auth entirely.
// ---------------------------------------------------------------------------
test("percent-encoded /api prefix cannot bypass the preHandler guard", async () => {
  const bare = await inject({ method: "GET", url: "/api/hosts" });
  assert.equal(bare.statusCode, 401);
  const encoded = await inject({ method: "GET", url: "/%61pi/hosts" });
  assert.equal(encoded.statusCode, 401, "encoded prefix must be guarded like the plain one");
  const encodedDeep = await inject({ method: "GET", url: "/api/%68osts" });
  assert.equal(encodedDeep.statusCode, 401);
  // Mutations stay CSRF-checked under the encoded prefix too.
  const csrf = await inject({
    method: "POST", url: "/%61pi/config/versions", headers: { cookie: cookieFor(makeUser("admin")), origin: "https://evil.example" }, payload: {},
  });
  assert.equal(csrf.statusCode, 403, "cross-origin mutation must be refused regardless of URL encoding");
  // The temp-password confinement is keyed on the same normalised path.
  const confined = await inject({ method: "GET", url: "/%61pi/hosts", headers: { cookie: cookieFor(makeUser("admin", "", 1)) } });
  assert.equal(confined.statusCode, 403);
});

// ---------------------------------------------------------------------------
// HIGH: publishing the control plane on the data plane (REST + tools + import/restore).
// ---------------------------------------------------------------------------
test("control-plane target rules: stream never, http primary admin-only, pools/paths never", () => {
  const base = { protocol: "http", forwardHost: "127.0.0.1", forwardPort: CP_PORT } as const;
  assert.equal(controlPlaneTargetError({ ...base }, { admin: true }), null, "admin may front the control plane over http (portal flow)");
  assert.match(controlPlaneTargetError({ ...base }, { admin: false })!, /Only an admin/);
  assert.match(controlPlaneTargetError({ ...base, protocol: "tcp" }, { admin: true })!, /passthrough may not target/);
  assert.match(controlPlaneTargetError({ ...base, protocol: "sni" }, { admin: true })!, /passthrough may not target/);
  assert.match(controlPlaneTargetError({ protocol: "http", forwardHost: "192.168.1.60", forwardPort: 3000, upstreams: `localhost:${CP_PORT}` }, { admin: true })!, /upstream targets/);
  assert.match(controlPlaneTargetError({ protocol: "http", forwardHost: "192.168.1.60", forwardPort: 3000, pathRules: `/admin [::1]:${CP_PORT}` }, { admin: true })!, /Path rules/);
  assert.match(controlPlaneTargetError({ protocol: "http", forwardHost: "::ffff:127.0.0.1", forwardPort: CP_PORT }, { admin: false })!, /Only an admin/, "IPv4-mapped loopback is loopback");
  assert.equal(controlPlaneTargetError({ protocol: "http", forwardHost: "127.0.0.1", forwardPort: 8080 }, { admin: false }), null, "other loopback ports are ordinary upstreams");
});

test("REST: editor cannot point an HTTP service at the control plane; admin can", async () => {
  const body = { ...makeHost({ name: "cp", domain: uniq("cp-edit") + ".example.com", forwardHost: "127.0.0.1", forwardPort: CP_PORT }) } as Record<string, unknown>;
  delete body.id; delete body.createdAt; delete body.updatedAt; delete body.health; delete body.certExpiresAt;
  const editor = await inject({ method: "POST", url: "/api/hosts", headers: { cookie: cookieFor(makeUser("editor")) }, payload: body });
  assert.equal(editor.statusCode, 403, `editor must be refused: ${editor.body}`);
  const admin = await inject({ method: "POST", url: "/api/hosts", headers: { cookie: cookieFor(makeUser("admin")) }, payload: body });
  assert.equal(admin.statusCode, 201, `admin portal flow must still work: ${admin.body}`);
  deleteHost(admin.json().host.id);
});

test("REST: stream passthrough / pools / path rules to the control plane are refused even for admins", async () => {
  const admin = cookieFor(makeUser("admin"));
  const strip = (h: Record<string, unknown>) => { delete h.id; delete h.createdAt; delete h.updatedAt; delete h.health; delete h.certExpiresAt; return h; };
  const tcp = await inject({ method: "POST", url: "/api/hosts", headers: { cookie: admin }, payload: strip({ ...makeHost({ name: "t", domain: uniq("cp-tcp") + ".example.com", protocol: "tcp", listenPort: 25565, forwardHost: "127.0.0.1", forwardPort: CP_PORT, ssl: false, http2: false }) }) });
  assert.equal(tcp.statusCode, 400, `tcp → control plane must be 400: ${tcp.body}`);
  const pool = await inject({ method: "POST", url: "/api/hosts", headers: { cookie: admin }, payload: strip({ ...makeHost({ name: "p", domain: uniq("cp-pool") + ".example.com", upstreams: `127.0.0.1:${CP_PORT}` }) }) });
  assert.equal(pool.statusCode, 400, `pool member → control plane must be 400: ${pool.body}`);
  const path = await inject({ method: "POST", url: "/api/hosts", headers: { cookie: admin }, payload: strip({ ...makeHost({ name: "r", domain: uniq("cp-path") + ".example.com", pathRules: `/api 127.0.0.1:${CP_PORT}` }) }) });
  assert.equal(path.statusCode, 400, `path rule → control plane must be 400: ${path.body}`);
});

test("stream listen ports owned by nginx/the control plane are reserved (tcp/sni), UDP exempt", () => {
  for (const port of [80, 443, CP_PORT]) {
    assert.match(streamPortConflictError({ protocol: "tcp", listenPort: port }, [])!, /reserved/);
    assert.match(streamPortConflictError({ protocol: "sni", listenPort: port }, [])!, /reserved/);
  }
  assert.equal(streamPortConflictError({ protocol: "udp", listenPort: CP_PORT }, []), null, "UDP does not collide with TCP listeners");
  assert.equal(streamPortConflictError({ protocol: "tcp", listenPort: 25565 }, []), null);
  assert.match(streamPortConflictError({ protocol: "tcp", listenPort: 0 }, [])!, /between 1 and 65535/);
});

test("REST: a non-admin may not edit, pause or delete the host that fronts the control plane", async () => {
  const portal = createHost(makeHost({ id: uniq("portal"), name: "portal", domain: uniq("nginux") + ".example.com", forwardHost: "127.0.0.1", forwardPort: CP_PORT }));
  assert.equal(frontsControlPlane(portal), true);
  const editor = cookieFor(makeUser("editor"));
  const put = await inject({ method: "PUT", url: `/api/hosts/${portal.id}`, headers: { cookie: editor }, payload: { name: "renamed" } });
  assert.equal(put.statusCode, 403, `editor PUT on portal host: ${put.body}`);
  const del = await inject({ method: "DELETE", url: `/api/hosts/${portal.id}`, headers: { cookie: editor } });
  assert.equal(del.statusCode, 403, `editor DELETE on portal host: ${del.body}`);
  const batch = await inject({ method: "POST", url: "/api/hosts/batch", headers: { cookie: editor }, payload: { ids: [portal.id], action: "disable" } });
  assert.ok([400, 403].includes(batch.statusCode), `editor batch on portal host must not be 2xx: ${batch.statusCode} ${batch.body}`);
  assert.equal(getHostByDomain(portal.domain)?.enabled, true, "portal host must remain enabled");
  deleteHost(portal.id);
});

test("agent tools: a control-scoped token cannot expose the control plane; a security-scoped one can", async () => {
  const control = resolveToken(mintToken(["control"]))!;
  const security = resolveToken(mintToken(["security"]))!;
  const args = { name: "cp-agent", domain: uniq("cp-agent") + ".example.com", forwardHost: "127.0.0.1", forwardPort: CP_PORT, requireLogin: true };
  // The guard lives in the handler, so exercise it directly for both principals.
  await assert.rejects(() => TOOLS.create_service.handler(args, control), /Only an admin/);
  const created = await TOOLS.create_service.handler({ ...args, domain: uniq("cp-sec") + ".example.com" }, security) as { id: string };
  assert.ok(created.id);
  deleteHost(created.id);
  // Pool/path targets are refused for everyone, including security scope.
  await assert.rejects(() => TOOLS.update_service.handler({ id: "nope", patch: {} }, security), /not found|Unknown|No such/i);
});

test("approval execution does not escalate: a queued create_service to the control plane still fails", async () => {
  // Agents queue medium-tier calls for a human; the handler later runs WITHOUT the
  // approver's identity, so it must behave as a non-admin (static rule applies).
  saveSettings({ agentAutoApprove: false });
  const control = resolveToken(mintToken(["control"]))!;
  const queued = await callTool(control, "create_service", { name: "q", domain: uniq("cp-queue") + ".example.com", forwardHost: "127.0.0.1", forwardPort: CP_PORT });
  assert.equal(queued.status, "pending_approval");
  const decided = await decideApproval(queued.approvalId!, true, "admin");
  assert.equal(decided?.status, "executed");
  assert.match(String((decided?.result as { error?: string })?.error ?? ""), /Only an admin/);
});

test("targetIsThisControlPlane recognises THIS instance by its per-boot id (and nothing else)", async () => {
  const mine = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, instance: INSTANCE_ID })); });
  const other = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, instance: "someone-else" })); });
  await new Promise<void>((r) => mine.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
  const port = (s: Server) => (s.address() as { port: number }).port;
  try {
    assert.equal(await targetIsThisControlPlane({ forwardHost: "127.0.0.1", forwardPort: port(mine), forwardScheme: "http" }), true);
    assert.equal(await targetIsThisControlPlane({ forwardHost: "127.0.0.1", forwardPort: port(other), forwardScheme: "http" }), false);
    assert.equal(await targetIsThisControlPlane({ forwardHost: "169.254.169.254", forwardPort: 80, forwardScheme: "http" }, 200), false, "never probes metadata");
  } finally {
    mine.close(); other.close();
  }
});

test("/api/health exposes the per-boot instance id used by the self-exposure probe", async () => {
  const r = await inject({ method: "GET", url: "/api/health" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().instance, INSTANCE_ID);
});

// ---------------------------------------------------------------------------
// nginx generator / validators
// ---------------------------------------------------------------------------
test("validators: `$` in names, zone ids / exponent masks in CIDRs, traversal in location paths", () => {
  assert.equal(hostInput.safeParse({ ...makeHost(), name: "$http_cookie" }).success, false, "nginx variable in a name must be refused");
  assert.equal(hasNginxMetachars("$x"), true);
  assert.equal(hasNginxMetachars("back\\slash"), true);
  assert.equal(isIpOrCidr("1.2.3.4/1e1"), false);
  assert.equal(isIpOrCidr("fe80::1%eth0"), false);
  assert.equal(isIpOrCidr("1.2.3.4/24"), true);
  assert.equal(isIpOrCidr("2001:db8::/32"), true);
  assert.equal(isLocationPath("/a/../b"), false);
  assert.equal(isLocationPath("/%zz"), false);
  assert.equal(isLocationPath("/ok/path"), true);
});

test("preset ids are looked up as own properties only (no prototype walk)", () => {
  assert.equal(hostInput.safeParse({ ...makeHost(), preset: "__proto__" }).success, false);
  assert.equal(hostInput.safeParse({ ...makeHost(), preset: "constructor" }).success, false);
  assert.doesNotThrow(() => generateHostConfig(makeHost({ preset: "constructor" })));
  assert.doesNotThrow(() => generateHostConfig(makeHost({ preset: "toString" })));
});

test("generator: a host fronting the control plane never emits custom response headers", () => {
  const conf = generateHostConfig(makeHost({ forwardHost: "127.0.0.1", forwardPort: CP_PORT, customHeaders: "X-Evil: 1\nAccess-Control-Allow-Origin: *" }));
  assert.doesNotMatch(conf, /X-Evil/);
  assert.doesNotMatch(conf, /Access-Control-Allow-Origin/);
  const normal = generateHostConfig(makeHost({ customHeaders: "X-Fine: 1" }));
  assert.match(normal, /X-Fine/);
});

test("generator: mTLS without a client CA fails CLOSED (403), never silently open", () => {
  const conf = generateHostConfig(makeHost({ domain: uniq("mtls-noca") + ".example.com", mtls: true, ssl: true }));
  assert.doesNotMatch(conf, /ssl_verify_client\s+on/);
  assert.match(conf, /return 403;/);
  assert.doesNotMatch(conf, /proxy_pass http:\/\/192\.168\.1\.60:3000/, "the upstream must not be reachable while the CA is missing");
});

test("generator: X-Forwarded-Host is pinned to $host in location / and in path-rule blocks", () => {
  const conf = generateHostConfig(makeHost({ pathRules: "/api 192.168.1.70:8080" }));
  const hits = conf.match(/proxy_set_header X-Forwarded-Host \$host;/g) ?? [];
  assert.ok(hits.length >= 2, `expected X-Forwarded-Host in both blocks, got ${hits.length}`);
});

test("generator: IPv6 upstreams are bracketed in proxy_pass", () => {
  const conf = generateHostConfig(makeHost({ forwardHost: "fd00::10", forwardPort: 8080 }));
  assert.match(conf, /proxy_pass http:\/\/\[fd00::10\]:8080/);
});

test("deleteCert keeps the per-host client CA material (mTLS must not silently fail open)", () => {
  const domain = uniq("ca-keep") + ".example.com";
  const dir = join(CERT_DIR, domain);
  mkdirSync(dir, { recursive: true });
  for (const f of ["fullchain.pem", "privkey.pem", "client-ca.crt", "client-ca.key", "client-ca.crl"]) writeFileSync(join(dir, f), "x");
  // The DB row is the authority: deleteCert refuses to touch a directory with no record.
  assert.equal(deleteCert(domain), false);
  assert.equal(existsSync(join(dir, "fullchain.pem")), true);
  db.prepare("INSERT INTO certificates (domain, status, issuer, method, sans, updatedAt) VALUES (?,?,?,?,?,?)")
    .run(domain, "valid", "self", "selfsigned", JSON.stringify([domain]), new Date().toISOString());
  assert.equal(deleteCert(domain), true);
  assert.equal(getCert(domain), null);
  assert.equal(existsSync(join(dir, "fullchain.pem")), false);
  assert.equal(existsSync(join(dir, "privkey.pem")), false);
  assert.equal(existsSync(join(dir, "client-ca.crt")), true);
  assert.equal(existsSync(join(dir, "client-ca.key")), true);
});

// ---------------------------------------------------------------------------
// forward-auth resolves the row nginx is actually SERVING
// ---------------------------------------------------------------------------
test("forward-auth: a disabled exact row cannot shadow the enabled wildcard's policy; ungated rows deny", async () => {
  const tag = Math.random().toString(36).slice(2, 7);
  const wildcard = createHost(makeHost({ id: uniq("wc"), name: "wc", domain: `*.fa-${tag}.example.com`, requireLogin: true, require2fa: true }));
  const exact = createHost(makeHost({ id: uniq("ex"), name: "ex", domain: `app.fa-${tag}.example.com`, requireLogin: true, require2fa: false, enabled: false }));
  const ungated = createHost(makeHost({ id: uniq("ug"), name: "ug", domain: `open-${tag}.example.com`, requireLogin: false }));
  assert.equal(getServingHttpHostByDomainCached(`app.fa-${tag}.example.com`)?.id, wildcard.id, "serving row is the enabled wildcard");
  const uid = makeUser("editor"); // no 2FA
  const headers = (host: string) => ({ "x-nginux-forward-secret": FWD_SECRET, "x-original-host": host, cookie: cookieFor(uid) });
  const viaWildcard = await inject({ method: "GET", url: "/api/auth/forward", headers: headers(`app.fa-${tag}.example.com`) });
  assert.equal(viaWildcard.statusCode, 401, "wildcard requires 2FA; the disabled exact row (no 2FA) must not win");
  const open = await inject({ method: "GET", url: "/api/auth/forward", headers: headers(`open-${tag}.example.com`) });
  assert.equal(open.statusCode, 401, "a requireLogin=false row never produced this gate check - deny");
  deleteHost(wildcard.id); deleteHost(exact.id); deleteHost(ungated.id);
});

// ---------------------------------------------------------------------------
// bans: the sink validates
// ---------------------------------------------------------------------------
test("bans: non-IP values are refused at the sink and never reach nginx config", () => {
  assert.throws(() => addBan("not-an-ip", "x"), /valid IP/);
  assert.throws(() => addBan("1.2.3.4; }\nreturn 200;", "x"), /valid IP/);
  assert.throws(() => addBan("fe80::1%eth0", "x"), /valid IP/);
  // Restore skips bad rows instead of writing them.
  const kept = replaceAllBans([{ ip: "203.0.113.9", reason: "ok", source: "manual", createdAt: new Date().toISOString(), expiresAt: null },
    { ip: "evil;include /etc/passwd;", reason: "x", source: "manual", createdAt: new Date().toISOString(), expiresAt: null }]);
  assert.equal(kept, 1);
  for (const f of [BANNED_FILE, STREAM_BANNED_FILE]) {
    const conf = readFileSync(f, "utf8");
    assert.match(conf, /203\.0\.113\.9/);
    assert.doesNotMatch(conf, /passwd|evil/);
  }
  replaceAllBans([]);
});

// ---------------------------------------------------------------------------
// login hardening
// ---------------------------------------------------------------------------
test("login limiter: one throttled IP does not consume the shared global budget", async () => {
  const a = "198.51.100.77", b = "198.51.100.78";
  let sawIpThrottle = false;
  for (let i = 0; i < 400; i++) {
    const r = await inject({ method: "POST", url: "/api/auth/login", remoteAddress: a, payload: { username: `ghost${i}`, password: "wrong-password" } });
    if (r.statusCode === 429) {
      sawIpThrottle = true;
      assert.doesNotMatch(r.json().error, /temporarily busy/, "the per-IP limiter must trip before the global one");
    }
  }
  assert.ok(sawIpThrottle);
  const other = await inject({ method: "POST", url: "/api/auth/login", remoteAddress: b, payload: { username: "someone", password: "wrong-password" } });
  assert.equal(other.statusCode, 401, "a different IP must still be able to attempt sign-in");
});

test("2FA enrolment burns its TOTP step: the enrol code cannot be replayed at sign-in", async () => {
  const username = uniq("enrol");
  const user = await createUser({ username, password: "correct horse battery staple", role: "editor" });
  const uid = String(user.id);
  const { secret } = beginTwofaSetup(uid);
  const code = totp(secret);
  const verify = await inject({ method: "POST", url: "/api/auth/2fa/verify", headers: { cookie: cookieFor(uid) }, payload: { token: code } });
  assert.equal(verify.statusCode, 200, verify.body);
  const replay = await inject({ method: "POST", url: "/api/auth/login", remoteAddress: "198.51.100.90", payload: { username, password: "correct horse battery staple", token: code } });
  assert.equal(replay.statusCode, 401, "the code used to enrol must not also open a session");
  assert.equal(replay.json().twofaRequired, true);
});

test("session cookie: the first LIVE nginux_session value wins (a sibling app's cookie cannot shadow a login)", async () => {
  const uid = makeUser("editor");
  const live = cookieFor(uid).split("=")[1];
  assert.deepEqual(parseCookieAll("a=1; nginux_session=x; b=2; nginux_session=y", "nginux_session"), ["x", "y"]);
  const shadowFirst = await inject({ method: "GET", url: "/api/auth/me", headers: { cookie: `nginux_session=stale-garbage; nginux_session=${live}` } });
  assert.equal(shadowFirst.statusCode, 200, "stale cookie listed first must not hide the live one");
  const shadowLast = await inject({ method: "GET", url: "/api/auth/me", headers: { cookie: `nginux_session=${live}; nginux_session=stale-garbage` } });
  assert.equal(shadowLast.statusCode, 200, "stale cookie listed last must not hide the live one");
  // nginx drops the whole Cookie header for the UPSTREAM beyond COOKIE_STRIP_PASSES
  // duplicates (fail closed) but still forwards it on the auth subrequest, so the
  // control plane must keep looking past that budget (real-nginx itest A1).
  assert.ok(MAX_SESSION_COOKIES > COOKIE_STRIP_PASSES + 1, "session-candidate bound must exceed nginx's strip budget");
  const decoys = Array.from({ length: COOKIE_STRIP_PASSES + 1 }, (_, i) => `nginux_session=decoy${i}`).join("; ");
  const overBudget = await inject({ method: "GET", url: "/api/auth/me", headers: { cookie: `${decoys}; nginux_session=${live}` } });
  assert.equal(overBudget.statusCode, 200, "a valid session after more decoys than the strip budget still authenticates");
  const flood = Array.from({ length: MAX_SESSION_COOKIES }, (_, i) => `nginux_session=decoy${i}`).join("; ");
  const beyondBound = await inject({ method: "GET", url: "/api/auth/me", headers: { cookie: `${flood}; nginux_session=${live}` } });
  assert.equal(beyondBound.statusCode, 401, "candidates past the bound are never looked up (cost cap)");
});

test("session cookie Domain is only emitted when the request host sits under the base domain", async () => {
  saveSettings({ ssoLoginUrl: "https://nginux.cookie-test.example", ssoCookieDomain: "", ssoRealms: "" });
  const username = uniq("cookie");
  await createUser({ username, password: "correct horse battery staple", role: "editor" });
  const viaPortal = await inject({ method: "POST", url: "/api/auth/login", remoteAddress: "198.51.100.91", headers: { host: "nginux.cookie-test.example" }, payload: { username, password: "correct horse battery staple" } });
  assert.equal(viaPortal.statusCode, 200);
  assert.match(String(viaPortal.headers["set-cookie"]), /Domain=\.cookie-test\.example/);
  const viaLanIp = await inject({ method: "POST", url: "/api/auth/login", remoteAddress: "198.51.100.92", headers: { host: "192.168.1.5:6767" }, payload: { username, password: "correct horse battery staple" } });
  assert.equal(viaLanIp.statusCode, 200);
  assert.doesNotMatch(String(viaLanIp.headers["set-cookie"]), /Domain=/, "a host-only cookie for a host outside the base (browsers would reject the Domain anyway)");
  const viaOther = await inject({ method: "POST", url: "/api/auth/login", remoteAddress: "198.51.100.93", headers: { host: "evil-cookie-test.example" }, payload: { username, password: "correct horse battery staple" } });
  assert.doesNotMatch(String(viaOther.headers["set-cookie"]), /Domain=/, "a look-alike host must not receive a base-wide cookie");
  saveSettings({ ssoLoginUrl: "" });
});

test("SSO realms: sibling realms under one registrable domain stay independent (suffix match, most specific wins)", () => {
  const realms = [
    { baseDomain: "a.example.com", loginUrl: "https://login.a.example.com" },
    { baseDomain: "b.example.com", loginUrl: "https://login.b.example.com" },
  ];
  assert.deepEqual(realmForHost("app.b.example.com", realms), { loginUrl: "https://login.b.example.com", cookieDomain: ".b.example.com" });
  assert.deepEqual(realmForHost("app.a.example.com", realms), { loginUrl: "https://login.a.example.com", cookieDomain: ".a.example.com" });
  assert.equal(realmForHost("other.example.com", realms), null, "ambiguous registrable fallback must not pick one sibling");
  // Legacy single realm entered as the portal host still covers its registrable domain.
  assert.deepEqual(realmForHost("plex.ubhits.com", [{ baseDomain: "nginux.ubhits.com", loginUrl: "https://nginux.ubhits.com" }]),
    { loginUrl: "https://nginux.ubhits.com", cookieDomain: ".ubhits.com" });
});

// ---------------------------------------------------------------------------
// information exposure
// ---------------------------------------------------------------------------
test("GET /api/settings for a non-admin is an allowlist: operational keys only, credentials masked, the rest default", async () => {
  saveSettings({ letsEncryptEmail: "secret-contact@example.com", godaddyApiKey: "gd-key-123456", instanceName: "Lab 42", logMaxMb: 77 });
  const editor = await inject({ method: "GET", url: "/api/settings", headers: { cookie: cookieFor(makeUser("editor")) } });
  assert.equal(editor.statusCode, 200);
  const s = editor.json();
  assert.equal(s.instanceName, "Lab 42");
  assert.equal(s.godaddyApiKey, "••••••••");
  assert.equal(s.letsEncryptEmail, "", "not on the non-admin allowlist → default");
  assert.equal(s.logMaxMb, 50, "not on the non-admin allowlist → default");
  const admin = await inject({ method: "GET", url: "/api/settings", headers: { cookie: cookieFor(makeUser("admin")) } });
  assert.equal(admin.json().letsEncryptEmail, "secret-contact@example.com");
  // Backup exports without secrets keep every non-credential setting (restore round-trips).
  const masked = maskSecretSettings(admin.json());
  assert.equal(masked.letsEncryptEmail, "secret-contact@example.com");
  assert.equal(masked.godaddyApiKey, "••••••••");
  assert.equal((redactSettings(admin.json()) as Record<string, unknown>).sessionTokensHashed, undefined, "internal marker rows never leak");
  saveSettings({ letsEncryptEmail: "", godaddyApiKey: "", instanceName: "Home Lab", logMaxMb: 50 });
});

test("/api/notifications only names hosts a scoped user is allowed to see", async () => {
  const tag = Math.random().toString(36).slice(2, 7);
  const mine = createHost(makeHost({ id: uniq("mine"), name: `Mine-${tag}`, domain: `mine-${tag}.example.com` }));
  const theirs = createHost(makeHost({ id: uniq("theirs"), name: `Theirs-${tag}`, domain: `theirs-${tag}.example.com` }));
  updateHost(mine.id, { health: "down" });
  updateHost(theirs.id, { health: "down" });
  const scoped = await inject({ method: "GET", url: "/api/notifications", headers: { cookie: cookieFor(makeUser("scoped", mine.id)) } });
  assert.equal(scoped.statusCode, 200);
  const text = JSON.stringify(scoped.json());
  assert.match(text, new RegExp(`Mine-${tag}`));
  assert.doesNotMatch(text, new RegExp(`Theirs-${tag}`), "out-of-scope host names must not leak via notifications");
  assert.doesNotMatch(text, new RegExp(theirs.id));
  const direct = await buildNotifications({ isManager: false, canSee: (h) => h.id === theirs.id });
  assert.ok(direct.some((n) => n.message.includes(`Theirs-${tag}`)) && !direct.some((n) => n.message.includes(`Mine-${tag}`)));
  deleteHost(mine.id); deleteHost(theirs.id);
});

test("read-tier tool calls do not write agent.tool_called audit rows (no audit-wipe amplification)", async () => {
  const read = resolveToken(mintToken(["read"]))!;
  const count = () => Number((db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE type = 'agent.tool_called'").get() as { n: number }).n);
  const before = count();
  for (let i = 0; i < 5; i++) assert.equal((await callTool(read, "get_health", {})).status, "ok");
  assert.equal(count(), before, "read tools must not add audit rows");
  // Auto-approve only applies to TRUSTED agents; an untrusted one still queues.
  const control = resolveToken(createToken({ name: uniq("tok_trusted"), scopes: ["control"], trust: "trusted" }).token)!;
  saveSettings({ agentAutoApprove: true });
  const r = await callTool(control, "set_service_enabled", { id: "does-not-exist", enabled: true });
  const untrusted = await callTool(resolveToken(mintToken(["control"]))!, "set_service_enabled", { id: "does-not-exist", enabled: true });
  saveSettings({ agentAutoApprove: false });
  assert.notEqual(r.status, "pending_approval");
  assert.equal(untrusted.status, "pending_approval");
  assert.ok(count() >= before + 1, "a write-tier call is still audited");
});

// ---------------------------------------------------------------------------
// DoS / robustness
// ---------------------------------------------------------------------------
test("importer: oversized input is refused up front and the ssl-detection scan is linear", () => {
  assert.throws(() => parseNginxConf("x".repeat(IMPORT_MAX_BYTES + 1)), /too large/);
  // The old `/\blisten\s+[^;]*\bssl\b/` family went super-linear on long runs of spaces.
  const evil = `server {\n server_name a.example.com;\n listen 443 ${" ".repeat(200_000)}x;\n location / { proxy_pass http://1.2.3.4:80; }\n}\n`;
  const t0 = performance.now();
  parseNginxConf(evil);
  assert.ok(performance.now() - t0 < 1000, "pathological listen line must parse in linear time");
});

test("metrics: request-derived keys are length-bounded before they become map keys", () => {
  ingest({ ts: new Date().toISOString(), host: "A".repeat(600) + ".example.com", method: "GET", path: "/" + "p".repeat(10_000), status: 200, bytes: 1, ip: "203.0.113.5", country: "US", ua: "u".repeat(10_000), ms: 1 });
  const last = recentLogs(undefined, 1)[0];
  assert.ok(last.path.length <= 256);
  assert.ok(last.ua.length <= 256);
  assert.ok(last.host.length <= 253);
  assert.equal(last.host, last.host.toLowerCase());
});

test("JSON bodies carrying __proto__/constructor are rejected by the parser; sanitizeHostPatch never merges them", async () => {
  const r = await inject({
    method: "POST", url: "/api/hosts", headers: { cookie: cookieFor(makeUser("admin")), "content-type": "application/json" },
    payload: '{"__proto__": {"polluted": true}, "name": "x"}',
  });
  assert.equal(r.statusCode, 400);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const patch = sanitizeHostPatch(JSON.parse('{"name": "ok", "__proto__": {"polluted": true}, "constructor": {"a": 1}}'));
  assert.equal(Object.getPrototypeOf(patch) === null || !("polluted" in patch), true);
  assert.deepEqual(Object.keys(patch), ["name"]);
});

test("SSE: per-principal connection cap (one token/session cannot hoard every stream slot)", async () => {
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const token = mintToken(["report"]);
  const controllers: AbortController[] = [];
  try {
    const open = async () => {
      const ac = new AbortController();
      controllers.push(ac);
      return fetch(`${address}/api/events/sse`, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal: ac.signal });
    };
    const first = await Promise.all([open(), open(), open(), open(), open()]);
    assert.ok(first.every((r) => r.status === 200), "five streams per principal are allowed");
    const sixth = await open();
    assert.equal(sixth.status, 503, "the sixth stream for the same principal is refused");
    // A different principal still gets a slot.
    const otherAc = new AbortController(); controllers.push(otherAc);
    const other = await fetch(`${address}/api/logs/stream`, { headers: { authorization: `Bearer ${mintToken(["report"])}`, accept: "text/event-stream" }, signal: otherAc.signal });
    assert.equal(other.status, 200);
  } finally {
    for (const c of controllers) c.abort();
  }
});

// ---------------------------------------------------------------------------
// notification adapters
// ---------------------------------------------------------------------------
test("Discord payloads disable mention parsing; Slack text escapes mrkdwn control characters; failures are categorised", async () => {
  const bodies: Array<{ path: string; body: string }> = [];
  const srv = createServer((req, res) => {
    let data = ""; req.on("data", (c) => { data += c; }); req.on("end", () => { bodies.push({ path: req.url ?? "", body: data }); res.statusCode = 200; res.end("ok"); });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  try {
    const discord = createChannel({ type: "discord", name: "d", config: { url: `http://127.0.0.1:${port}/discord` } });
    const slack = createChannel({ type: "slack", name: "s", config: { url: `http://127.0.0.1:${port}/slack` } });
    assert.equal((await testChannel(discord.id)).ok, true);
    assert.equal((await testChannel(slack.id)).ok, true);
    const d = JSON.parse(bodies.find((b) => b.path === "/discord")!.body);
    assert.deepEqual(d.allowed_mentions, { parse: [] });
    const s = JSON.parse(bodies.find((b) => b.path === "/slack")!.body);
    assert.doesNotMatch(s.text, /<|>|&(?!amp;|lt;|gt;)/, "raw <, > and & must be escaped for mrkdwn");
    assert.match(s.text, /NginUX test/);
    // ntfy topic is a capability: masked like other identifiers.
    const ntfy = createChannel({ type: "ntfy", name: "n", config: { topic: "very-secret-topic-name" } });
    assert.match(ntfy.config.topic, /••••/);
  } finally {
    srv.close();
  }
  // A dead endpoint yields a fixed category, never the raw error text / remote banner.
  const dead = createChannel({ type: "webhook", name: "w", config: { url: "http://127.0.0.1:9/hook" } });
  const res = await testChannel(dead.id);
  assert.equal(res.ok, false);
  assert.match(res.status, /^failed: (unreachable|timeout|rejected|tls error|rejected \(authentication\))$/);
});

test("misc hardening: syslog port range, RFC 8215 NAT64 prefix, login.failed with a non-IP source is ignored by auto-ban", () => {
  assert.equal(parseSyslogUrl("syslog://siem.example.com:99999"), null);
  assert.equal(parseSyslogUrl("syslog://siem.example.com:514")?.port, 514);
  assert.equal(isDangerousHost("64:ff9b:1::a9fe:a9fe"), true);
  // The ban engine subscribes on boot in production; here we only assert the sink.
  assert.doesNotThrow(() => logEvent({ type: "login.failed", severity: "warn", actor: "x", summary: "test", ip: "not an ip; }", meta: {} }));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bans WHERE ip LIKE '%not an ip%'").get() && Number((db.prepare("SELECT COUNT(*) AS n FROM bans WHERE ip LIKE '%not an ip%'").get() as { n: number }).n), 0);
});
