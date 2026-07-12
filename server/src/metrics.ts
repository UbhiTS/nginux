import { existsSync, mkdirSync, statSync, createReadStream, watchFile, openSync, readSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listHosts } from "./repo.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ACCESS_LOG = process.env.NGINX_ACCESS_LOG ?? join(__dirname, "..", "data", "logs", "access.log");

export interface LogEntry {
  ts: string;
  host: string;
  method: string;
  path: string;
  status: number;
  bytes: number;     // response bytes sent to client (egress / out)
  bytesIn?: number;  // request bytes received from client (ingress / in)
  ip: string;
  country: string;
  ua: string;
  ms: number;
}

// ---------- in-memory state ----------
// Every bucket tracks request count + out (response) and in (request) bytes.
type Stat = { count: number; out: number; in: number };
const emptyStat = (): Stat => ({ count: 0, out: 0, in: 0 });
const bumpStat = (s: Stat, e: LogEntry) => { s.count++; s.out += e.bytes; s.in += e.bytesIn ?? 0; };

const RING_MAX = 500;
const ring: LogEntry[] = [];
const minuteBuckets = new Map<number, Stat>();
// Per-hour totals (global + per-host) so the 7d/30d traffic graph spans its full
// window - minuteBuckets only retain ~25h. ~40 days of hours is <1k entries.
const HOUR_CAP = 24 * 40;
const statHour = new Map<number, Stat>();
const hostStatHour = new Map<number, Map<string, Stat>>();
// Per-second totals for the "live" view (last ~3 minutes retained).
const secondBuckets = new Map<number, Stat>();
const statusClass = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
const byHost = new Map<string, number>();
// Per-minute, per-host stats so the map/graph can scope to one service over a
// window. Bounded to ~25h of minutes like minuteBuckets.
const hostMinute = new Map<number, Map<string, Stat>>();
// Per-second, per-host stats for the 60s "live" window (last ~2.5 min retained).
const hostSecond = new Map<number, Map<string, Stat>>();
// Cumulative per-host stat (fallback when a window has no data).
const byHostStat = new Map<string, Stat>();
const byIp = new Map<string, number>();
const byPath = new Map<string, number>();
const byCountry = new Map<string, number>();
// Last-seen GeoIP country per source IP (populated only when the MaxMind DB is
// installed — nginx logs $geoip2_country_iso_code). Lets us flag the top IPs and
// list a country's top IPs. FIFO-bounded; it only drives labels, not counts.
const ipCountry = new Map<string, string>();

// ---- per-minute analytics buckets (drive the range-scoped Logs summary) ----
// Latency histogram: a request's ms lands in the first bucket whose upper bound it
// is <= (last bucket = overflow). Coarse, but enough for an approximate p50/p95
// over a window without storing every sample.
const LAT_REPORT = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000]; // representative ms per bucket
const latBucket = (ms: number): number => {
  for (let i = 0; i < LAT_REPORT.length - 1; i++) if (ms <= LAT_REPORT[i]) return i;
  return LAT_REPORT.length - 1;
};
type LogBucket = {
  count: number; out: number;
  status: [number, number, number, number]; // 2xx,3xx,4xx,5xx
  lat: number[];                              // length LAT_REPORT.length
  ip: Map<string, number>; path: Map<string, number>; country: Map<string, number>; host: Map<string, number>;
};
const newLogBucket = (): LogBucket => ({
  count: 0, out: 0, status: [0, 0, 0, 0], lat: new Array(LAT_REPORT.length).fill(0),
  ip: new Map(), path: new Map(), country: new Map(), host: new Map(),
});
// Keyed by minute, bounded to ~25h like minuteBuckets. Each per-minute breakdown
// is capped so a flood of distinct keys can't exhaust memory.
const logMinute = new Map<number, LogBucket>();
const PER_MIN_KEYS = 150;
function bumpMin(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
  if (map.size > PER_MIN_KEYS) {
    const keep = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, PER_MIN_KEYS >> 1);
    map.clear();
    for (const [k, n] of keep) map.set(k, n);
  }
}

// Hour-granularity rollups. Per-minute buckets are only retained ~25h, so without
// these the 7d/30d ranges silently truncate to ~25h. ~40 days of hour buckets
// (<1k entries) covers 30d cheaply and lets the long ranges span their full window.
const logHour = new Map<number, LogBucket>();

/** Add one request's contribution to a per-minute or per-hour breakdown bucket. */
function fillLogBucket(lb: LogBucket, e: LogEntry): void {
  lb.count++; lb.out += e.bytes;
  const sci = Math.floor(e.status / 100) - 2;
  if (sci >= 0 && sci < 4) lb.status[sci]++;
  lb.lat[latBucket(e.ms)]++;
  bumpMin(lb.ip, e.ip);
  bumpMin(lb.path, e.path);
  bumpMin(lb.host, e.host);
  if (e.country) bumpMin(lb.country, e.country);
}
/** Get-or-create a time bucket, evicting the oldest key once over `cap`. Time
 *  buckets are inserted in increasing time order (live tailing and chronological
 *  replay), so the first-inserted key (Map preserves insertion order) is the
 *  oldest - an O(1) eviction instead of an O(n) `Math.min(...keys())` spread on
 *  every line once the map is at cap. */
