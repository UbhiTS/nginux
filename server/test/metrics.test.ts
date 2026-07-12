// Regression tests for the metrics/analytics aggregation pipeline (server/src/metrics.ts).
// This module ingests nginx JSON access-log lines and drives every traffic/analytics
// view + the Prometheus exporter, so its counting must stay exact: request totals,
// the status-class breakdown, and the top-IP/host lists are the numbers the dashboard
// reports. metrics.ts reads NGINX_ACCESS_LOG at import time, so setupTestEnv() (which
// points it at a temp file) MUST run before the dynamic import.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { setupTestEnv } from "./helpers.ts";

setupTestEnv();
const metrics = await import("../src/metrics.ts");

// ---- one fixed corpus of access-log lines, replayed from disk exactly once ----
type Raw = {
  time: string; host: string; method: string; path: string; status: number;
  bytes: number; bytes_in: number; ip: string; country: string; ms: number; ua: string;
};
const A = "a.example.com", B = "b.example.com";
const IP1 = "203.0.113.5", IP2 = "198.51.100.10";
const rows: Raw[] = [
  { time: "2026-01-01T00:00:00+00:00", host: A, method: "GET",  path: "/",  status: 200, bytes: 100, bytes_in: 80, ip: IP1, country: "US", ms: 0.010, ua: "curl" },
  { time: "2026-01-01T00:00:01+00:00", host: A, method: "GET",  path: "/a", status: 200, bytes: 200, bytes_in: 80, ip: IP1, country: "US", ms: 0.020, ua: "curl" },
  { time: "2026-01-01T00:00:02+00:00", host: A, method: "GET",  path: "/b", status: 200, bytes: 300, bytes_in: 80, ip: IP2, country: "CA", ms: 0.030, ua: "curl" },
  { time: "2026-01-01T00:00:03+00:00", host: A, method: "GET",  path: "/c", status: 301, bytes: 150, bytes_in: 80, ip: IP2, country: "CA", ms: 0.040, ua: "curl" },
  { time: "2026-01-01T00:00:04+00:00", host: B, method: "POST", path: "/d", status: 404, bytes: 120, bytes_in: 80, ip: IP1, country: "US", ms: 0.050, ua: "curl" },
  { time: "2026-01-01T00:00:05+00:00", host: B, method: "GET",  path: "/e", status: 500, bytes: 500, bytes_in: 80, ip: IP2, country: "CA", ms: 0.060, ua: "curl" },
];
// The persisted file also carries a non-JSON garbage line and blank lines that the
// ingestion path must skip without ingesting (or crashing).
const fileText = rows.map((r) => JSON.stringify(r)).join("\n") + "\n" + "this-is-not-json{oops" + "\n\n";
writeFileSync(process.env.NGINX_ACCESS_LOG as string, fileText);

const replayed = metrics.replayAccessLog();

// Snapshots captured immediately after the single replay, BEFORE any later test
// ingests fresh (current-time) entries — this keeps the cumulative assertions exact
// and independent of test execution order.
const snap = metrics.summary();
const recent3 = metrics.recentLogs(undefined, 3);
const recentAll = metrics.recentLogs(undefined, 100);
const recentHostB = metrics.recentLogs(B);
const recent500 = metrics.recentLogs("500");
const recentIp1 = metrics.recentLogs(IP1);
const searchIp1 = await metrics.searchLog(IP1);
const promSnap = metrics.prometheus();
const hostTrafficSnap = metrics.hostTraffic("live");
const hostStatsSnap = metrics.hostStats("1h");
const syntheticGlobal = metrics.trafficSeries("1d", "requests"); // window empty of old data → synthetic

// ---------------------------------------------------------------------------
// replayAccessLog + summary()
// ---------------------------------------------------------------------------
test("replayAccessLog ingests every valid line and skips blank/garbage", () => {
  // Return value counts non-empty lines processed (>= the valid lines it ingested).
  assert.ok(replayed >= rows.length, `replayed ${replayed} should be >= ${rows.length} valid lines`);
  // Crucially, ONLY the valid JSON lines are ingested — the garbage + blank lines
  // are dropped, so the request total equals the number of valid lines.
  assert.equal(snap.totalRequests, rows.length);
});

