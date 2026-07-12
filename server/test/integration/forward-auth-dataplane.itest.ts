/**
 * REAL-NGINX DATA-PLANE INTEGRATION TEST
 * ======================================
 * Proves the app's core promise end-to-end: no under-authenticated request reaches a
 * gated backend. Unlike the unit tests (which drive the Fastify app via app.inject and
 * assert the /api/auth/forward handler in isolation), this suite stands up REAL nginx in
 * front of REAL echo upstreams, feeds it the app's ACTUAL generated config, and drives
 * live HTTP requests through the whole chain:
 *
 *     curl -> nginx (auth_request) -> control plane /api/auth/forward -> allow/deny
 *                    |-- allow --> proxy_pass --> echo upstream (stamps UPSTREAM_OK)
 *                    `-- deny  --> 401/403 or 302-to-login, upstream NEVER reached
 *
 * The single load-bearing assertion everywhere: on DENY the upstream marker must be
 * ABSENT; on ALLOW it must be PRESENT with 200. This is what a unit test cannot prove —
 * that nginx, with the config we actually ship, enforces the gate the way we think.
 *
 * WHY THIS EXISTS: the "unauthenticated request reaches a service" bug class recurred
 * (case-sensitive/wildcard host lookup fail-open, 2026-07-12). Fail-closed defaults fix
 * the class in the control plane; THIS test proves it holds through the real data plane.
 *
 * RUNNING IT
 *   - Skips cleanly (no-op) unless a real nginx binary is found. Set NGINUX_NGINX_BIN to
 *     an absolute nginx path, or put `nginx` on PATH. It is NOT part of `npm test` (the
 *     default glob is *.test.ts; this file is *.itest.ts). Run: `npm run test:integration`.
 *   - The harness uses ONLY the app's pure config generators (writeAllConfigs /
 *     writeBannedConf) — it never calls applyConfig(), so nothing regenerates config
 *     behind its back. The ONLY transform applied to generated config is remapping the
 *     privileged `listen 80` down to a high port so nginx binds unprivileged on any
 *     runner; no security-relevant directive is touched.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import http from "node:http";
import https from "node:https";
import forge from "node-forge";

// ---------------------------------------------------------------------------
// Detect nginx once. Absent -> the whole suite is skipped (local dev boxes).
// ---------------------------------------------------------------------------
const NGINX_BIN = process.env.NGINUX_NGINX_BIN ?? "nginx";
function nginxPresent(): boolean {
  try { execFileSync(NGINX_BIN, ["-v"], { stdio: "ignore", timeout: 15_000 }); return true; }
  catch { return false; }
}
const SKIP = !nginxPresent();
// A security suite that silently no-ops to GREEN when its dependency is missing is a
// trap: a dropped env var or a broken nginx install would quietly stop proving anything.
// CI sets NGINUX_REQUIRE_NGINX=1 so absence becomes a hard FAILURE, not a skip.
const REQUIRE_NGINX = process.env.NGINUX_REQUIRE_NGINX === "1";
if (SKIP) {
  console.log(`[integration] nginx not found (NGINUX_NGINX_BIN=${process.env.NGINUX_NGINX_BIN ?? "<unset>"}) — skipping data-plane suite.`);
}

// ---------------------------------------------------------------------------
// Fixed ports (high, unprivileged, unlikely to clash on a CI runner).
// ---------------------------------------------------------------------------
const CP_PORT = 6790;      // control plane (Fastify) — auth_request target
const NG_HTTP = 18080;     // nginx front door (plain HTTP)
const NG_HTTPS = 18443;    // nginx front door (TLS — for the ssl:true fixture)
const ECHO1 = 18781;       // primary echo upstream
const ECHO2 = 18782;       // secondary upstream (path-route test)
const SECRET = "itest-forward-secret-0123456789";
const SSO = "https://nginux.example.com";

// A temp prefix for all nginx + data files. Env MUST be set before importing any src
// module (they capture path constants at evaluation time), so we do it at file scope.
const DIR = mkdtempSync(join(tmpdir(), "nginux-itest-"));
const P = (...s: string[]) => join(DIR, ...s).replace(/\\/g, "/");
Object.assign(process.env, {
  NGINUX_DATA_DIR: DIR,
  NGINX_CONF_DIR: P("conf.d"),
  NGINX_STREAM_DIR: P("stream.d"),
  NGINX_GEOIP_CONF: P("geoip.conf"),
  GEOIP_DIR: P("geoip"),
  CERT_DIR: P("certs"),
  ACME_WEBROOT: P("acme-webroot"),
  NGINX_ACCESS_LOG: P("access.log"),
  NGINX_BANNED_FILE: P("banned.conf"),
  NGINX_DEFAULT_CERT: P("selfsigned.crt"),
  NGINX_DEFAULT_KEY: P("selfsigned.key"),
  NGINUX_CONTROL_URL: `http://127.0.0.1:${CP_PORT}`,
  PORT: String(CP_PORT),
  HOST: "127.0.0.1",
  // Keep the app from shelling out to nginx on its own (we drive nginx ourselves).
  NGINX_BIN: "nginux-itest-no-autoapply",
  NGINUX_ADMIN_PASSWORD: "itest-admin-pw",  // avoid default-admin mustChangePassword
  NGINUX_SECURE_COOKIES: "0",
  NODE_ENV: "production",                    // no demo users; clean fixture set
  LOG_LEVEL: "silent",
});

// Late-bound module handles (populated in before()).
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let app: Any, db: Any, saveSettings: Any, createSession: Any, createHost: Any, makeHost: Any,
  listHosts: Any, buildDesiredConfigs: Any, writeGeoipConf: Any, writeBannedConf: Any;
let nginx: ChildProcess | null = null;
let cookies: Record<string, string> = {};
let sslOk = false; // set once a self-signed cert is minted, gating the ssl:true fixture
const echoServers: http.Server[] = [];

// A user row, inserted directly so we can pin role/scope/2FA/mustChange precisely.
function seedUser(opts: { role: string; scope?: string; twofa?: 0 | 1; mustChange?: 0 | 1 }): string {
  const id = `u_${opts.role}_${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    "INSERT INTO users (id, username, email, passwordHash, role, scope, twofaEnabled, backupCodes, twofaLastCounter, mustChangePassword, createdAt) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run(id, id, "", "x", opts.role, opts.scope ?? "", opts.twofa ?? 0, "[]", -1, opts.mustChange ?? 0, new Date().toISOString());
  return id;
}
const cookie = (uid: string) => `nginux_session=${createSession(uid, "itest", "127.0.0.1")}`;

// A tiny echo upstream. Reaching it AT ALL proves the gate was passed; the body carries
// a distinctive marker + reflects the Cookie header (for the aspirational cookie-leak test).
function startEcho(port: number, tag: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      res.setHeader("X-Upstream", tag);
      res.end(`UPSTREAM_OK ${tag} cookie=[${req.headers.cookie ?? ""}]`);
    });
    echoServers.push(srv);
    srv.on("error", reject); // surface EADDRINUSE as an actionable setup failure, not a crash
    srv.listen(port, "127.0.0.1", () => resolve());
  });
}

// A minimal self-signed cert so the ssl:true fixture's `listen 443 ssl` block validates
// and serves. Uses node-forge (a server dependency); throws are caught so the SSL fixture
// degrades to skipped rather than failing the whole suite.
function makeSelfSignedCert(certPath: string, keyPath: string) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(2020, 0, 1);
  cert.validity.notAfter = new Date(2035, 0, 1);
  const attrs = [{ name: "commonName", value: "nginux-itest" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  writeFileSync(certPath, forge.pki.certificateToPem(cert));
  writeFileSync(keyPath, forge.pki.privateKeyToPem(keys.privateKey));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Low-level GET so we can set an explicit Host header. NOTE: fetch()/undici silently
// DROPS the Host header (it's a "forbidden header name" in the fetch spec) — which would
// send every probe to nginx's default_server. node:http honors an explicit Host, and
// never auto-follows redirects, so a 302-to-login is observed as a 302.
function rawGet(opts: { port: number; host: string; path?: string; cookie?: string; headers?: Record<string, string> }): Promise<{ status: number; body: string; location: string | null }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: opts.port, path: opts.path ?? "/", method: "GET",
        headers: { Host: opts.host, ...(opts.cookie ? { Cookie: opts.cookie } : {}), ...(opts.headers ?? {}) } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { body += c; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, location: res.headers.location ?? null }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// TLS sibling of rawGet: sets SNI (servername) + Host, and accepts the self-signed cert.
function rawGetTls(opts: { host: string; path?: string; cookie?: string }): Promise<{ status: number; body: string; location: string | null }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: "127.0.0.1", port: NG_HTTPS, servername: opts.host, path: opts.path ?? "/", method: "GET",
        rejectUnauthorized: false, headers: { Host: opts.host, ...(opts.cookie ? { Cookie: opts.cookie } : {}) } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { body += c; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, location: res.headers.location ?? null }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// A request through nginx, keyed by the virtual Host (plain HTTP).
async function via(host: string, opts: { path?: string; cookie?: string; headers?: Record<string, string> } = {}) {
  const r = await rawGet({ port: NG_HTTP, host, path: opts.path, cookie: opts.cookie, headers: opts.headers });
  return { ...r, reachedUpstream: r.body.includes("UPSTREAM_OK") };
}

// Same, over TLS on the ssl:true fixture.
async function viaHttps(host: string, opts: { path?: string; cookie?: string } = {}) {
  const r = await rawGetTls({ host, path: opts.path, cookie: opts.cookie });
  return { ...r, reachedUpstream: r.body.includes("UPSTREAM_OK") };
}

// Assert a DENY: upstream never reached, and the status is one of the deny codes.
function assertDenied(r: { status: number; reachedUpstream: boolean }, allowed: number[], msg: string) {
  assert.equal(r.reachedUpstream, false, `${msg}: upstream MUST NOT be reached (got body marker)`);
  assert.ok(allowed.includes(r.status), `${msg}: expected status in ${JSON.stringify(allowed)}, got ${r.status}`);
}
function assertAllowed(r: { status: number; reachedUpstream: boolean }, msg: string) {
  assert.equal(r.status, 200, `${msg}: expected 200`);
  assert.equal(r.reachedUpstream, true, `${msg}: upstream marker MUST be present`);
}

async function nginxCtl(args: string[]) {
  spawnSync(NGINX_BIN, ["-p", `${DIR.replace(/\\/g, "/")}/`, "-c", P("nginx.conf"), ...args], { stdio: "ignore", timeout: 15_000 });
}

// Poll until a probe request satisfies `ok`, or throw after the deadline.
async function waitUntil(probe: () => Promise<boolean>, ms: number, label: string) {
  const deadline = Date.now() + ms;
  for (;;) {
    try { if (await probe()) return; } catch { /* not ready */ }
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(200);
  }
}

