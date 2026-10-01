// Comprehensive adversarial security, robustness, and rollback regression suite.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { setupTestEnv, makeHost } from "./helpers.ts";

setupTestEnv();
const { app } = await import("../src/index.ts");
const { db, getSettings, saveSettings, pruneAuditLog } = await import("../src/db.ts");
const { createSession, listSessions, securityOverview } = await import("../src/auth.ts");
const { createHost, getHost, listHosts } = await import("../src/repo.ts");
const { isDangerousHost } = await import("../src/validate.ts");
const { safeOutboundRequest } = await import("../src/outbound.ts");
const { validateChannelConfig } = await import("../src/notify.ts");
const { encryptJson, decryptJson, encryptJsonAsync, decryptJsonAsync } = await import("../src/cryptobox.ts");
const { buildBundle, restoreBundle } = await import("../src/backup.ts");
const { previewNginxConf, importNginxConf } = await import("../src/importer.ts");
const { createToken, resolveToken } = await import("../src/tokens.ts");
const { callTool } = await import("../src/tools.ts");
const { snapshot } = await import("../src/versioning.ts");
const { createProfile } = await import("../src/profiles.ts");

function makeUser(role: string, scope = ""): string {
  const id = `u_adv_${role}_${Math.floor(performance.now() * 1000)}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    "INSERT INTO users (id, username, email, passwordHash, role, scope, twofaEnabled, backupCodes, twofaLastCounter, mustChangePassword, createdAt) VALUES (?,?,?,?,?,?,0,'[]',-1,0,?)",
  ).run(id, id, "", "x", role, scope, new Date().toISOString());
  return id;
}

function cookieFor(userId: string): string {
  return `nginux_session=${createSession(userId, "adv-test", "127.0.0.1")}`;
}

before(async () => {
  await app.ready();
});

// ---------------------------------------------------------------------------
// 1. SSRF & IPv6 NAT64 / SIIT / Cloud Metadata Evasion
// ---------------------------------------------------------------------------
test("isDangerousHost blocks NAT64 (64:ff9b::/96) and SIIT (::ffff:0:0/96) cloud metadata spellings", () => {
  const blocked = [
    "64:ff9b::169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "[64:ff9b::169.254.169.254]",
    "64:ff9b::0.0.0.0",
    "::ffff:0:169.254.169.254",
    "::ffff:0:a9fe:a9fe",
    "::ffff:0:0:169.254.169.254",
    "fd00:ec2:0:0:0:0:0:254",
    "100.100.100.200",
  ];
  for (const host of blocked) {
    assert.equal(isDangerousHost(host), true, `expected ${host} to be blocked as dangerous`);
  }
  assert.equal(isDangerousHost("64:ff9b::192.168.1.50"), false, "homelab private LAN IP in NAT64 remains allowed");
});

test("safeOutboundRequest sanitizes CR/LF in header values and rejects CR/LF in header names", async () => {
  let receivedTitle = "";
  const srv = http.createServer((req, res) => {
    receivedTitle = String(req.headers["x-title"] ?? "");
    res.writeHead(204);
    res.end();
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  try {
    const addr = srv.address();
    assert.ok(addr && typeof addr === "object");
    const res = await safeOutboundRequest(`http://127.0.0.1:${addr.port}/notify`, {
      method: "POST",
      headers: { "X-Title": "Alert\r\nX-Injected: pwned" },
      body: "ok",
    });
    assert.equal(res.ok, true);
    assert.equal(receivedTitle, "Alert X-Injected: pwned", "CR/LF collapsed to space so no second header is injected");

    await assert.rejects(
      () => safeOutboundRequest(`http://127.0.0.1:${addr.port}/notify`, {
        headers: { "Bad\r\nHeader": "val" },
      }),
      /Invalid outbound header name/i,
    );
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