test("summary() reports the correct status-class breakdown + error rate", () => {
  assert.deepEqual(snap.statusClass, { "2xx": 3, "3xx": 1, "4xx": 1, "5xx": 1 });
  assert.equal(snap.errorRate, 33.33); // (4xx + 5xx) / total = 2 / 6
});

test("summary() totals request bytes", () => {
  assert.equal(snap.totalBytes, 1370); // 100+200+300+150+120+500
});

test("summary() top-IP list contains every source IP with correct counts + country label", () => {
  const ips = new Map(snap.topIps.map((t) => [t.key, t]));
  assert.ok(ips.has(IP1), "IP1 must appear in topIps");
  assert.ok(ips.has(IP2), "IP2 must appear in topIps");
  assert.equal(ips.get(IP1)!.count, 3); // lines 1,2,5
  assert.equal(ips.get(IP2)!.count, 3); // lines 3,4,6
  assert.equal(ips.get(IP1)!.country, "US");
  assert.equal(ips.get(IP2)!.country, "CA");
});

test("summary() top-host list is busiest-first with correct counts", () => {
  assert.equal(snap.topHosts[0].key, A);
  assert.equal(snap.topHosts[0].count, 4); // lines 1-4
  assert.equal(snap.topHosts.find((h) => h.key === B)?.count, 2); // lines 5-6
});

test("summary() top-country list carries both countries", () => {
  const cc = new Map(snap.topCountries.map((c) => [c.key, c.count]));
  assert.equal(cc.get("US"), 3);
  assert.equal(cc.get("CA"), 3);
});

// Per-country top-IP grouping (single-pass, replaces the O(countries x IPs) scan).
test("summary() groups the busiest IPs under their OWN country, busiest-first", () => {
  const us = snap.topCountries.find((c) => c.key === "US");
  const ca = snap.topCountries.find((c) => c.key === "CA");
  assert.ok(us?.topIps.some((t) => t.ip === IP1), "US must list IP1 (its own IP)");
  assert.ok(ca?.topIps.some((t) => t.ip === IP2), "CA must list IP2 (its own IP)");
  assert.ok(!us?.topIps.some((t) => t.ip === IP2), "an IP must not appear under a foreign country");
  // Each country's IP list is descending by count.
  for (const c of snap.topCountries) {
    for (let i = 1; i < c.topIps.length; i++) {
      assert.ok(c.topIps[i - 1].count >= c.topIps[i].count, `topIps busiest-first for ${c.key}`);
    }
  }
});

// ---------------------------------------------------------------------------
// recentLogs()
// ---------------------------------------------------------------------------
test("recentLogs(undefined, N) returns the N most-recent entries, newest-first", () => {
  assert.equal(recent3.length, 3);
  // The newest entry is the last line written; ordering is strictly descending by ts.
  assert.equal(recent3[0].ts, "2026-01-01T00:00:05+00:00");
  assert.equal(recent3[0].status, 500);
  assert.equal(recent3[0].host, B);
  for (let i = 1; i < recent3.length; i++) {
    assert.ok(recent3[i - 1].ts > recent3[i].ts, "entries must be newest-first");
  }
});

test("recentLogs returns the whole ring when N exceeds it, oldest entry last", () => {
  assert.equal(recentAll.length, rows.length);
  assert.equal(recentAll[recentAll.length - 1].ts, "2026-01-01T00:00:00+00:00");
});

test("recentLogs(filter) matches host / status / IP", () => {
  assert.equal(recentHostB.length, 2);
  assert.ok(recentHostB.every((e) => e.host === B));
  assert.equal(recent500.length, 1);
  assert.equal(recent500[0].status, 500);
  assert.equal(recentIp1.length, 3);
  assert.ok(recentIp1.every((e) => e.ip === IP1));
});