before(async () => {
  if (SKIP) return;
  // --- import src modules (env is already set) ---
  ({ app } = await import("../../src/index.ts"));
  ({ db, saveSettings } = await import("../../src/db.ts"));
  ({ createSession } = await import("../../src/auth.ts"));
  ({ createHost, listHosts } = await import("../../src/repo.ts"));
  ({ makeHost } = await import("../helpers.ts"));
  ({ buildDesiredConfigs } = await import("../../src/nginx.ts"));
  ({ writeGeoipConf } = await import("../../src/geoip.ts"));
  ({ writeBannedConf } = await import("../../src/bans.ts"));
  await app.ready();

  // Pin the forward secret + SSO URL BEFORE generating config (both are baked into the
  // generated nginx config, and the live control plane reads the secret to authenticate
  // the auth_request subrequest — they must match).
  saveSettings({ ssoForwardSecret: SECRET, ssoLoginUrl: SSO });

  // --- fixtures: hosts (all ssl:false -> plain `listen 80`, remapped below) ---
  const H = (o: Record<string, unknown>) =>
    createHost(makeHost({ ssl: false, securityHeaders: false, blockExploits: false, http2: false, forwardScheme: "http", forwardHost: "127.0.0.1", forwardPort: ECHO1, ...o }));
  H({ id: "plex", name: "Plex", domain: "plex.example.com", requireLogin: true });
  H({ id: "vault", name: "Vault", domain: "vault.example.com", requireLogin: true, require2fa: true });
  H({ id: "photos", name: "Photos", domain: "photos.example.com", requireLogin: true });
  H({ id: "ha", name: "HA", domain: "ha.example.com", requireLogin: true });
  H({ id: "cased", name: "Cased", domain: "Cased.Example.com", requireLogin: true }); // stored with uppercase — the recurrence
  H({ id: "wild", name: "Wild", domain: "*.apps.example.com", requireLogin: true });   // wildcard server_name
  H({ id: "open", name: "Open", domain: "open.example.com", requireLogin: false });     // not gated (control)
  H({ id: "banned", name: "BanHost", domain: "banhost.example.com", requireLogin: false, ipAllow: "127.0.0.1" }); // ban-vs-ipAllow
  H({ id: "pathhost", name: "PathHost", domain: "pathhost.example.com", requireLogin: true,
     pathRules: `/grafana 127.0.0.1:${ECHO2}` }); // "/path host:port" per line (not JSON)
  // ssl:true fixture — exercises the gate inside a real `listen 443 ssl` block AND proves
  // the paired `listen 80` redirect server 301s without proxying to the backend.
  try {
    makeSelfSignedCert(P("selfsigned.crt"), P("selfsigned.key")); // NGINX_DEFAULT_CERT/KEY point here
    H({ id: "secure", name: "Secure", domain: "secure.example.com", requireLogin: true, ssl: true });
    sslOk = true;
  } catch (e) {
    console.log("[integration] self-signed cert generation failed; skipping SSL fixtures:", (e as Error).message);
  }

  // --- users + sessions ---
  const users = {
    admin: seedUser({ role: "admin" }),
    editor: seedUser({ role: "editor" }),
    scoped: seedUser({ role: "scoped", scope: "photos.example.com" }),
    manager2fa: seedUser({ role: "editor", twofa: 1 }),   // enrolled 2FA
    tempPw: seedUser({ role: "admin", mustChange: 1 }),   // fresh-install default cred
  };
  cookies = {
    admin: cookie(users.admin), editor: cookie(users.editor), scoped: cookie(users.scoped),
    manager2fa: cookie(users.manager2fa), tempPw: cookie(users.tempPw),
  };

  // --- generate REAL config into the temp prefix (pure writers, no nginx invoked) ---
  await startEcho(ECHO1, "primary");
  await startEcho(ECHO2, "grafana");
  writeGeoipConf();
  writeBannedConf();
  writeGeneratedConfigs();     // app's real buildDesiredConfigs(), filesystem-safe filenames
  remapListenPorts();          // listen 80 -> NG_HTTP (only transform applied)
  writeWrapperConf();          // assemble the top-level nginx.conf

  // --- validate the app's generated config with real nginx (valuable on its own) ---
  const t = spawnSync(NGINX_BIN, ["-p", `${DIR.replace(/\\/g, "/")}/`, "-c", P("nginx.conf"), "-t"], { encoding: "utf8", timeout: 15_000 });
  assert.equal(t.status, 0, `nginx -t must accept the app's generated config:\n${t.stderr}`);

  // --- start the control plane (auth_request target) + nginx ---
  await app.listen({ port: CP_PORT, host: "127.0.0.1" });
  nginx = spawn(NGINX_BIN, ["-p", `${DIR.replace(/\\/g, "/")}/`, "-c", P("nginx.conf")], { stdio: "ignore", detached: process.platform !== "win32" });
  await waitUntil(async () => (await rawGet({ port: CP_PORT, host: "127.0.0.1", path: "/api/health" })).status === 200, 15_000, "control plane health");
  await waitUntil(async () => (await via("open.example.com")).reachedUpstream, 15_000, "nginx serving");
});