function getLogBucket(map: Map<number, LogBucket>, key: number, cap: number): LogBucket {
  let b = map.get(key);
  if (!b) { b = newLogBucket(); map.set(key, b); if (map.size > cap) map.delete(map.keys().next().value as number); }
  return b;
}
let totalRequests = 0;
let totalBytes = 0;
const msSamples: number[] = [];

const logSubscribers = new Set<(e: LogEntry) => void>();
export function subscribeLog(fn: (e: LogEntry) => void): () => void {
  logSubscribers.add(fn);
  return () => logSubscribers.delete(fn);
}

// Cardinality cap for the per-IP / per-path / per-host / per-country counters.
// These are keyed on attacker-influenced values (client IP, URL path, Host
// header), so without a bound a flood of distinct keys could exhaust memory.
const MAX_KEYS = 5000;
function bump(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
  if (map.size > MAX_KEYS) {
    // Evict the cold (lowest-count) keys, keeping the busiest half.
    const keep = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_KEYS >> 1);
    map.clear();
    for (const [k, n] of keep) map.set(k, n);
  }
}

export function ingest(e: LogEntry): void {
  ring.push(e);
  if (ring.length > RING_MAX) ring.shift();

  const minute = Math.floor(Date.parse(e.ts) / 60000);
  const b = minuteBuckets.get(minute) ?? emptyStat();
  bumpStat(b, e);
  minuteBuckets.set(minute, b);
  if (minuteBuckets.size > 1500) minuteBuckets.delete(minuteBuckets.keys().next().value as number);

  // Rich per-minute + per-hour breakdowns for the range-scoped Logs summary.
  // Minute buckets (~25h retained) drive live/1h/4h/1d; hour rollups drive 7d/30d.
  fillLogBucket(getLogBucket(logMinute, minute, 1500), e);
  fillLogBucket(getLogBucket(logHour, Math.floor(Date.parse(e.ts) / 3600_000), 24 * 40), e);

  const second = Math.floor(Date.parse(e.ts) / 1000);
  const sb = secondBuckets.get(second) ?? emptyStat();
  bumpStat(sb, e);
  secondBuckets.set(second, sb);
  if (secondBuckets.size > 200) secondBuckets.delete(secondBuckets.keys().next().value as number);

  let hsec = hostSecond.get(second);
  if (!hsec) { hsec = new Map(); hostSecond.set(second, hsec); }
  const hsv = hsec.get(e.host) ?? emptyStat();
  bumpStat(hsv, e); hsec.set(e.host, hsv);
  if (hostSecond.size > 150) hostSecond.delete(hostSecond.keys().next().value as number);

  let hm = hostMinute.get(minute);
  if (!hm) { hm = new Map(); hostMinute.set(minute, hm); }
  const hmv = hm.get(e.host) ?? emptyStat();
  bumpStat(hmv, e); hm.set(e.host, hmv);
  if (hostMinute.size > 1500) hostMinute.delete(hostMinute.keys().next().value as number);

  // Hour rollups (global + per-host) for the long-range traffic graph.
  const hour = Math.floor(Date.parse(e.ts) / 3600_000);
  const sbh = statHour.get(hour) ?? emptyStat();
  bumpStat(sbh, e); statHour.set(hour, sbh);
  if (statHour.size > HOUR_CAP) statHour.delete(statHour.keys().next().value as number);
  let hmh = hostStatHour.get(hour);
  if (!hmh) { hmh = new Map(); hostStatHour.set(hour, hmh); }
  const hmhv = hmh.get(e.host) ?? emptyStat();
  bumpStat(hmhv, e); hmh.set(e.host, hmhv);
  if (hostStatHour.size > HOUR_CAP) hostStatHour.delete(hostStatHour.keys().next().value as number);

  const bh = byHostStat.get(e.host) ?? emptyStat();
  bumpStat(bh, e); byHostStat.set(e.host, bh);

  const cls = `${Math.floor(e.status / 100)}xx` as keyof typeof statusClass;
  if (cls in statusClass) statusClass[cls]++;
  bump(byHost, e.host);
  bump(byIp, e.ip);
  bump(byPath, e.path);
  if (e.country) {
    bump(byCountry, e.country);
    ipCountry.set(e.ip, e.country);
    if (ipCountry.size > MAX_KEYS) ipCountry.delete(ipCountry.keys().next().value as string);
  }
  totalRequests++;
  totalBytes += e.bytes;
  msSamples.push(e.ms);
  if (msSamples.length > 2000) msSamples.shift();

  for (const fn of logSubscribers) {
    try { fn(e); } catch { /* ignore slow subscriber */ }
  }
}

// ---------- queries ----------
export function recentLogs(filter?: string, limit = 200): LogEntry[] {
  let out = ring.slice(-limit).reverse();
  if (filter) {
    const f = filter.toLowerCase();
    out = out.filter((e) =>
      e.host.toLowerCase().includes(f) ||
      e.path.toLowerCase().includes(f) ||
      e.ip.includes(f) ||
      String(e.status) === f ||
      e.method.toLowerCase() === f,
    );
  }
  return out;
}