// ---------------------------------------------------------------------------
// searchLog() — ring + persisted access log, deduped
// ---------------------------------------------------------------------------
test("searchLog finds matches for an IP across ring + disk, deduped", () => {
  assert.equal(searchIp1.length, 3, "the same 3 IP1 requests exist in the ring and on disk but must not double-count");
  assert.ok(searchIp1.every((e) => e.ip === IP1));
});

test("searchLog with an empty filter falls back to recentLogs", async () => {
  assert.equal((await metrics.searchLog("")).length, metrics.recentLogs(undefined, 200).length);
});

// ---------------------------------------------------------------------------
// prometheus() exporter
// ---------------------------------------------------------------------------
test("prometheus() exposes the counters in exposition format", () => {
  assert.match(promSnap, /nginux_requests_total 6/);
  assert.match(promSnap, /nginux_request_bytes_total 1370/);
  assert.match(promSnap, /nginux_responses_total\{class="2xx"\} 3/);
  assert.match(promSnap, /nginux_responses_total\{class="5xx"\} 1/);
  assert.match(promSnap, /nginux_requests_by_host_total\{host="a\.example\.com"\} 4/);
  assert.match(promSnap, /nginux_response_ms\{quantile="0\.5"\}/);
});

test("prometheus() escapes host label values (exposition-format injection guard)", () => {
  // Host comes from the client Host header. A quote/newline in it must be escaped so
  // it can never break out of the label and forge extra metric lines.
  metrics.ingest({
    ts: new Date().toISOString(), host: 'evil"\nhost', method: "GET", path: "/",
    status: 200, bytes: 1, bytesIn: 1, ip: "203.0.113.9", country: "", ua: "x", ms: 1,
  });
  const p = metrics.prometheus();
  assert.ok(p.includes('host="evil\\"\\nhost"'), "the quote and newline must be backslash-escaped");
  assert.ok(!/host="evil"\n/.test(p), "an unescaped quote+newline must never appear literally");
});

// ---------------------------------------------------------------------------
// hostTraffic() / hostStats() — all-time fallback when the window is empty
// ---------------------------------------------------------------------------
test("hostTraffic falls back to all-time request counts when the live window is empty", () => {
  const map = new Map(hostTrafficSnap.map((h) => [h.key, h.count]));
  assert.equal(map.get(A), 4);
  assert.equal(map.get(B), 2);
});

test("hostStats falls back to all-time per-host in/out byte totals when the window is empty", () => {
  const a = hostStatsSnap.find((h) => h.key === A);
  assert.equal(a?.requests, 4);
  assert.equal(a?.bytesOut, 750); // 100+200+300+150
  assert.equal(a?.bytesIn, 320);  // 80 * 4
  const b = hostStatsSnap.find((h) => h.key === B);
  assert.equal(b?.requests, 2);
  assert.equal(b?.bytesOut, 620); // 120+500
});

// ---------------------------------------------------------------------------
// trafficSeries()
// ---------------------------------------------------------------------------
test("trafficSeries falls back to a synthetic series when a global range has no real data", () => {
  assert.equal(syntheticGlobal.real, false);
  assert.equal(syntheticGlobal.data.length, 30);
  assert.ok(syntheticGlobal.data.every((n) => n >= 2)); // synthetic() floors each point at 2
  assert.equal(syntheticGlobal.range, "1d");
});

test("trafficSeries reflects real in-window traffic for a host (requests + bandwidth)", () => {
  const H = "ts.example.com";
  for (let i = 0; i < 4; i++) {
    metrics.ingest({
      ts: new Date().toISOString(), host: H, method: "GET", path: "/x",
      status: 200, bytes: 1000, bytesIn: 100, ip: "203.0.113.233", country: "JP", ua: "curl", ms: 5,
    });
  }
  const req = metrics.trafficSeries("1h", "requests", H);
  assert.equal(req.real, true);
  assert.equal(req.data.length, 30);
  assert.equal(req.data.reduce((a, b) => a + b, 0), 4);

  const bw = metrics.trafficSeries("1h", "bandwidth", H);
  assert.ok(Array.isArray(bw.dataIn), "bandwidth series must expose the inbound direction");
  assert.equal(bw.data.reduce((a, b) => a + b, 0), 4000);   // out bytes
  assert.equal(bw.dataIn!.reduce((a, b) => a + b, 0), 400); // in bytes
});

