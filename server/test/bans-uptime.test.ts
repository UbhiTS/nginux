// Two robustness invariants surfaced by the audit:
//  - the auto-ban engine must exempt LAN/loopback (a family member fat-fingering a
//    password must not self-ban their device from every proxied service for 24h);
//  - the uptime monitor must DEBOUNCE (a single failed probe is a blip, not an
//    outage) - it only declares "down" after consecutive failures, and recovers
//    immediately on one good probe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTestEnv, makeHost } from "./helpers.ts";

setupTestEnv();
const { isLocalIp, addBan, listBans, removeBan } = await import("../src/bans.ts");
const { recordCheck, httpProbe } = await import("../src/uptime.ts");
const { createHost, getHost, updateHost } = await import("../src/repo.ts");
const http = await import("node:http");

// -------------------------------------------------------------------------
// 1. isLocalIp - the auto-ban exemption predicate (regression: finding).
// -------------------------------------------------------------------------
test("isLocalIp flags loopback, private LAN, link-local and ULA (auto-ban must skip these)", () => {
  for (const ip of [
    "127.0.0.1", "::1", "::ffff:127.0.0.1",
    "10.0.0.5", "192.168.1.66", "172.16.0.1", "172.31.255.254",
    "169.254.10.10", "fe80::1", "fc00::1", "fd12:3456::9",
    "::ffff:192.168.1.9", // IPv4-mapped IPv6 must be unwrapped and matched
  ]) {
    assert.equal(isLocalIp(ip), true, `${ip} must be treated as local (exempt from auto-ban)`);
  }
});

test("isLocalIp does NOT flag public / out-of-range addresses (they remain bannable)", () => {
  for (const ip of [
    "203.0.113.5", "8.8.8.8", "1.1.1.1",
    "172.15.0.1", "172.32.0.1", // just outside the 172.16.0.0/12 private block
    "2606:4700::1111",          // public IPv6
  ]) {
    assert.equal(isLocalIp(ip), false, `${ip} must NOT be treated as local`);
  }
});

// -------------------------------------------------------------------------
// 2. addBan / listBans / removeBan round-trip (the deny-list source of truth).
// -------------------------------------------------------------------------
test("addBan then removeBan round-trips through the ban list", () => {
  addBan("203.0.113.77", "manual test", "manual");
  assert.ok(listBans().some((b) => b.ip === "203.0.113.77"), "the ban must appear in the list");
  assert.equal(removeBan("203.0.113.77"), true, "removeBan reports success");
  assert.ok(!listBans().some((b) => b.ip === "203.0.113.77"), "the ban must be gone after removal");
});

// -------------------------------------------------------------------------
// 3. Uptime debounce/hysteresis (regression: finding). One failed probe must
//    NOT open an incident; two consecutive do; one good probe recovers at once.
// -------------------------------------------------------------------------
test("recordCheck debounces a single failed probe and recovers immediately on success", () => {
  const svc = createHost(makeHost({ id: "uptime-svc", name: "uptime", domain: "uptime.example.com", health: "online" }));

  // A single blip must not flip the service to "down".
  recordCheck(svc.id, false, 0);
  assert.equal(getHost(svc.id)?.health, "online", "one failed probe is a blip, not an outage");

  // A second consecutive failure crosses the threshold → declared down.
  recordCheck(svc.id, false, 0);
  assert.equal(getHost(svc.id)?.health, "down", "two consecutive failures must declare the service down");

  // One good probe recovers immediately (fast to say 'up' is harmless).
  recordCheck(svc.id, true, 25);
  assert.equal(getHost(svc.id)?.health, "online", "a single good probe must restore online status");

  // The streak resets, so the next lone failure is again just a blip.
  recordCheck(svc.id, false, 0);
  assert.equal(getHost(svc.id)?.health, "online", "the fail streak must reset after recovery");
});

// -------------------------------------------------------------------------
// 4. HTTP(S) health checks (feature 4.3): probe the app, not just the port.
// -------------------------------------------------------------------------
test("healthCheck fields round-trip through create + update", () => {
  const svc = createHost(makeHost({ id: "hc-svc", name: "hc", domain: "hc.example.com" }));
  assert.equal(svc.healthCheckType, "tcp", "defaults to a TCP probe");
  const up = updateHost(svc.id, { healthCheckType: "http", healthCheckPath: "/healthz", healthCheckStatus: 204 });
  assert.equal(up?.healthCheckType, "http");
  assert.equal(up?.healthCheckPath, "/healthz");
  assert.equal(up?.healthCheckStatus, 204);
});

test("httpProbe reports up on the expected status and down otherwise", async () => {
  // A tiny local server whose status is driven by the request path.
  const server = http.createServer((req, res) => {
    if (req.url === "/ok") { res.statusCode = 200; res.end("ok"); }
    else if (req.url === "/created") { res.statusCode = 201; res.end("created"); }
    else { res.statusCode = 500; res.end("boom"); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    // expectStatus 0 = accept any 2xx/3xx.
    assert.equal((await httpProbe("http", "127.0.0.1", port, "/ok", 0, 2000)).up, true, "200 is up");
    assert.equal((await httpProbe("http", "127.0.0.1", port, "/boom", 0, 2000)).up, false, "500 is down");
    // An exact expected status.
    assert.equal((await httpProbe("http", "127.0.0.1", port, "/created", 201, 2000)).up, true, "201 matches expect 201");
    assert.equal((await httpProbe("http", "127.0.0.1", port, "/ok", 201, 2000)).up, false, "200 fails expect 201");
    // An unreachable port is down (connection refused), not a throw.
    assert.equal((await httpProbe("http", "127.0.0.1", 1, "/", 0, 1000)).up, false, "connection refused is down");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