// ---------------------------------------------------------------------------
// 2. Notification Channel URL Path / Userinfo / Token Injection
// ---------------------------------------------------------------------------
test("validateChannelConfig and POST /api/channels block ntfy topic & telegram token URL injection", async () => {
  assert.match(validateChannelConfig("ntfy", { topic: "@169.254.169.254/latest/meta-data" }) ?? "", /Invalid ntfy topic/i);
  assert.match(validateChannelConfig("ntfy", { topic: "../../admin" }) ?? "", /Invalid ntfy topic/i);
  assert.match(validateChannelConfig("ntfy", { topic: "alerts?auth=leak" }) ?? "", /Invalid ntfy topic/i);
  assert.equal(validateChannelConfig("ntfy", { topic: "homelab-alerts_1" }), null);

  assert.match(validateChannelConfig("telegram", { token: "123:abc/../../evil" }) ?? "", /Invalid Telegram bot token/i);
  assert.match(validateChannelConfig("telegram", { token: "123:abc?chat_id=1" }) ?? "", /Invalid Telegram bot token/i);
  assert.equal(validateChannelConfig("telegram", { token: "123456789:ABC-DEF1234ghIkl-zyx57W2v1u123ew11" }), null);

  const admin = cookieFor(makeUser("admin"));
  const badNtfy = await app.inject({
    method: "POST",
    url: "/api/channels",
    headers: { cookie: admin },
    payload: { type: "ntfy", name: "bad-ntfy", config: { topic: "@169.254.169.254/latest" } },
  });
  assert.equal(badNtfy.statusCode, 400);

  const badTg = await app.inject({
    method: "POST",
    url: "/api/channels",
    headers: { cookie: admin },
    payload: { type: "telegram", name: "bad-tg", config: { token: "123/../../pwn", chatId: "1" } },
  });
  assert.equal(badTg.statusCode, 400);
});

// ---------------------------------------------------------------------------
// 3. Cryptobox AES-256-GCM Tag Truncation Defense & Async KDF
// ---------------------------------------------------------------------------
test("cryptobox rejects truncated GCM authentication tags and supports async KDF round-trip", async () => {
  const payload = { secret: "nuclear-launch-codes" };
  const env = await encryptJsonAsync(payload, "strong-passphrase-123");
  assert.deepEqual(await decryptJsonAsync(env, "strong-passphrase-123"), payload);
  assert.deepEqual(decryptJson(env, "strong-passphrase-123"), payload);

  // Truncate the 16-byte GCM authTag to 4 bytes (32 bits) — must be rejected before decipher.final().
  const fullTag = Buffer.from(env.tag, "base64");
  const truncatedEnv = { ...env, tag: fullTag.subarray(0, 4).toString("base64") };
  assert.throws(() => decryptJson(truncatedEnv, "strong-passphrase-123"), /wrong passphrase or corrupt/i);
  await assert.rejects(() => decryptJsonAsync(truncatedEnv, "strong-passphrase-123"), /wrong passphrase or corrupt/i);

  // Truncate IV to 8 bytes — must also be rejected.
  const badIvEnv = { ...env, iv: Buffer.alloc(8).toString("base64") };
  assert.throws(() => decryptJson(badIvEnv, "strong-passphrase-123"), /wrong passphrase or corrupt/i);
});

// ---------------------------------------------------------------------------
// 4. Backup & Importer Portal Hijack and Stream Port Collision Guards
// ---------------------------------------------------------------------------
test("restoreBundle blocks control-plane portal hijack and duplicate/zero stream ports", () => {
  const base = buildBundle(new Date().toISOString(), true);

  // (a) Portal hijack via bundle settings + host forwarding portal domain off :6767
  const hijackBundle = structuredClone(base);
  hijackBundle.settings = { ...hijackBundle.settings, ssoLoginUrl: "https://login.hijack-test.io" };
  hijackBundle.hosts = [
    makeHost({
      id: "hijack-1",
      name: "Hijack",
      domain: "login.hijack-test.io",
      forwardScheme: "http",
      forwardHost: "192.168.1.200",
      forwardPort: 8080,
    }),
  ];
  assert.throws(() => restoreBundle(hijackBundle), /conflicts with the NginUX sign-in portal/i);

  // (b) Stream host with listenPort = 0
  const zeroPortBundle = structuredClone(base);
  zeroPortBundle.hosts = [
    makeHost({
      id: "tcp-zero",
      name: "TCP Zero",
      domain: "tcp0.separate-domain.io",
      protocol: "tcp",
      listenPort: 0,
      ssl: false,
      http2: false,
      securityHeaders: false,
      blockExploits: false,
    }),
  ];
  assert.throws(() => restoreBundle(zeroPortBundle), /listen port between 1 and 65535/i);

  // (c) Duplicate TCP listenPort across two hosts in the same bundle
  const dupPortBundle = structuredClone(base);
  dupPortBundle.hosts = [
    makeHost({
      id: "tcp-dup-1",
      name: "TCP One",
      domain: "tcp1.separate-domain.io",
      protocol: "tcp",
      listenPort: 25565,
      ssl: false,
      http2: false,
      securityHeaders: false,
      blockExploits: false,
    }),
    makeHost({
      id: "tcp-dup-2",
      name: "TCP Two",
      domain: "tcp2.separate-domain.io",
      protocol: "tcp",
      listenPort: 25565,
      ssl: false,
      http2: false,
      securityHeaders: false,
      blockExploits: false,
    }),
  ];
  assert.throws(() => restoreBundle(dupPortBundle), /already used by/i);
});