test("trafficSeries for an unknown host is an all-zero, non-synthetic series", () => {
  // Host-scoped series never fabricate synthetic data (that is global-only).
  const s = metrics.trafficSeries("1h", "requests", "nobody.example.com");
  assert.equal(s.real, false);
  assert.equal(s.data.length, 30);
  assert.equal(s.data.reduce((a, b) => a + b, 0), 0);
});

// ---------------------------------------------------------------------------
// rangeSummary() — window-scoped, from the per-minute analytics buckets
// ---------------------------------------------------------------------------
test("rangeSummary('1h') reflects freshly-ingested current-time entries", () => {
  const H = "fresh.example.com";
  const before = metrics.rangeSummary("1h");
  for (let i = 0; i < 3; i++) {
    metrics.ingest({
      ts: new Date().toISOString(), host: H, method: "GET", path: "/live",
      status: i === 2 ? 502 : 200, bytes: 500, bytesIn: 50, ip: "203.0.113.222", country: "JP", ua: "curl", ms: 7,
    });
  }
  const after = metrics.rangeSummary("1h");
  // Delta-based so the assertion is independent of any other in-window traffic
  // other tests may have ingested.
  assert.equal(after.totalRequests - before.totalRequests, 3);
  assert.equal(after.statusClass["2xx"] - before.statusClass["2xx"], 2);
  assert.equal(after.statusClass["5xx"] - before.statusClass["5xx"], 1);
  assert.equal(after.topHosts.find((h) => h.key === H)?.count, 3);
  assert.equal(after.topIps.find((t) => t.key === "203.0.113.222")?.count, 3);
});

// ---------------------------------------------------------------------------
// hostSummary() — on-demand single-host scan within a range window
// ---------------------------------------------------------------------------
test("hostSummary aggregates one host's recent traffic within the range window", async () => {
  const H = "hs.example.com";
  for (let i = 0; i < 5; i++) {
    metrics.ingest({
      ts: new Date().toISOString(), host: H, method: "GET", path: `/p${i}`, // distinct paths → distinct dedup keys
      status: i === 4 ? 404 : 200, bytes: 100, bytesIn: 10, ip: "203.0.113.244", country: "JP", ua: "x", ms: 3,
    });
  }
  const s = await metrics.hostSummary(H, "1h");
  assert.equal(s.totalRequests, 5);
  assert.equal(s.statusClass["2xx"], 4);
  assert.equal(s.statusClass["4xx"], 1);
  assert.equal(s.topIps[0].key, "203.0.113.244");
  assert.equal(s.topIps[0].count, 5);
  // A host with no traffic returns an empty, well-formed summary.
  const empty = await metrics.hostSummary("ghost.example.com", "1h");
  assert.equal(empty.totalRequests, 0);
  assert.equal(empty.errorRate, 0);
});