// ---------------------------------------------------------------------------
// Helpers to assemble the temp nginx tree.
// ---------------------------------------------------------------------------
function writeGeneratedConfigs() {
  // The app's REAL generation (same routing + content as writeAllConfigs), but we write
  // each file ourselves so a wildcard domain like `*.apps.example.com` — whose default
  // filename `*.apps.example.com.conf` is illegal on Windows/NTFS — lands on a
  // filesystem-safe basename. The filename is cosmetic: nginx pulls every block in via a
  // glob include, and the security-relevant directives inside the file are byte-identical.
  for (const [absPath, content] of buildDesiredConfigs(listHosts()) as Map<string, string>) {
    const safe = join(dirname(absPath), basename(absPath).replace(/[*?<>:"|]/g, "_"));
    mkdirSync(dirname(safe), { recursive: true });
    writeFileSync(safe, content);
  }
}
function remapListenPorts() {
  const dir = P("conf.d");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".conf"))) {
    const p = join(dir, f);
    const before = readFileSync(p, "utf8");
    // ONLY the privileged listen ports are rewritten so nginx binds unprivileged. No
    // server_name / auth_request / proxy_pass / if-banned / ssl_* directive is touched.
    const after = before
      .replace(/^(\s*)listen\s+80;/gm, `$1listen ${NG_HTTP};`)
      .replace(/^(\s*)listen\s+443 ssl;/gm, `$1listen ${NG_HTTPS} ssl;`);
    writeFileSync(p, after);
  }
}
function writeWrapperConf() {
  mkdirSync(P("logs"), { recursive: true });
  mkdirSync(P("temp"), { recursive: true }); // nginx creates the leaf temp dirs under here
  // Mirrors docker/nginx.conf's http{} contract (shared zones + the geoip/banned includes
  // that define $nginux_allowed_country and $nginux_banned) but with harness-local paths
  // and NO load_module lines (test hosts are plain HTTP, no stream/geoip2 modules needed).
  writeFileSync(P("nginx.conf"), `
worker_processes 1;
daemon off;
pid ${P("logs", "nginx.pid")};
error_log ${P("logs", "error.log")} crit;
events { worker_connections 128; }
http {
    access_log off;
    client_body_temp_path ${P("temp", "body")};
    proxy_temp_path ${P("temp", "proxy")};
    fastcgi_temp_path ${P("temp", "fastcgi")};
    uwsgi_temp_path ${P("temp", "uwsgi")};
    scgi_temp_path ${P("temp", "scgi")};
    limit_req_zone $binary_remote_addr zone=nginux_per_ip:10m rate=10r/s;
    limit_conn_zone $binary_remote_addr zone=nginux_conn:10m;
    include ${P("geoip.conf")};
    include ${P("banned.conf")};
    server { listen ${NG_HTTP} default_server; server_name _; return 444; }
    include ${P("conf.d")}/*.conf;
}
`);
}

