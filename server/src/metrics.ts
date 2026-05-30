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
  bytes: number;
  ip: string;
  country: string;
  ua: string;
  ms: number;
}

// ---------- in-memory state ----------
const RING_MAX = 500;
const ring: LogEntry[] = [];
const minuteBuckets = new Map<number, { count: number; bytes: number }>();
// Per-second totals for the "live" view (last ~3 minutes retained).
const secondBuckets = new Map<number, { count: number; bytes: number }>();
const statusClass = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
const byHost = new Map<string, number>();
// Per-minute, per-host counts so the Network Map can show traffic over a window
// (and a short "live" window). Bounded to ~25h of minutes like minuteBuckets.
const hostMinute = new Map<number, Map<string, number>>();
const byIp = new Map<string, number>();
const byPath = new Map<string, number>();
const byCountry = new Map<string, number>();
let totalRequests = 0;
let totalBytes = 0;
const msSamples: number[] = [];

const logSubscribers = new Set<(e: LogEntry) => void>();
export function subscribeLog(fn: (e: LogEntry) => void): () => void {
  logSubscribers.add(fn);
  return () => logSubscribers.delete(fn);
}

function bump(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export function ingest(e: LogEntry): void {
  ring.push(e);
  if (ring.length > RING_MAX) ring.shift();

  const minute = Math.floor(Date.parse(e.ts) / 60000);
  const b = minuteBuckets.get(minute) ?? { count: 0, bytes: 0 };
  b.count++;
  b.bytes += e.bytes;
  minuteBuckets.set(minute, b);
  if (minuteBuckets.size > 1500) {
    const oldest = Math.min(...minuteBuckets.keys());
    minuteBuckets.delete(oldest);
  }

  const second = Math.floor(Date.parse(e.ts) / 1000);
  const sb = secondBuckets.get(second) ?? { count: 0, bytes: 0 };
  sb.count++; sb.bytes += e.bytes;
  secondBuckets.set(second, sb);
  if (secondBuckets.size > 200) secondBuckets.delete(Math.min(...secondBuckets.keys()));

  let hm = hostMinute.get(minute);
  if (!hm) { hm = new Map(); hostMinute.set(minute, hm); }
  hm.set(e.host, (hm.get(e.host) ?? 0) + 1);
  if (hostMinute.size > 1500) hostMinute.delete(Math.min(...hostMinute.keys()));

  const cls = `${Math.floor(e.status / 100)}xx` as keyof typeof statusClass;
  if (cls in statusClass) statusClass[cls]++;
  bump(byHost, e.host);
  bump(byIp, e.ip);
  bump(byPath, e.path);
  if (e.country) bump(byCountry, e.country);
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

function percentile(p: number): number {
  if (msSamples.length === 0) return 0;
  const sorted = [...msSamples].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
}

function topN(map: Map<string, number>, n: number) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, count]) => ({ key, count }));
}

export function summary() {
  const errors = statusClass["4xx"] + statusClass["5xx"];
  return {
    totalRequests,
    totalBytes,
    statusClass,
    errorRate: totalRequests ? +((errors / totalRequests) * 100).toFixed(2) : 0,
    p50: percentile(50),
    p95: percentile(95),
    topHosts: topN(byHost, 6),
    topIps: topN(byIp, 6),
    topPaths: topN(byPath, 6),
    topCountries: topN(byCountry, 8),
  };
}

/** Per-host request counts over a time window (drives the Network Map dots).
 *  "live" is a short rolling window so the map reacts to current load; longer
 *  ranges aggregate more. Falls back to all-time counts if the window is empty. */
export function hostTraffic(range: string): { key: string; count: number }[] {
  const spans: Record<string, number> = { live: 3, "1h": 60, "4h": 240, "1d": 1440, "7d": 10080, "30d": 43200 };
  const minutes = spans[range] ?? 3;
  const nowMin = Math.floor(Date.now() / 60000);
  const acc = new Map<string, number>();
  for (let m = 0; m < minutes; m++) {
    const hm = hostMinute.get(nowMin - m);
    if (!hm) continue;
    for (const [h, c] of hm) acc.set(h, (acc.get(h) ?? 0) + c);
  }
  if (acc.size === 0) return [...byHost.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }));
  return [...acc.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }));
}

/** Time series for a range, sampled into ~30 buckets from real minute data. */
export function trafficSeries(range: string): { range: string; data: number[]; total: string; peak: string; unit: string; axis: string[]; real: boolean } {
  // "live": last ~90s at 3s resolution, straight from the real per-second data.
  if (range === "live") {
    const points = 30, perSec = 3;
    const nowSec = Math.floor(Date.now() / 1000);
    const data: number[] = [];
    let total = 0;
    for (let i = points - 1; i >= 0; i--) {
      let sum = 0;
      for (let s = 0; s < perSec; s++) sum += secondBuckets.get(nowSec - i * perSec - s)?.count ?? 0;
      data.push(sum);
      total += sum;
    }
    return {
      range: "live", data,
      total: fmtNum(total), peak: fmtNum(Math.max(0, ...data)),
      unit: "/3s", axis: ["90s", "60s", "30s", "now"], real: true,
    };
  }
  const spans: Record<string, number> = { "1h": 60, "4h": 240, "1d": 1440, "7d": 10080, "30d": 43200 };
  const minutes = spans[range] ?? 60;
  const nowMin = Math.floor(Date.now() / 60000);
  const points = 30;
  const per = Math.max(1, Math.floor(minutes / points));
  const data: number[] = [];
  let total = 0;
  for (let i = points - 1; i >= 0; i--) {
    let sum = 0;
    for (let m = 0; m < per; m++) {
      const minute = nowMin - i * per - m;
      sum += minuteBuckets.get(minute)?.count ?? 0;
    }
    data.push(sum);
    total += sum;
  }
  const real = total > 0;
  if (!real) return { ...synthetic(range), real: false };
  const peak = Math.max(...data);
  return {
    range, data,
    total: fmtNum(total),
    peak: fmtNum(peak),
    unit: per === 1 ? "/min" : `/${per}m`,
    axis: axisFor(range),
    real: true,
  };
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
  for (const [host, n] of byHost) lines.push(`nginux_requests_by_host_total{host="${host}"} ${n}`);
  lines.push("# HELP nginux_response_ms Response time percentiles.");
  lines.push("# TYPE nginux_response_ms gauge");
  lines.push(`nginux_response_ms{quantile="0.5"} ${percentile(50)}`);
  lines.push(`nginux_response_ms{quantile="0.95"} ${percentile(95)}`);
  return lines.join("\n") + "\n";
}

// ---------- file tailer (container: real nginx logs) ----------
export function startLogTailer(): void {
  const dir = dirname(ACCESS_LOG);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let offset = existsSync(ACCESS_LOG) ? statSync(ACCESS_LOG).size : 0;

  const readNew = () => {
    if (!existsSync(ACCESS_LOG)) return;
    const size = statSync(ACCESS_LOG).size;
    if (size < offset) offset = 0; // rotated
    if (size === offset) return;
    let buf = "";
    createReadStream(ACCESS_LOG, { start: offset, end: size })
      .on("data", (c) => (buf += c))
      .on("end", () => {
        offset = size;
        for (const line of buf.split("\n")) parseLine(line);
      });
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
        bytes: Math.floor(200 + Math.random() * 80000),
        ip,
        country,
        ua: pick(["Chrome", "Safari", "curl", "PlexApp"]),
        ms: Math.round((5 + Math.random() * 180) * 100) / 100,
      });
    }
  }, 900).unref?.();
}