// ---------------------------------------------------------------------------
// REGRESSION (audit): long ranges must read HOUR rollups, not just the ~25h
// minute buckets. hostStats/hostTraffic previously scanned only hostMinute for
// every range, so 7d/30d silently truncated the Network Map to the last ~25h.
// ---------------------------------------------------------------------------
test("hostStats/hostTraffic 7d consults hour rollups (data older than ~25h is not dropped)", () => {
  const oldHost = "old-rollup.example.com", freshHost = "fresh-rollup.example.com";
  const now = Date.now();
  const e = (host: string, tsMs: number) => metrics.ingest({
    ts: new Date(tsMs).toISOString(), host, method: "GET", path: "/", status: 200,
    bytes: 500, bytesIn: 100, ip: "203.0.113.9", country: "US", ua: "curl", ms: 5,
  });
  e(freshHost, now - 60_000);        // 1 min ago → keeps the 1d window non-empty (avoids all-time fallback)
  e(oldHost, now - 72 * 3600_000);   // 3 days ago → survives only in the hour rollups

  // A 1d range scans minute buckets → the 3-day-old host must be ABSENT.
  const day = metrics.hostStats("1d");
  assert.ok(day.some((h) => h.key === freshHost), "sanity: the fresh host is inside the 1d window");
  assert.ok(!day.some((h) => h.key === oldHost), "a 1d range must not surface a 3-day-old host (minute buckets only span ~25h)");

  // A 7d range scans hour rollups → the 3-day-old host MUST appear (the bug hid it).
  const oldWeek = metrics.hostStats("7d").find((h) => h.key === oldHost);
  assert.ok(oldWeek && oldWeek.requests >= 1, "a 7d range must surface the 3-day-old host via hour rollups");
  const oldWeekTraffic = metrics.hostTraffic("7d").find((h) => h.key === oldHost);
  assert.ok(oldWeekTraffic && oldWeekTraffic.count >= 1, "hostTraffic 7d must also surface it via hour rollups");
});

// F1: hostSummary skips the disk read when the in-memory ring already covers the
// window. ringCoversWindow is the decision predicate (ring non-empty here after the
// corpus replay).
test("ringCoversWindow: covered for a far-future cutoff, never for the epoch", () => {
  assert.equal(metrics.ringCoversWindow(Date.now() + 1e12), true, "ring's oldest entry predates a far-future cutoff");
  assert.equal(metrics.ringCoversWindow(0), false, "no entry predates the epoch");
});

// Geo-block analytics (feature 4.10): denied-status requests grouped by country/IP.
test("blockedAttempts groups denied (401/403/429) requests by country + top IPs", () => {
  const now = Date.now();
  const deny = (status: number, country: string, ip: string) => metrics.ingest({
    ts: new Date(now).toISOString(), host: "blk.example.com", method: "GET", path: "/", status,
    bytes: 0, bytesIn: 0, ip, country, ua: "curl", ms: 1,
  });
  deny(403, "RU", "5.5.5.1"); deny(403, "RU", "5.5.5.1"); deny(429, "RU", "5.5.5.2");
  deny(401, "CN", "6.6.6.1"); deny(200, "US", "7.7.7.1"); // a 200 must NOT count as blocked

  const b = metrics.blockedAttempts(12);
  assert.ok(b.total >= 4, "counts the denied requests");
  const ru = b.byCountry.find((c) => c.country === "RU");
  assert.ok(ru && ru.count >= 3, "RU denied attempts grouped");
  const topIp = b.topIps.find((t) => t.ip === "5.5.5.1");
  assert.ok(topIp && topIp.count >= 2 && topIp.country === "RU", "top offending IP with its country");
  assert.ok(!b.topIps.some((t) => t.ip === "7.7.7.1"), "a 200 response is not a blocked attempt");
});

// REGRESSION (audit): trafficSeries 7d used floor rounding (168h/30 → 5h/pt), so
// it only reached back ~150h and dropped the oldest ~18h. ceil covers the window.
test("trafficSeries 7d covers the full window (ceil rounding), including ~155h-old data", () => {
  const host = "series-window.example.com";
  const now = Date.now();
  // 155h ago is inside the 7d (168h) window but beyond the old floor-rounded ~150h reach.
  metrics.ingest({
    ts: new Date(now - 155 * 3600_000).toISOString(), host, method: "GET", path: "/", status: 200,
    bytes: 700, bytesIn: 100, ip: "203.0.113.10", country: "US", ua: "curl", ms: 5,
  });
  const series = metrics.trafficSeries("7d", "requests", host);
  const sum = series.data.reduce((a, b) => a + b, 0);
  assert.ok(sum >= 1, "a ~155h-old point must fall inside the ceil-rounded 7d series (floor rounding dropped it)");
});