/** Search the PERSISTED access log (on disk) for lines matching `filter`,
 *  newest-first, up to `limit`. The in-memory ring only holds the last few
 *  hundred lines, so filtering it for an IP that the traffic map surfaced from
 *  the longer-window aggregates would often find nothing even though the request
 *  is recorded on disk. Reads a bounded tail so a huge log can't stall the
 *  request, and a cheap substring pre-filter avoids parsing non-matching lines. */
export function searchLog(filter: string, limit = 200): LogEntry[] {
  const f = filter.trim().toLowerCase();
  if (!f) return recentLogs(undefined, limit);
  const matches = (e: LogEntry) =>
    e.host.toLowerCase().includes(f) || e.path.toLowerCase().includes(f) ||
    e.ip.includes(f) || String(e.status) === f || e.method.toLowerCase() === f;
  const out: LogEntry[] = [];
  const seen = new Set<string>();
  const take = (e: LogEntry) => { const k = `${e.ts}|${e.ip}|${e.path}|${e.status}`; if (!seen.has(k)) { seen.add(k); out.push(e); } };
  // Freshest matches from the in-memory ring (also covers dev, where demo traffic
  // is ingested in memory and never written to disk).
  for (let i = ring.length - 1; i >= 0 && out.length < limit; i--) if (matches(ring[i])) take(ring[i]);
  // Then the persisted access log - full history up to retention, newest-first.
  // Skip the (blocking, up-to-32MB) disk read entirely when the in-memory ring
  // already produced `limit` matches - otherwise every filtered lookup re-reads
  // and re-decodes the tail on the event loop even when it's not needed.
  try {
    if (out.length < limit && existsSync(ACCESS_LOG)) {
      const size = statSync(ACCESS_LOG).size;
      if (size > 0) {
        const maxBytes = 32 * 1024 * 1024;
        const startAt = size > maxBytes ? size - maxBytes : 0;
        const fd = openSync(ACCESS_LOG, "r");
        const buf = Buffer.allocUnsafe(size - startAt);
        try { readSync(fd, buf, 0, buf.length, startAt); } finally { closeSync(fd); }
        const lines = buf.toString("utf8").split("\n");
        if (startAt > 0) lines.shift(); // drop the partial first line when tail-trimmed
        for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
          const t = lines[i];
          if (!t || !t.toLowerCase().includes(f)) continue; // widen-then-narrow: skip obvious non-matches
          try {
            const j = JSON.parse(t);
            const e: LogEntry = {
              ts: j.time ?? "", host: j.host ?? "-", method: j.method ?? "GET", path: j.path ?? "/",
              status: Number(j.status ?? 0), bytes: Number(j.bytes ?? 0), bytesIn: Number(j.bytes_in ?? 0),
              ip: j.ip ?? "-", country: j.country ?? "", ua: j.ua ?? "", ms: Math.round(Number(j.ms ?? 0) * 1000) / 1000,
            };
            if (matches(e)) take(e);
          } catch { /* skip malformed line */ }
        }
      }
    }
  } catch { /* fall back to whatever ring matches we found */ }
  return out;
}

// Sort the latency samples ONCE per caller, then read any percentile off it -
// summary() and prometheus() each need p50 + p95, so this halves the sorts.
function sortedMs(): number[] {
  return msSamples.length ? [...msSamples].sort((a, b) => a - b) : [];
}
function percentileOf(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
}

function topN(map: Map<string, number>, n: number) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, count]) => ({ key, count }));
}

/** Top-N source IPs per country, from ONE sorted pass over the merged IP map.
 *  The old approach re-scanned + re-sorted the whole IP set once per country
 *  (O(countries x IPs log IPs)); this sorts once and buckets by country in a
 *  single descending walk, so each country's list is already busiest-first and
 *  capped at n with no per-country sort. `cc(ip)` returns "" for unknown-country
 *  IPs, which are skipped (identical membership to the old per-country filter). */
function groupTopIpsByCountry(
  ipCounts: Map<string, number>,
  cc: (ip: string) => string,
  n: number,
): Map<string, { ip: string; count: number }[]> {
  const entries = [...ipCounts.entries()].sort((a, b) => b[1] - a[1]);
  const byCC = new Map<string, { ip: string; count: number }[]>();
  for (const [ip, count] of entries) {
    const c = cc(ip);
    if (!c) continue;
    let arr = byCC.get(c);
    if (!arr) { arr = []; byCC.set(c, arr); }
    if (arr.length < n) arr.push({ ip, count });
  }
  return byCC;
}

/** Approximate percentile (ms) from a latency histogram. */
function pctFromHist(lat: number[], p: number): number {
  const total = lat.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  const target = (p / 100) * total;
  let cum = 0;
  for (let i = 0; i < lat.length; i++) { cum += lat[i]; if (cum >= target) return LAT_REPORT[i]; }
  return LAT_REPORT[LAT_REPORT.length - 1];
}