after(async () => {
  if (SKIP) return;
  await nginxCtl(["-s", "stop"]);
  await sleep(400);
  if (nginx?.pid && nginx.exitCode === null) {
    try {
      if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(nginx.pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(-nginx.pid, "SIGKILL");
    } catch { /* already gone */ }
  }
  for (const s of echoServers) s.close();
  try { await app?.close(); } catch { /* ignore */ }
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ===========================================================================
// CORE INVARIANTS — the app's promise, proven through real nginx.
// ===========================================================================

// Guard: in CI (NGINUX_REQUIRE_NGINX=1) a missing nginx is a HARD FAILURE, not a silent
// skip — otherwise this whole security suite could no-op to green and prove nothing.
test("nginx binary is available (hard-required in CI)", { skip: SKIP && !REQUIRE_NGINX }, () => {
  assert.ok(!SKIP, `NGINUX_REQUIRE_NGINX=1 but no nginx found (NGINUX_NGINX_BIN=${process.env.NGINUX_NGINX_BIN ?? "<unset>"})`);
});

test("C1  unauthenticated request to a login-gated host never reaches the backend", { skip: SKIP }, async () => {
  const r = await via("plex.example.com", { path: "/dashboard" });
  assertDenied(r, [302, 401], "unauth on gated host");
  assert.ok(r.location?.startsWith(`${SSO}/login?rd=`), `should 302 to the SSO login (got location=${r.location})`);
});

test("C2  a valid session reaches the backend (positive control — gate isn't deny-all)", { skip: SKIP }, async () => {
  assertAllowed(await via("plex.example.com", { cookie: cookies.admin }), "valid admin session on gated host");
});

test("C3  require2fa host denies a session without 2FA", { skip: SKIP }, async () => {
  assertDenied(await via("vault.example.com", { cookie: cookies.editor }), [302, 401], "no-2FA session on require2fa host");
});

test("C4  require2fa host allows a 2FA-enrolled session (positive control)", { skip: SKIP }, async () => {
  assertAllowed(await via("vault.example.com", { cookie: cookies.manager2fa }), "2FA session on require2fa host");
});

test("C5  scoped user is denied a host outside their scope (403, not a login redirect)", { skip: SKIP }, async () => {
  assertDenied(await via("ha.example.com", { cookie: cookies.scoped }), [403], "scoped user out of scope");
});

test("C6  scoped user reaches a host inside their scope (positive control)", { skip: SKIP }, async () => {
  assertAllowed(await via("photos.example.com", { cookie: cookies.scoped }), "scoped user in scope");
});

test("C6b a client X-Forwarded-Host cannot spoof scope — the real Host is authoritative", { skip: SKIP }, async () => {
  // Scoped user hits an OUT-of-scope host but forges X-Forwarded-Host of an in-scope one.
  // nginx stamps X-Original-Host=$host (the real host) and the handler prefers it, so the
  // spoof is ignored and the request is denied. Guards a header-confusion scope escalation.
  assertDenied(await via("ha.example.com", { cookie: cookies.scoped, headers: { "X-Forwarded-Host": "photos.example.com" } }),
    [403], "X-Forwarded-Host spoof of an in-scope host");
});

test("C7  THE RECURRENCE — uppercase-stored host stays gated (unauth) AND resolves (session)", { skip: SKIP }, async () => {
  // nginx lowercases $host; the fail-open risk lived in the case-sensitive DB lookup.
  assertDenied(await via("cased.example.com"), [302, 401], "uppercase host, no session");
  assertDenied(await via("CASED.EXAMPLE.COM"), [302, 401], "uppercase Host header, no session");
  // Positive: a valid session must RESOLVE the uppercase-stored host and pass. If the
  // case-insensitive lookup regressed, this host would be unresolvable -> fail closed ->
  // this legitimate request would wrongly 401. That is what uniquely locks the fix.
  assertAllowed(await via("cased.example.com", { cookie: cookies.admin }), "uppercase host resolves for a valid session");
});

test("C8  THE RECURRENCE — wildcard host gates a concrete subdomain AND resolves it", { skip: SKIP }, async () => {
  assertDenied(await via("foo.apps.example.com"), [302, 401], "wildcard subdomain, no session");
  assertAllowed(await via("foo.apps.example.com", { cookie: cookies.admin }), "wildcard fallback resolves for a valid session");
  // A 2-level-deep miss (only *.apps.example.com exists) resolves to nothing -> fail
  // closed even WITH a valid session (single-level wildcard fallback, by design).
  assertDenied(await via("bar.foo.apps.example.com", { cookie: cookies.admin }), [302, 401], "2-level-deep miss fails closed");
});

test("C9  unknown/unresolvable host fails closed at the forward-auth endpoint (root-cause guarantee)", { skip: SKIP }, async () => {
  // Direct control-plane probe with the correct secret + a VALID session, isolating host
  // resolution: any X-Original-Host that maps to no row must deny, never fall through to
  // 200. This is the entire "per-host check silently skipped" class, closed at the root.
  const r = await rawGet({ port: CP_PORT, host: "127.0.0.1", path: "/api/auth/forward",
    headers: { "X-NginUX-Forward-Secret": SECRET, "X-Original-Host": "no-such-host.example.com", Cookie: cookies.admin } });
  assert.equal(r.status, 401, "gated request for an unknown host must be denied at the control plane, never 200");
});

test("C9b forward-auth rejects a wrong or absent shared secret (nginx↔control-plane trust)", { skip: SKIP }, async () => {
  // The shared secret is the only thing stopping a direct call to the OPEN /api/auth/forward
  // path from impersonating nginx. A valid session + a wrong (or missing) secret must fail.
  const wrong = await rawGet({ port: CP_PORT, host: "127.0.0.1", path: "/api/auth/forward",
    headers: { "X-NginUX-Forward-Secret": "not-the-secret", "X-Original-Host": "plex.example.com", Cookie: cookies.admin } });
  assert.equal(wrong.status, 401, "a wrong forward secret must be rejected");
  const absent = await rawGet({ port: CP_PORT, host: "127.0.0.1", path: "/api/auth/forward",
    headers: { "X-Original-Host": "plex.example.com", Cookie: cookies.admin } });
  assert.equal(absent.status, 401, "an absent forward secret must be rejected (a secret IS configured)");
});

test("C10 a mustChangePassword (default-credential) session is confined — no backend access", { skip: SKIP }, async () => {
  assertDenied(await via("plex.example.com", { cookie: cookies.tempPw }), [302, 401], "temp-password session");
});

test("C11 a manager owing 2FA enrollment is confined downstream (require2faForManagers)", { skip: SKIP }, async () => {
  // Org-wide 2FA policy is enforced on the DATA plane, not just the control-plane UI: a
  // manager who still owes enrollment cannot reach any backend until enrolled.
  saveSettings({ require2faForManagers: true });
  try {
    assertDenied(await via("plex.example.com", { cookie: cookies.editor }), [302, 401], "manager owing 2FA enrollment");
  } finally {
    saveSettings({ require2faForManagers: false }); // restore so later cases (admin sessions) still pass
  }
});

test("C12 a global IP ban returns 403 even on a host whose ipAllow admits that IP", { skip: SKIP }, async () => {
  const banHost = "banhost.example.com";
  // Baseline: ipAllow includes 127.0.0.1, host is not login-gated -> reachable.
  assertAllowed(await via(banHost), "ipAllow admits the client before any ban");
  // Ban the client IP directly (bypass addBan's debounced applyConfig, which would
  // regenerate + clobber the port-remap) and reload nginx to pick up banned.conf.
  db.prepare("INSERT INTO bans (ip, reason, source, createdAt, expiresAt) VALUES (?,?,?,?,?)")
    .run("127.0.0.1", "itest", "manual", new Date().toISOString(), null);
  writeBannedConf();
  await nginxCtl(["-s", "reload"]);
  try {
    await waitUntil(async () => (await via(banHost)).status === 403, 10_000, "ban to take effect");
    assertDenied(await via(banHost), [403], "banned IP even though ipAllow lists it");
  } finally {
    // ALWAYS lift the ban — every probe originates from 127.0.0.1, so a leaked ban would
    // 403 every later test. Runs even if the assertion above throws.
    db.prepare("DELETE FROM bans WHERE ip = ?").run("127.0.0.1");
    writeBannedConf();
    await nginxCtl(["-s", "reload"]);
    await waitUntil(async () => (await via(banHost)).status === 200, 10_000, "ban to lift").catch(() => {});
  }
});

test("C13 a login-gated path route does not bypass the gate (sibling location carries auth)", { skip: SKIP }, async () => {
  // The longer-prefix `location /grafana` must replicate auth_request; nginx does not
  // inherit location-scoped directives across siblings.
  const r = await via("pathhost.example.com", { path: "/grafana", cookie: undefined });
  assertDenied(r, [302, 401], "unauth on a gated path route");
  // And it IS reachable with a valid session (proves the route otherwise works).
  assertAllowed(await via("pathhost.example.com", { path: "/grafana", cookie: cookies.admin }), "valid session on the path route");
});

test("C14 the gate holds inside a real `listen 443 ssl` block (TLS, not just plain HTTP)", { skip: SKIP }, async (t) => {
  if (!sslOk) return t.skip("self-signed cert unavailable");
  assertDenied(await viaHttps("secure.example.com"), [302, 401], "unauth over TLS");
  assertAllowed(await viaHttps("secure.example.com", { cookie: cookies.admin }), "valid session over TLS");
});

test("C15 the ssl host's :80 redirect server 301s to HTTPS and does NOT proxy to the backend", { skip: SKIP }, async (t) => {
  if (!sslOk) return t.skip("self-signed cert unavailable");
  // The bare `listen 80` server for an ssl host must only redirect — never carry
  // auth_request/proxy_pass — so it can't become an unauthenticated backdoor to the app.
  const r = await via("secure.example.com");
  assert.equal(r.status, 301, "the :80 server must 301 to HTTPS");
  assert.equal(r.reachedUpstream, false, "the :80 redirect server must NOT reach the backend");
  assert.ok(r.location?.startsWith("https://secure.example.com"), `should redirect to https (got ${r.location})`);
});

// A control that is easy to overlook: a NON-gated host must serve freely (so a DENY
// elsewhere means the gate, not a broken upstream).
test("sanity  a non-login host serves the upstream with no session", { skip: SKIP }, async () => {
  assertAllowed(await via("open.example.com"), "non-gated host");
});

// ===========================================================================
// ASPIRATIONAL — the 3 DEFERRED data-plane items. Expected to FAIL against current
// code, so they are TODO/skip and must be un-skipped only when the item is fixed.
// ===========================================================================

test("A1  [deferred] nginux_session cookie is stripped before proxy_pass to the backend", { skip: true }, async () => {
  const r = await via("plex.example.com", { cookie: `${cookies.admin}; other=x` });
  assert.ok(!/nginux_session=/.test(r.body), "backend must not receive the NginUX session cookie");
});
test("A2  [deferred] L4/stream proxies enforce bans + country-lock", { skip: true }, () => {
  assert.fail("stream-scope $nginux_banned/geo enforcement not implemented");
});
test("A3  [deferred] customNginx add_header must not shadow managed security headers", { skip: true }, () => {
  assert.fail("managed security headers can be shadowed by a location-scope add_header");
});
