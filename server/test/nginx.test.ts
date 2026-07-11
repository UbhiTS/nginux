// nginx config generation - the security-critical output surface. Several HIGH
// fixes live here (per-path protection replication, forward-secret redaction,
// maintenance-name escaping, ACME-before-redirect), so this is a regression pin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHost, setupTestEnv } from "./helpers.ts";

setupTestEnv();
const { generateHostConfig, generateStreamConfig, generateSniPassthrough, redactConfig } =
  await import("../src/nginx.ts");
const { saveSettings } = await import("../src/db.ts");

// Slice out the `location <path> { ... }` block. Path locations are emitted as
// siblings of `location / {` (which always follows them), so bounding at the
// next `location / {` captures the whole block including its inline `{ ... }`.
function pathBlock(conf: string, path: string): string {
  const start = conf.indexOf(`location ${path} {`);
  assert.notEqual(start, -1, `no "location ${path}" block found`);
  const end = conf.indexOf("location / {", start);
  assert.notEqual(end, -1, `no terminating "location /" after ${path}`);
  return conf.slice(start, end);
}

// --- 1. REGRESSION: per-path routes must replicate every server-level guard ---
// A longer-prefix `location /grafana` wins over `location /`, and nginx does NOT
// inherit location-scoped directives across sibling locations. If the login gate,
// country lock, rate limit, or bandwidth cap is missing from the path block, the
// path silently bypasses it (the exact HIGH bug that was fixed). Do not weaken.
test("per-path route replicates login gate, country lock, rate + bandwidth limits", () => {
  const conf = generateHostConfig(makeHost({
    id: "grafana", requireLogin: true, countryLock: true,
    rateLimit: true, rateLimitRps: 5, rateLimitBurst: 10, rateLimitKbps: 500,
    pathRules: "/grafana 192.168.1.70:3000",
  }));
  const block = pathBlock(conf, "/grafana");
  for (const needle of [
    "auth_request /__nginux_auth;",   // login gate replicated
    "$nginux_allowed_country = 0",    // country lock replicated
    "limit_req zone=",                // request-rate limit replicated
    "limit_rate 500k;",               // bandwidth cap replicated
  ]) {
    assert.ok(block.includes(needle), `path route bypasses guard - missing "${needle}" in /grafana block`);
  }
  // Sanity: the path proxies to its own backend, not the default upstream.
  assert.ok(block.includes("proxy_pass http://192.168.1.70:3000;"), "path route must proxy to its backend");
});

// --- 2. auth_request present iff requireLogin ---
test("auth_request appears only when requireLogin is on", () => {
  const on = generateHostConfig(makeHost({ requireLogin: true }));
  assert.ok(on.includes("auth_request /__nginux_auth;"), "login gate must be present when requireLogin");
  assert.ok(on.includes("location = /__nginux_auth {"), "internal auth location must be present when requireLogin");

  const off = generateHostConfig(makeHost({ requireLogin: false }));
  assert.ok(!off.includes("auth_request"), "no auth_request when requireLogin is off");
});

// --- 3. country-lock `if` present iff countryLock ---
test("country-lock guard appears only when countryLock is on", () => {
  const on = generateHostConfig(makeHost({ countryLock: true }));
  assert.ok(on.includes("if ($nginux_allowed_country = 0)"), "country lock must be present when countryLock");

  const off = generateHostConfig(makeHost({ countryLock: false }));
  assert.ok(!off.includes("$nginux_allowed_country"), "no country-lock guard when countryLock is off");
});

// --- 4. SSL: :80 block redirects to https AND serves ACME before the redirect ---
test("ssl host has a :80 server that serves ACME then 301-redirects to https", () => {
  const conf = generateHostConfig(makeHost({ ssl: true }));
  const i80 = conf.indexOf("listen 80;");
  const i443 = conf.indexOf("listen 443");
  assert.notEqual(i80, -1, "expected a listen 80 server block");
  assert.notEqual(i443, -1, "expected a listen 443 server block");
  assert.ok(i80 < i443, ":80 redirect block must precede the :443 block");
  const block80 = conf.slice(i80, i443);
  // ACME challenge is served straight off :80, BEFORE the HTTPS redirect, so
  // Let's Encrypt HTTP-01 validation never bounces to https and never breaks.
  assert.ok(
    block80.includes("location ^~ /.well-known/acme-challenge/"),
    "ACME challenge location must live in the :80 block",
  );
  assert.ok(block80.includes("return 301 https://"), ":80 must redirect to https");
  // The redirect must be inside `location /`, not a bare server-level return that
  // would swallow the ACME challenge above it.
  const iAcme = block80.indexOf("acme-challenge");
  const iRedirect = block80.indexOf("return 301 https://");
  assert.ok(iAcme < iRedirect, "ACME location must come before the redirect");
});