const RANGE_MINUTES: Record<string, number> = { "1h": 60, "4h": 240, "1d": 1440, "7d": 10080, "30d": 43200 };

// The source-country map/list is meant to show EVERY country sending traffic, not
// a "top talkers" shortlist - otherwise widening the range trims lower-volume
// countries below the cutoff and they look like they vanished even though their
// (monotonic) counts only grew. Bound it generously to stay safe against a flood
// of bogus country codes while still showing the full real-world spread.
const MAP_COUNTRIES = 50;

/** Range-scoped equivalent of summary(), merged from the per-minute analytics
 *  buckets. Long-range top lists are approximate (top-K-per-minute merged) and
 *  p50/p95 are histogram-based. Unknown / "live" -> cumulative snapshot. */
export function rangeSummary(range: string) {
  const minutes = range === "live" ? 5 : RANGE_MINUTES[range];
  if (!minutes) return summary();
  // Short ranges read per-minute buckets (finer, ~25h retained); ranges past a day
  // read the hour rollups so 7d/30d actually cover their whole window.
  const useHours = minutes > 1440;
  const buckets = useHours ? logHour : logMinute;
  const unitMs = useHours ? 3600_000 : 60_000;
  const steps = useHours ? Math.ceil(minutes / 60) : minutes;
  const nowUnit = Math.floor(Date.now() / unitMs);
  let count = 0, out = 0;
  const status = [0, 0, 0, 0];
  const lat = new Array(LAT_REPORT.length).fill(0) as number[];
  const ip = new Map<string, number>(), path = new Map<string, number>(),
    country = new Map<string, number>(), host = new Map<string, number>();
  const merge = (dst: Map<string, number>, src: Map<string, number>) => { for (const [k, v] of src) dst.set(k, (dst.get(k) ?? 0) + v); };
  for (let m = 0; m < steps; m++) {
    const lb = buckets.get(nowUnit - m);
    if (!lb) continue;
    count += lb.count; out += lb.out;
    for (let i = 0; i < 4; i++) status[i] += lb.status[i];
    for (let i = 0; i < lat.length; i++) lat[i] += lb.lat[i];
    merge(ip, lb.ip); merge(path, lb.path); merge(country, lb.country); merge(host, lb.host);
  }
  const ipTop = groupTopIpsByCountry(ip, (k) => ipCountry.get(k) ?? "", 5);
  return {
    totalRequests: count,
    totalBytes: out,
    statusClass: { "2xx": status[0], "3xx": status[1], "4xx": status[2], "5xx": status[3] },
    errorRate: count ? +(((status[2] + status[3]) / count) * 100).toFixed(2) : 0,
    p50: pctFromHist(lat, 50),
    p95: pctFromHist(lat, 95),
    topHosts: topN(host, 6),
    topIps: topN(ip, 6).map((t) => ({ ...t, country: ipCountry.get(t.key) ?? "" })),
    topPaths: topN(path, 6),
    topCountries: topN(country, MAP_COUNTRIES).map((c) => ({ ...c, topIps: ipTop.get(c.key) ?? [] })),
  };
}

/** Per-host analytics summary (same shape as rangeSummary, minus topHosts),
 *  computed ON DEMAND by scanning the host-filtered access log within the range
 *  window. Kept out of the always-on aggregation so per-host IP/path/country
 *  breakdowns don't multiply memory by host count - the cost is paid only when a
 *  service's analytics panel is opened. The on-disk log is chronological, so the
 *  scan stops as soon as it passes the window's start. */
