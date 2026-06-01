import { existsSync, mkdirSync, statSync, createReadStream, watchFile } from "node:fs";
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
  if (minuteBuckets.size > 1500) minuteBuckets.delete(Math.min(...minuteBuckets.keys()));

  const second = Math.floor(Date.parse(e.ts) / 1000);
  const sb = secondBuckets.get(second) ?? emptyStat();
  bumpStat(sb, e);
  secondBuckets.set(second, sb);
  if (secondBuckets.size > 200) secondBuckets.delete(Math.min(...secondBuckets.keys()));

  let hsec = hostSecond.get(second);
  if (!hsec) { hsec = new Map(); hostSecond.set(second, hsec); }
  const hsv = hsec.get(e.host) ?? emptyStat();
  bumpStat(hsv, e); hsec.set(e.host, hsv);
  if (hostSecond.size > 150) hostSecond.delete(Math.min(...hostSecond.keys()));

  let hm = hostMinute.get(minute);
  if (!hm) { hm = new Map(); hostMinute.set(minute, hm); }
  const hmv = hm.get(e.host) ?? emptyStat();
  bumpStat(hmv, e); hm.set(e.host, hmv);
  if (hostMinute.size > 1500) hostMinute.delete(Math.min(...hostMinute.keys()));

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

/** Top source IPs whose GeoIP country is `country` (busiest first). Derived from
 *  byIp + ipCountry so it costs nothing extra to maintain. */
function topIpsForCountry(country: string, n: number): { ip: string; count: number }[] {
  const out: { ip: string; count: number }[] = [];
  for (const [ip, count] of byIp) if (ipCountry.get(ip) === country) out.push({ ip, count });
  return out.sort((a, b) => b.count - a.count).slice(0, n);
}

export function summary() {
  const errors = statusClass["4xx"] + statusClass["5xx"];
  const sorted = sortedMs();
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
    topCountries: topN(byCountry, 8).map((c) => ({ ...c, topIps: topIpsForCountry(c.key, 5) })),
  };
}

/** Per-host request counts over a time window (drives the Network Map dots).
 *  "live" is a short rolling window so the map reacts to current load; longer
 *  ranges aggregate more. Falls back to all-time counts if the window is empty. */
export function hostTraffic(range: string, metric: "requests" | "bandwidth" = "requests"): { key: string; count: number }[] {
  const bw = metric === "bandwidth";
  const val = (v: Stat) => (bw ? v.out + v.in : v.count); // bandwidth = total throughput (in + out)
  const acc = new Map<string, number>();
  const add = (h: string, v: Stat) => acc.set(h, (acc.get(h) ?? 0) + val(v));

  if (range === "live") {
    const nowSec = Math.floor(Date.now() / 1000);
    for (let s = 0; s < 60; s++) {
      const hs = hostSecond.get(nowSec - s);
      if (hs) for (const [h, v] of hs) add(h, v);
    }
  } else {
    const spans: Record<string, number> = { "1h": 60, "4h": 240, "1d": 1440, "7d": 10080, "30d": 43200 };
    const minutes = spans[range] ?? 60;
    const nowMin = Math.floor(Date.now() / 60000);
    for (let m = 0; m < minutes; m++) {
      const hm = hostMinute.get(nowMin - m);
      if (hm) for (const [h, v] of hm) add(h, v);
    }
  }
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
  if (range === "live") {
    const nowSec = Math.floor(Date.now() / 1000);
    for (let s = 0; s < 60; s++) { const hs = hostSecond.get(nowSec - s); if (hs) for (const [h, v] of hs) add(h, v); }
  } else {
    const spans: Record<string, number> = { "1h": 60, "4h": 240, "1d": 1440, "7d": 10080, "30d": 43200 };
    const minutes = spans[range] ?? 60;
    const nowMin = Math.floor(Date.now() / 60000);
    for (let m = 0; m < minutes; m++) { const hm = hostMinute.get(nowMin - m); if (hm) for (const [h, v] of hm) add(h, v); }
  }
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
    const nowMin = Math.floor(Date.now() / 60000);
    points = 30; const per = Math.max(1, Math.floor(minutes / points));
    axis = axisFor(range); unit = per === 1 ? "/min" : `/${per}m`;
    stepGet = (i) => Array.from({ length: per }, (_, m) => getMin(nowMin - (points - 1 - i) * per - m)).filter(Boolean) as Stat[];
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
          offset = end + 1; // createReadStream end is inclusive
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
  const paths = ["/", "/web/index.html", "/api/data", "/apps/files", "/favicon.ico", "/identity/connect", "/admin"];
  const geos = [["203.0.113.10", "CA"], ["198.51.100.7", "US"], ["203.0.113.45", "IN"], ["198.51.100.211", "RU"]];
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