// --- 5. REGRESSION: forward-auth secret is baked in but redacted for previews ---
// The shared forward-auth secret is injected as an nginx header value. The config
// preview (REST + read-scoped get_service_config tool) must not hand it to a
// non-admin / low-scope caller. redactConfig() masks it; the raw generator keeps
// it so nginx actually authenticates the subrequest.
test("forward secret is present in raw config but masked by redactConfig", () => {
  const secret = "deadbeefcafebabe0123456789abcdef";
  saveSettings({ ssoForwardSecret: secret });
  const conf = generateHostConfig(makeHost({ requireLogin: true }));
  assert.ok(conf.includes(secret), "raw config must carry the forward secret so auth works");
  assert.ok(conf.includes(`X-NginUX-Forward-Secret "${secret}"`), "secret is set as the forward-auth header");

  const safe = redactConfig(conf);
  assert.ok(!safe.includes(secret), "redacted config must NOT leak the forward secret");
  assert.ok(
    safe.includes('X-NginUX-Forward-Secret "********"'),
    "redacted config must show the masked placeholder",
  );
});

// --- 6. server_name is the host domain ---
test("server_name is the host domain", () => {
  const conf = generateHostConfig(makeHost({ domain: "app.example.com" }));
  assert.ok(conf.includes("server_name app.example.com;"), "server_name must be the host domain");
});

// --- 7. REGRESSION: maintenance-mode reflects the service name into HTML, escaped ---
// The name is rendered into the 503 maintenance page. Without escaping, a name
// like `<script>...` is a stored XSS on the served page (and the raw quote would
// also break out of the nginx single-quoted string). Escaping neutralises both.
// Scope the check to the SERVED HTML body: the leading `# Managed by NginUX`
// comment legitimately echoes the raw name, but a config comment is never a
// browser/HTML context - the XSS-relevant invariant is that the RETURNED page is
// escaped, which is what we pin here.
test("maintenance mode HTML-escapes the service name (no XSS in the 503 page)", () => {
  const conf = generateHostConfig(makeHost({ maintenanceMode: true, name: "<script>x" }));
  const start = conf.indexOf("return 503 '");
  assert.notEqual(start, -1, "expected a maintenance 503 return");
  const bodyStart = start + "return 503 '".length;
  const end = conf.indexOf("';", bodyStart);
  assert.notEqual(end, -1, "expected the 503 return string to be terminated");
  const html = conf.slice(bodyStart, end);
  assert.ok(!html.includes("<script>"), "served maintenance HTML must not contain a raw <script> tag");
  assert.ok(html.includes("&lt;script&gt;x"), "the name must be HTML-escaped in the maintenance page");
});

// --- 8. stream (TCP) config ---
test("generateStreamConfig emits a listen + proxy_pass for a TCP service", () => {
  const conf = generateStreamConfig(makeHost({
    protocol: "tcp", listenPort: 9000, forwardHost: "192.168.1.9", forwardPort: 9000,
  }));
  assert.ok(conf.includes("listen 9000;"), "stream must listen on the configured port");
  assert.ok(conf.includes("proxy_pass 192.168.1.9:9000;"), "stream must proxy_pass to the backend");
  assert.ok(!conf.includes(" udp"), "TCP stream must not carry the udp flag");
});

// --- 9. SNI passthrough ---
test("generateSniPassthrough enables ssl_preread for TLS-passthrough hosts", () => {
  const conf = generateSniPassthrough([makeHost({ protocol: "sni", listenPort: 443 })]);
  assert.ok(conf.includes("ssl_preread on;"), "SNI passthrough must enable ssl_preread");
  assert.ok(conf.includes("listen 443;"), "SNI passthrough must listen on the configured port");
});