export function hostSummary(domain: string, range: string) {
  const dom = domain.toLowerCase();
  const minutes = range === "live" ? 5 : (RANGE_MINUTES[range] ?? 1440);
  const cutoff = Date.now() - minutes * 60_000;
  let count = 0, out = 0;
  const status = [0, 0, 0, 0];
  const lat = new Array(LAT_REPORT.length).fill(0) as number[];
  const ip = new Map<string, number>(), path = new Map<string, number>(), country = new Map<string, number>();
  const ipCC = new Map<string, string>(); // ip -> last-seen country, for top-IP labels
  const seen = new Set<string>();
  const add = (e: LogEntry) => {
    const k = `${e.ts}|${e.ip}|${e.path}|${e.status}`;
    if (seen.has(k)) return; seen.add(k);
    count++; out += e.bytes;
    const sci = Math.floor(e.status / 100) - 2; if (sci >= 0 && sci < 4) status[sci]++;
    lat[latBucket(e.ms)]++;
    ip.set(e.ip, (ip.get(e.ip) ?? 0) + 1);
    path.set(e.path, (path.get(e.path) ?? 0) + 1);
    if (e.country) { country.set(e.country, (country.get(e.country) ?? 0) + 1); ipCC.set(e.ip, e.country); }
  };
  // In-memory ring first (covers dev demo traffic, which never hits disk).
  for (let i = ring.length - 1; i >= 0; i--) {
    const e = ring[i];
    if (e.host.toLowerCase() === dom && Date.parse(e.ts) >= cutoff) add(e);
  }
  // Then the persisted access log, newest-first, stopping once past the window.
  try {
    if (existsSync(ACCESS_LOG)) {
      const size = statSync(ACCESS_LOG).size;
      if (size > 0) {
        const maxBytes = 32 * 1024 * 1024;
        const startAt = size > maxBytes ? size - maxBytes : 0;
        const fd = openSync(ACCESS_LOG, "r");
        const buf = Buffer.allocUnsafe(size - startAt);
        try { readSync(fd, buf, 0, buf.length, startAt); } finally { closeSync(fd); }
        const lines = buf.toString("utf8").split("\n");
        if (startAt > 0) lines.shift();
        for (let i = lines.length - 1; i >= 0; i--) {
          const t = lines[i];
          if (!t || !t.toLowerCase().includes(dom)) continue; // cheap pre-filter before parsing
          try {
            const j = JSON.parse(t);
            const ts = j.time ?? "";
            if (Date.parse(ts) < cutoff) break; // chronological → everything older is out of window
            if (String(j.host ?? "").toLowerCase() !== dom) continue; // dom matched a path/IP, not the host
            add({
              ts, host: j.host ?? "-", method: j.method ?? "GET", path: j.path ?? "/",
              status: Number(j.status ?? 0), bytes: Number(j.bytes ?? 0), bytesIn: Number(j.bytes_in ?? 0),
              ip: j.ip ?? "-", country: j.country ?? "", ua: j.ua ?? "", ms: Math.round(Number(j.ms ?? 0) * 1000) / 1000,
            });
          } catch { /* skip malformed line */ }
        }
      }
    }
  } catch { /* fall back to whatever the ring had */ }
  const ipTop = groupTopIpsByCountry(ip, (k) => ipCC.get(k) ?? "", 5);
  return {
    totalRequests: count,
    totalBytes: out,
    statusClass: { "2xx": status[0], "3xx": status[1], "4xx": status[2], "5xx": status[3] },
    errorRate: count ? +(((status[2] + status[3]) / count) * 100).toFixed(2) : 0,
    p50: pctFromHist(lat, 50),
    p95: pctFromHist(lat, 95),
    topHosts: [] as { key: string; count: number }[],
    topIps: topN(ip, 8).map((t) => ({ ...t, country: ipCC.get(t.key) ?? "" })),
    topPaths: topN(path, 8),
    topCountries: topN(country, MAP_COUNTRIES).map((c) => ({ ...c, topIps: ipTop.get(c.key) ?? [] })),
  };
}

/** Recent DENIED requests (401 auth, 403 geo/IP/exploit block, 429 rate limit)
 *  grouped by source country + top offending IPs, from the in-memory ring. Powers
 *  the "blocked attempts" security view - a country lock's 403s land here. */
export function blockedAttempts(limit = 12): {
  total: number;
  byCountry: { country: string; count: number }[];
  topIps: { ip: string; count: number; country: string }[];
} {
  const DENIED = new Set([401, 403, 429]);
  const byCountry = new Map<string, number>();
  const byIp = new Map<string, { count: number; country: string }>();
  let total = 0;
  for (const e of ring) {
    if (!DENIED.has(e.status)) continue;
    total++;
    if (e.country) byCountry.set(e.country, (byCountry.get(e.country) ?? 0) + 1);
    const cur = byIp.get(e.ip) ?? { count: 0, country: e.country ?? "" };
    cur.count++;
    if (!cur.country && e.country) cur.country = e.country;
    byIp.set(e.ip, cur);
  }
  return {
    total,
    byCountry: [...byCountry.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([country, count]) => ({ country, count })),
    topIps: [...byIp.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, limit).map(([ip, v]) => ({ ip, count: v.count, country: v.country })),
  };
}

export function summary() {
  const errors = statusClass["4xx"] + statusClass["5xx"];
  const sorted = sortedMs();
  const ipTop = groupTopIpsByCountry(byIp, (k) => ipCountry.get(k) ?? "", 5);
  return {
    totalRequests,
    totalBytes,
    statusClass,
    errorRate: totalRequests ? +((errors / totalRequests) * 100).toFixed(2) : 0,
    p50: percentileOf(sorted, 50),
    p95: percentileOf(sorted, 95),
    topHosts: topN(byHost, 6),
    topIps: topN(byIp, 6).map((t) => ({ ...t, country: ipCountry.get(t.key) ?? "" })),
    topPaths: topN(byPath, 6),
    topCountries: topN(byCountry, MAP_COUNTRIES).map((c) => ({ ...c, topIps: ipTop.get(c.key) ?? [] })),
  };
}

/** Sum the per-host Stat buckets over `range` into `add`, at the right
 *  granularity: live=seconds, ≤1d=minute buckets, >1d=HOUR rollups. Minute
 *  buckets only retain ~25h, so 7d/30d MUST read the hour rollups or the window
 *  is silently truncated to ~25h. Shared by hostTraffic + hostStats so the two
 *  can't drift (that drift was exactly the 7d/30d Network-Map truncation bug). */