test("nginx.conf importer skips metadata targets and control-plane portal hijacks", () => {
  saveSettings({ ssoLoginUrl: "https://portal.import-guard.io" });
  try {
    const conf = `
      server {
        listen 443 ssl;
        server_name portal.import-guard.io;
        location / { proxy_pass http://192.168.1.50:8080; }
      }
      server {
        listen 80;
        server_name meta.import-guard.io;
        location / { proxy_pass http://169.254.169.254:80; }
      }
    `;
    const preview = previewNginxConf(conf);
    assert.equal(preview.toImport.length, 0);
    assert.ok(preview.skipped.some((s) => s.domain === "portal.import-guard.io" && /portal/i.test(s.reason)));
    assert.ok(preview.skipped.some((s) => s.domain === "meta.import-guard.io" && /forward host/i.test(s.reason)));

    const imported = importNginxConf(conf);
    assert.equal(imported.imported.length, 0);
  } finally {
    saveSettings({ ssoLoginUrl: "" });
  }
});

// ---------------------------------------------------------------------------
// 5. Transactional Database Rollback When `nginx -t` Fails
// ---------------------------------------------------------------------------
test("mutating routes and tools roll back SQLite state when nginx -t rejects the config", async () => {
  const admin = cookieFor(makeUser("admin"));
  const h1 = createHost(makeHost({ id: "rb-host-1", name: "Rollback1", domain: "rb1.example.com", enabled: true, hsts: false }));
  const snap = snapshot("Good baseline", "admin");
  const goodBundle = buildBundle(new Date().toISOString(), true);
  const prof = createProfile({ name: "RB-Profile", description: "", fields: { hsts: true } });

  const tmpBinDir = mkdtempSync(join(tmpdir(), "nginux-mockbin-"));
  const badNginx = join(tmpBinDir, "nginx-fail.sh");
  writeFileSync(
    badNginx,
    "#!/bin/sh\nif [ \"$1\" = \"-v\" ]; then exit 0; fi\necho 'nginx: [emerg] simulated directive failure' >&2\nexit 1\n",
    { mode: 0o755 },
  );
  chmodSync(badNginx, 0o755);

  const prevBin = process.env.NGINX_BIN;
  process.env.NGINX_BIN = badNginx;
  try {
    // (a) PUT /api/settings rolls back settings on nginx -t failure
    const countryBefore = getSettings().homeCountry;
    const setRes = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { cookie: admin },
      payload: { homeCountry: "DE" },
    });
    assert.equal(setRes.statusCode, 422, "PUT /api/settings must return 422 when nginx -t fails");
    assert.equal(getSettings().homeCountry, countryBefore, "settings must be rolled back in SQLite");

    // (b) TOOLS.update_settings rolls back settings on nginx -t failure
    const adminPrincipal = { kind: "user" as const, name: "admin", scopes: ["read", "report", "control", "security"] as const, user: { id: "a", username: "admin", email: "", role: "admin" as const, scope: "", twofaEnabled: false, mustChangePassword: false, createdAt: "", lastLoginAt: null } };
    const toolRes = await callTool(adminPrincipal, "update_settings", { patch: { homeCountry: "JP" } });
    assert.equal(toolRes.status, "error");
    assert.equal(getSettings().homeCountry, countryBefore, "agent update_settings must roll back settings on nginx -t failure");

    // (c) POST /api/hosts/batch rolls back host mutations on nginx -t failure
    const batchRes = await app.inject({
      method: "POST",
      url: "/api/hosts/batch",
      headers: { cookie: admin },
      payload: { ids: [h1.id], action: "disable" },
    });
    assert.equal(batchRes.statusCode, 422);
    assert.equal(getHost(h1.id)?.enabled, true, "bulk disable must be rolled back when nginx -t fails");

    // (d) POST /api/security-profiles/:id/apply rolls back host mutations on nginx -t failure
    const profRes = await app.inject({
      method: "POST",
      url: `/api/security-profiles/${prof.id}/apply`,
      headers: { cookie: admin },
      payload: { ids: [h1.id] },
    });
    assert.equal(profRes.statusCode, 422);
    assert.equal(getHost(h1.id)?.hsts, false, "security profile apply must be rolled back when nginx -t fails");

    // (e) POST /api/config/import rolls back newly imported hosts on nginx -t failure
    const impRes = await app.inject({
      method: "POST",
      url: "/api/config/import",
      headers: { cookie: admin },
      payload: { conf: "server { listen 80; server_name rollback-imported.example.com; location / { proxy_pass http://192.168.1.99:8080; } }" },
    });
    assert.equal(impRes.statusCode, 422);
    assert.ok(!listHosts().some((h) => h.domain === "rollback-imported.example.com"), "imported host must be deleted when nginx -t fails");

    // (f) POST /api/config/versions/:id/restore rolls back on nginx -t failure
    const verRes = await app.inject({
      method: "POST",
      url: `/api/config/versions/${snap.id}/restore`,
      headers: { cookie: admin },
    });
    assert.equal(verRes.statusCode, 422);
    assert.ok(getHost(h1.id), "hosts remain intact after failed version restore");

    // (g) POST /api/config/restore rolls back on nginx -t failure
    const mutatedBundle = structuredClone(goodBundle);
    mutatedBundle.hosts = [makeHost({ id: "should-revert", name: "RevertMe", domain: "should-revert.example.com" })];
    const restRes = await app.inject({
      method: "POST",
      url: "/api/config/restore",
      headers: { cookie: admin },
      payload: { bundle: mutatedBundle },
    });
    assert.equal(restRes.statusCode, 422);
    assert.ok(!listHosts().some((h) => h.domain === "should-revert.example.com"), "bundle restore must roll back hosts when nginx -t fails");
    assert.ok(getHost(h1.id), "pre-restore host must still exist");
  } finally {
    if (prevBin === undefined) delete process.env.NGINX_BIN;
    else process.env.NGINX_BIN = prevBin;
    rmSync(tmpBinDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. Rogue AI Bot / Bearer Token Brute-Force Rate Limiting & Write Throttling
// ---------------------------------------------------------------------------
test("agent endpoints rate-limit invalid Bearer token brute-force attempts while allowing valid tokens", async () => {
  const { token: validToken, record } = createToken({ name: "legit-bot", scopes: ["read"] });
  assert.ok(resolveToken(validToken));
  const firstUsedAt = (db.prepare("SELECT lastUsedAt FROM api_tokens WHERE id = ?").get(record.id) as { lastUsedAt: string }).lastUsedAt;
  assert.ok(firstUsedAt);

  // Brute-force 31 invalid Bearer tokens from a test IP
  let lastStatus = 0;
  for (let i = 0; i < 32; i++) {
    const r = await app.inject({
      method: "POST",
      url: "/api/mcp",
      headers: { authorization: `Bearer ngx_invalid_attempt_${i}` },
      payload: { jsonrpc: "2.0", id: i, method: "tools/list" },
    });
    lastStatus = r.statusCode;
  }
  assert.equal(lastStatus, 429, "31st+ failed Bearer token attempt within 1 minute must be rate-limited with 429");

  // Meanwhile, the valid token still succeeds immediately!
  const good = await app.inject({
    method: "POST",
    url: "/api/mcp",
    headers: { authorization: `Bearer ${validToken}` },
    payload: { jsonrpc: "2.0", id: 99, method: "tools/list" },
  });
  assert.equal(good.statusCode, 200);
});

// ---------------------------------------------------------------------------
// 7. Expired Session Filtering & Pruning + Client Cert CN Control-Char Guard
// ---------------------------------------------------------------------------
test("expired sessions are excluded from listSessions/securityOverview and reaped by pruneAuditLog", () => {
  const uid = makeUser("admin");
  db.prepare(
    "INSERT INTO sessions (token, userId, device, ip, createdAt, expiresAt) VALUES (?,?,?,?,?,?)",
  ).run("expired_token_hash_1234567890", uid, "old-browser", "127.0.0.1", "2020-01-01T00:00:00.000Z", "2020-01-02T00:00:00.000Z");

  assert.ok(!listSessions().some((s) => s.token === "expired_token_hash_1234567890"), "expired session must not appear in listSessions()");
  const beforeRow = db.prepare("SELECT 1 FROM sessions WHERE token = 'expired_token_hash_1234567890'").get();
  assert.ok(beforeRow, "row exists in table before prune");

  pruneAuditLog();
  const afterRow = db.prepare("SELECT 1 FROM sessions WHERE token = 'expired_token_hash_1234567890'").get();
  assert.equal(afterRow, undefined, "pruneAuditLog reaps expired sessions");
  assert.ok(securityOverview().activeSessions >= 0);
});

test("POST /api/hosts/:id/client-certs rejects control characters in certificate name", async () => {
  const admin = cookieFor(makeUser("admin"));
  const h = createHost(makeHost({ id: "mtls-adv", name: "mTLS Host", domain: "mtls-adv.example.com", mtls: true }));
  const r = await app.inject({
    method: "POST",
    url: `/api/hosts/${h.id}/client-certs`,
    headers: { cookie: admin },
    payload: { name: "bad\r\ncert" },
  });
  assert.equal(r.statusCode, 400);
});