function forEachHostBucket(range: string, add: (host: string, v: Stat) => void): void {
  if (range === "live") {
    const nowSec = Math.floor(Date.now() / 1000);
    for (let s = 0; s < 60; s++) { const hs = hostSecond.get(nowSec - s); if (hs) for (const [h, v] of hs) add(h, v); }
    return;
  }
  const spans: Record<string, number> = { "1h": 60, "4h": 240, "1d": 1440, "7d": 10080, "30d": 43200 };
  const minutes = spans[range] ?? 60;
  if (minutes > 1440) {
    const nowHr = Math.floor(Date.now() / 3600_000);
    for (let hr = 0; hr < Math.ceil(minutes / 60); hr++) { const hh = hostStatHour.get(nowHr - hr); if (hh) for (const [h, v] of hh) add(h, v); }
  } else {
    const nowMin = Math.floor(Date.now() / 60000);
    for (let m = 0; m < minutes; m++) { const hm = hostMinute.get(nowMin - m); if (hm) for (const [h, v] of hm) add(h, v); }
  }
}

/** Per-host request counts over a time window (drives the Network Map dots).
 *  "live" is a short rolling window so the map reacts to current load; longer
 *  ranges aggregate more. Falls back to all-time counts if the window is empty. */
export function hostTraffic(range: string, metric: "requests" | "bandwidth" = "requests"): { key: string; count: number }[] {
  const bw = metric === "bandwidth";
  const val = (v: Stat) => (bw ? v.out + v.in : v.count); // bandwidth = total throughput (in + out)
  const acc = new Map<string, number>();
  const add = (h: string, v: Stat) => acc.set(h, (acc.get(h) ?? 0) + val(v));

  forEachHostBucket(range, add);
  if (acc.size === 0) for (const [h, v] of byHostStat) acc.set(h, val(v)); // fallback to all-time
  return [...acc.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }));
}

/** Per-host requests + in/out bytes over a window - drives the Network Map's
 *  dual encoding (dots ∝ requests, line width ∝ bandwidth, per direction). */
export interface HostStat { key: string; requests: number; bytesIn: number; bytesOut: number; }
export function hostStats(range: string): HostStat[] {
  const acc = new Map<string, Stat>();
  const add = (h: string, v: Stat) => {
    const a = acc.get(h) ?? emptyStat();
    a.count += v.count; a.out += v.out; a.in += v.in;
    acc.set(h, a);
  };
  forEachHostBucket(range, add);
  if (acc.size === 0) for (const [h, v] of byHostStat) add(h, v); // fallback to all-time
  return [...acc.entries()].map(([key, v]) => ({ key, requests: v.count, bytesIn: v.in, bytesOut: v.out }));
}

/** Time series for a range + metric, optionally scoped to one host. For
 *  bandwidth, returns separate out (response) and in (request) byte series. */
export function trafficSeries(
  range: string,
  metric: "requests" | "bandwidth" = "requests",
  host?: string,
): { range: string; data: number[]; dataIn?: number[]; total: string; peak: string; unit: string; axis: string[]; real: boolean } {
  const bw = metric === "bandwidth";
  const fmt = bw ? fmtBytes : fmtNum;
  const getSec = (sec: number): Stat | undefined => (host ? hostSecond.get(sec)?.get(host) : secondBuckets.get(sec));
  const getMin = (min: number): Stat | undefined => (host ? hostMinute.get(min)?.get(host) : minuteBuckets.get(min));

  let points: number, axis: string[], unit: string;
  let stepGet: (i: number) => Stat[]; // buckets contributing to point i (0 = oldest)

  if (range === "live") {
    points = 30; const perSec = 2; const nowSec = Math.floor(Date.now() / 1000);
    axis = ["60s", "45s", "30s", "15s", "now"]; unit = "/2s";
    stepGet = (i) => Array.from({ length: perSec }, (_, s) => getSec(nowSec - (points - 1 - i) * perSec - s)).filter(Boolean) as Stat[];
  } else {
    const spans: Record<string, number> = { "1h": 60, "4h": 240, "1d": 1440, "7d": 10080, "30d": 43200 };
    const minutes = spans[range] ?? 60;
    points = 30;
    axis = axisFor(range);
    if (minutes > 1440) {
      // Long ranges (7d/30d) bucket by hour - minute buckets only span ~25h.
      const hours = Math.ceil(minutes / 60);
      const nowHr = Math.floor(Date.now() / 3600_000);
      // ceil (not floor): 7d = 168h / 30 pts floors to 5h/pt = only 150h shown,
      // dropping the oldest ~18h; ceil overshoots slightly but covers the window.
      const per = Math.max(1, Math.ceil(hours / points));
      unit = per === 1 ? "/h" : `/${per}h`;
      const getHr = (h: number): Stat | undefined => (host ? hostStatHour.get(h)?.get(host) : statHour.get(h));
      stepGet = (i) => Array.from({ length: per }, (_, m) => getHr(nowHr - (points - 1 - i) * per - m)).filter(Boolean) as Stat[];
    } else {
      const nowMin = Math.floor(Date.now() / 60000);
      const per = Math.max(1, Math.floor(minutes / points));
      unit = per === 1 ? "/min" : `/${per}m`;
      stepGet = (i) => Array.from({ length: per }, (_, m) => getMin(nowMin - (points - 1 - i) * per - m)).filter(Boolean) as Stat[];
    }
  }

  const outArr: number[] = [], inArr: number[] = [], cntArr: number[] = [];
  let totalOut = 0, totalIn = 0, totalCnt = 0;
  for (let i = 0; i < points; i++) {
    let o = 0, n = 0, c = 0;
    for (const b of stepGet(i)) { o += b.out; n += b.in; c += b.count; }
    outArr.push(o); inArr.push(n); cntArr.push(c);
    totalOut += o; totalIn += n; totalCnt += c;
  }

  // Demo synthetic only for global request counts with no real data.
  if (!bw && !host && totalCnt === 0) return { ...synthetic(range), real: false };

  if (bw) {
    return {
      range, data: outArr, dataIn: inArr,
      total: fmt(totalOut + totalIn),
      peak: fmt(Math.max(0, ...outArr, ...inArr)),
      unit, axis, real: totalOut + totalIn > 0,
    };
  }
  return {
    range, data: cntArr,
    total: fmt(totalCnt), peak: fmt(Math.max(0, ...cntArr)),
    unit, axis, real: totalCnt > 0,
  };
}

function fmtBytes(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + " KB";
  return Math.round(n) + " B";
}

function axisFor(range: string): string[] {
  return ({
    "1h": ["60m", "45m", "30m", "15m", "now"],
    "4h": ["4h", "3h", "2h", "1h", "now"],
    "1d": ["00:00", "06:00", "12:00", "18:00", "now"],
    "7d": ["Mon", "Wed", "Fri", "Sun", "now"],
    "30d": ["30d", "20d", "10d", "now"],
  } as Record<string, string[]>)[range] ?? ["", "now"];
}

function fmtNum(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

function synthetic(range: string) {
  const cfg: Record<string, { base: number; amp: number; total: string; peak: string }> = {
    "1h": { base: 35, amp: 28, total: "2.4k", peak: "58" },
    "4h": { base: 48, amp: 34, total: "9.1k", peak: "1.2k" },
    "1d": { base: 60, amp: 40, total: "142k", peak: "1.6k" },
    "7d": { base: 72, amp: 30, total: "980k", peak: "14k" },
    "30d": { base: 82, amp: 24, total: "4.1M", peak: "190k" },
  };
  const c = cfg[range] ?? cfg["1d"];
  const data = Array.from({ length: 30 }, (_, i) =>
    Math.max(2, Math.round(c.base + c.amp * (0.5 + 0.5 * Math.sin(i / 3)) + Math.sin(i * 1.7) * c.amp * 0.25)),
  );
  return { range, data, total: c.total, peak: c.peak, unit: "/min", axis: axisFor(range) };
}

// ---------- Prometheus exporter ----------
export function prometheus(): string {
  const lines: string[] = [];
  lines.push("# HELP nginux_requests_total Total proxied requests seen.");
  lines.push("# TYPE nginux_requests_total counter");
  lines.push(`nginux_requests_total ${totalRequests}`);
  lines.push("# HELP nginux_request_bytes_total Total bytes served.");
  lines.push("# TYPE nginux_request_bytes_total counter");
  lines.push(`nginux_request_bytes_total ${totalBytes}`);
  lines.push("# HELP nginux_responses_total Responses by status class.");
  lines.push("# TYPE nginux_responses_total counter");
  for (const [cls, n] of Object.entries(statusClass)) lines.push(`nginux_responses_total{class="${cls}"} ${n}`);
  lines.push("# HELP nginux_requests_by_host_total Requests per host.");
  lines.push("# TYPE nginux_requests_by_host_total counter");
  // Escape the label value - `host` comes from the client Host header, so it
  // must not break the Prometheus exposition format.
  const escLabel = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  for (const [host, n] of byHost) lines.push(`nginux_requests_by_host_total{host="${escLabel(host)}"} ${n}`);
  lines.push("# HELP nginux_response_ms Response time percentiles.");
  lines.push("# TYPE nginux_response_ms gauge");
  const sorted = sortedMs();
  lines.push(`nginux_response_ms{quantile="0.5"} ${percentileOf(sorted, 50)}`);
  lines.push(`nginux_response_ms{quantile="0.95"} ${percentileOf(sorted, 95)}`);
  return lines.join("\n") + "\n";
}

// ---------- file tailer (container: real nginx logs) ----------
/** Rebuild the in-memory metrics from the persisted access log on startup, so a
 *  restart / redeploy doesn't drop history (the file survives on the /data volume;
 *  the tailer otherwise resumes at EOF). Reads the tail (bounded so a huge log
 *  can't blow up boot) and replays each line through the same ingest path. The
 *  per-minute/-hour buckets are time-keyed, so history lands in the right window.
 *  Returns how many lines were replayed. Best-effort. */
export function replayAccessLog(maxBytes = 64 * 1024 * 1024): number {
  try {
    if (!existsSync(ACCESS_LOG)) return 0;
    const size = statSync(ACCESS_LOG).size;
    if (size <= 0) return 0;
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    const fd = openSync(ACCESS_LOG, "r");
    const buf = Buffer.allocUnsafe(len);
    try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // tail-trimmed: drop the partial first line
    let n = 0;
    for (const line of lines) { if (line) { parseLine(line); n++; } }
    return n;
  } catch { return 0; }
}

export function startLogTailer(): void {
  const dir = dirname(ACCESS_LOG);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let offset = existsSync(ACCESS_LOG) ? statSync(ACCESS_LOG).size : 0;
  let carry = ""; // a log line split across two reads must not be parsed as two

  const readNew = () => {
    try {
      if (!existsSync(ACCESS_LOG)) return;
      const size = statSync(ACCESS_LOG).size;
      if (size < offset) { offset = 0; carry = ""; } // rotated/truncated
      if (size <= offset) return;
      const end = size; // snapshot; bytes written after this are caught next tick
      let buf = "";
      createReadStream(ACCESS_LOG, { start: offset, end })
        // An unhandled stream 'error' (EBUSY, rotation mid-read) would otherwise
        // throw and crash the process - swallow it and retry next tick.
        .on("error", () => {})
        .on("data", (c) => (buf += c))
        .on("end", () => {
          // `end` was set to the file size, and the stream reads bytes
          // [offset, size-1] (clamped at EOF), so the next unread byte is `size`.
          // (The old `end + 1` skipped one byte - the first of each new chunk.)
          offset = end;
          const text = carry + buf;
          const lines = text.split("\n");
          carry = lines.pop() ?? ""; // keep the trailing partial line for next read
          for (const line of lines) parseLine(line);
        });
    } catch { /* stat/read race - retry on the next watch tick */ }
  };
  watchFile(ACCESS_LOG, { interval: 1000 }, readNew);
}

function parseLine(line: string): void {
  const t = line.trim();
  if (!t) return;
  try {
    const j = JSON.parse(t);
    ingest({
      ts: j.time ?? new Date().toISOString(),
      host: j.host ?? "-",
      method: j.method ?? "GET",
      path: j.path ?? "/",
      status: Number(j.status ?? 0),
      bytes: Number(j.bytes ?? 0),
      bytesIn: Number(j.bytes_in ?? 0),
      ip: j.ip ?? "-",
      country: j.country ?? "",
      ua: j.ua ?? "",
      ms: Math.round(Number(j.ms ?? 0) * 1000) / 1000,
    });
  } catch { /* skip malformed line */ }
}

// ---------- dev synthetic feeder (no real nginx on this box) ----------
export function startDemoTraffic(): void {
  const paths = [
    "/", "/web/index.html", "/api/data", "/apps/files", "/favicon.ico", "/identity/connect", "/admin",
    // Background-radiation scanner probes - the kind every exposed host sees.
    "/.env", "/wp-login.php", "/.git/config", "/phpmyadmin/", "/vendor/phpunit",
  ];
  // A realistic spread of source countries: a few expected visitors, plus a long
  // tail of unexpected/rogue scanners hammering the box from all over the world.
  // (IPs are from the reserved TEST-NET documentation ranges - never real hosts.)
  const geos = [
    // Expected, legitimate traffic
    ["198.51.100.7", "US"], ["198.51.100.32", "US"], ["203.0.113.10", "CA"],
    ["192.0.2.44", "GB"], ["192.0.2.90", "DE"], ["192.0.2.120", "FR"], ["203.0.113.66", "AU"],
    // Unexpected / rogue sources you wouldn't expect to be serving
    ["203.0.113.45", "CN"], ["203.0.113.88", "CN"], ["198.51.100.211", "RU"], ["198.51.100.222", "RU"],
    ["192.0.2.7", "NG"], ["203.0.113.150", "VN"], ["198.51.100.99", "ID"], ["192.0.2.201", "UA"],
    ["203.0.113.205", "TR"], ["198.51.100.150", "BR"], ["192.0.2.55", "IN"], ["203.0.113.99", "HK"],
    ["198.51.100.5", "SG"], ["192.0.2.240", "ZA"],
  ];
  const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

  setInterval(() => {
    const hosts = listHosts();
    if (hosts.length === 0) return;
    const n = 1 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      const h = pick(hosts);
      const [ip, country] = pick(geos);
      const roll = Math.random();
      const status = roll > 0.96 ? 500 : roll > 0.9 ? 404 : roll > 0.86 ? 403 : roll > 0.8 ? 301 : 200;
      ingest({
        ts: new Date().toISOString(),
        host: h.domain,
        method: pick(["GET", "GET", "GET", "POST"]),
        path: pick(paths),
        status,
        bytes: Math.floor(200 + Math.random() * 80000),   // response (out)
        bytesIn: Math.floor(120 + Math.random() * 4000),    // request (in) - typically smaller
        ip,
        country,
        ua: pick(["Chrome", "Safari", "curl", "PlexApp"]),
        ms: Math.round((5 + Math.random() * 180) * 100) / 100,
      });
    }
  }, 900).unref?.();
}
