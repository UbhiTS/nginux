import { useEffect, useRef, useState } from "react";
import { api, type GeoipStatus, type LogEntry, type MetricsSummary } from "../api.ts";
import { Icon } from "../icons.tsx";
import { TrafficChart } from "../components/TrafficChart.tsx";
import { TrafficMap } from "../components/TrafficMapLazy.tsx";
import { StatusCodeBars, TopSourceIps, CountryBars } from "../components/AnalyticsPanels.tsx";
import { statusColor, fmtBytes } from "../format.ts";

const RANGES = ["1h", "4h", "1d", "7d", "30d", "live"];
const METRICS = ["requests", "bandwidth"] as const;
type Metric = (typeof METRICS)[number];

// View state (range / metric / filter) lives in the URL hash so a refresh, a
// shared link, or a map-picked IP filter is bookmarkable — mirroring how App
// persists a page's sub-tab. We keep it inside a single hash path segment
// (#/logs/<params>) so App's own `#/<name>[/<tab>]` router still recognises the
// page (parts[0] === "logs") and never navigates away.
interface LogsView { range: string; metric: Metric; filter: string; }
const DEFAULT_VIEW: LogsView = { range: "1h", metric: "requests", filter: "" };

function readView(): LogsView {
  // Everything after "#/logs/" is our encoded params; tolerate a bare "#/logs".
  const seg = window.location.hash.replace(/^#\/?logs\/?/, "");
  if (!seg) return { ...DEFAULT_VIEW };
  const p = new URLSearchParams(seg);
  const range = p.get("range");
  const metric = p.get("metric");
  return {
    range: range && RANGES.includes(range) ? range : DEFAULT_VIEW.range,
    metric: metric === "bandwidth" ? "bandwidth" : "requests",
    filter: p.get("filter") ?? "",
  };
}

function writeView(v: LogsView) {
  const p = new URLSearchParams();
  if (v.range !== DEFAULT_VIEW.range) p.set("range", v.range);
  if (v.metric !== DEFAULT_VIEW.metric) p.set("metric", v.metric);
  if (v.filter) p.set("filter", v.filter);
  const qs = p.toString();
  // Only touch the hash while we're actually on the logs route, and use
  // replaceState so param tweaks don't spam the history stack (App does the same
  // for sub-tab switches). replaceState doesn't fire hashchange -> no feedback loop.
  if (!/^#\/?logs(\/|$)/.test(window.location.hash)) return;
  const next = `#/logs${qs ? `/${qs}` : ""}`;
  if (next !== window.location.hash) history.replaceState(null, "", next);
}

export function Logs() {
  const initial = readView();
  const [summary, setSummary] = useState<MetricsSummary | null>(null);
  // Track the metrics load explicitly: a fetch error (or a role without metrics
  // permission) must surface an inline note + Retry, not silently erase the
  // whole analytics half.
  const [metricsError, setMetricsError] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [geoip, setGeoip] = useState<GeoipStatus | null>(null);
  const [lines, setLines] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState(initial.filter);
  const [paused, setPaused] = useState(false);
  const [range, setRange] = useState(initial.range);
  const [metric, setMetric] = useState<Metric>(initial.metric);
  const [homeCountry, setHomeCountry] = useState("");
  const [blockedTop, setBlockedTop] = useState<Record<string, "busy" | "done">>({});
  const pausedRef = useRef(false);
  const logCardRef = useRef<HTMLDivElement>(null);
  pausedRef.current = paused;

  // Mirror range/metric/filter into the URL hash whenever they change.
  useEffect(() => { writeView({ range, metric, filter }); }, [range, metric, filter]);

  // Sync back from the hash on external changes (back/forward, a fresh nav to
  // #/logs from the sidebar, or a shared deep link opened in place).
  useEffect(() => {
    const onHash = () => {
      if (!/^#\/?logs(\/|$)/.test(window.location.hash)) return;
      const v = readView();
      setRange(v.range);
      setMetric(v.metric);
      setFilter(v.filter);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Range-scoped summary: every analytics panel reflects the selected window.
  useEffect(() => {
    let alive = true;
    const pull = () => api.metricsSummary(range)
      .then((s) => { if (alive) { setSummary(s); setMetricsError(false); } })
      .catch(() => { if (alive) setMetricsError(true); });
    pull();
    const poll = setInterval(pull, range === "live" ? 3000 : 6000);
    return () => { alive = false; clearInterval(poll); };
  }, [range, reloadNonce]);

  const retryMetrics = () => { setMetricsError(false); setReloadNonce((n) => n + 1); };

  // Live tail + GeoIP status + home country (independent of the analytics range).
  useEffect(() => {
    api.geoipStatus().then(setGeoip).catch(() => {});
    api.settings().then((s) => setHomeCountry(s.homeCountry || "")).catch(() => {});
    api.recentLogs(undefined, 100).then(setLines).catch(() => {});
    const es = new EventSource("/api/logs/stream", { withCredentials: true });
    es.addEventListener("log", (e) => {
      if (pausedRef.current) return;
      try {
        // Keep every line; the filter is applied at render so changing it (or
        // clicking a map IP) instantly re-filters what's already on screen.
        const entry: LogEntry = JSON.parse((e as MessageEvent).data);
        setLines((p) => [entry, ...p].slice(0, 200));
      } catch { /* ignore */ }
    });
    return () => es.close();
  }, []);

  // Click an IP on the traffic map -> filter the log to it, pull its history,
  // and scroll the live log into view.
  const pickIp = (ip: string) => {
    setFilter(ip);
    api.recentLogs(ip, 200).then(setLines).catch(() => {});
    setTimeout(() => logCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };
  // Block an IP globally (writes the shared nginx deny-list -> all services).
  const blockIp = (ip: string) => api.addBan(ip, "Blocked from traffic map").then(() => undefined);
  // Same block action for the Top source IPs panel, with per-IP feedback.
  const blockTop = async (ip: string) => {
    setBlockedTop((b) => ({ ...b, [ip]: "busy" }));
    try { await api.addBan(ip, "Blocked from top IPs"); setBlockedTop((b) => ({ ...b, [ip]: "done" })); }
    catch { setBlockedTop((b) => { const n = { ...b }; delete n[ip]; return n; }); }
  };

  const f = filter.trim().toLowerCase();
  const shown = f
    ? lines.filter((e) => e.host.toLowerCase().includes(f) || e.path.toLowerCase().includes(f) || e.ip.includes(f) || String(e.status) === f)
    : lines;

  // Country needs the GeoIP database (nginx resolves the source IP → country only
  // when it's installed). Tailor the empty state to the actual cause.
  const countryHint = geoip && !geoip.present
    ? "No country data yet - add the free GeoIP database under Settings → Country lock to map visitors by source country."
    : summary && summary.totalRequests === 0
      ? "No traffic yet."
      : "No located visitors yet - requests from your LAN / private IPs don't carry a country.";

  return (
    <>
      <div className="topbar">
        <h1>Logs</h1>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div className="range-tabs" role="tablist" aria-label="Metric">
            {METRICS.map((m) => (
              <button key={m} role="tab" aria-selected={metric === m} className={`range${metric === m ? " active" : ""}`} onClick={() => setMetric(m)}>{m === "requests" ? "Requests" : "Bandwidth"}</button>
            ))}
          </div>
          <div className="range-tabs" role="tablist" aria-label="Time range">
            {RANGES.map((r) => (
              <button key={r} role="tab" aria-selected={range === r} className={`range${range === r ? " active" : ""}`} onClick={() => setRange(r)}>
                {r === "live" ? <><span className="dot g" style={{ marginRight: 5 }} />live</> : r}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="content">
        {metricsError && !summary && (
          <div className="card state-note error" role="alert" style={{ marginBottom: 18 }}>
            <Icon.info />
            <div>Metrics aren't available.</div>
            <button className="btn btn-sm" onClick={retryMetrics}>Retry</button>
          </div>
        )}
        {summary && (
          <div className="stats">
            <div className="card stat"><div className="label">Requests</div><div className="value">{summary.totalRequests.toLocaleString()}</div></div>
            <div className="card stat"><div className="label">Bandwidth</div><div className="value">{fmtBytes(summary.totalBytes)}</div></div>
            <div className="card stat"><div className="label">Response p95</div><div className="value">{summary.p95}<small>ms</small></div></div>
            <div className="card stat"><div className="label">Error rate</div><div className="value" style={{ color: summary.errorRate > 5 ? "var(--yellow)" : "var(--green)" }}>{summary.errorRate}%</div></div>
          </div>
        )}

        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-head">Traffic <span className="pill n">{range === "live" ? "live" : range}</span></div>
          <TrafficChart range={range} metric={metric} />
        </div>

        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 18 }}>
          {summary && (
            <div className="card">
              <div className="card-head">Status codes</div>
              <div className="card-pad"><StatusCodeBars statusClass={summary.statusClass} /></div>
            </div>
          )}
          {summary && (
            <div className="card">
              <div className="card-head">Top source IPs <span className="pill n">click to filter</span></div>
              <div className="card-pad">
                <TopSourceIps ips={summary.topIps} blocked={blockedTop} onPick={pickIp} onBlock={blockTop} />
              </div>
            </div>
          )}
        </div>

        {summary && <TrafficMap countries={summary.topCountries ?? []} emptyHint={countryHint} homeCountry={homeCountry} onPickIp={pickIp} onBlockIp={blockIp} />}

        {summary && (
          <div className="card" style={{ marginBottom: 18 }}>
            <div className="card-head">Traffic by country</div>
            <div className="card-pad">
              <CountryBars countries={summary.topCountries ?? []} emptyHint={countryHint} />
            </div>
          </div>
        )}

        <div className="card" ref={logCardRef}>
          <div className="card-head">
            Live access log <span className="pill n">{shown.length} shown{filter ? " · filtered" : ""}{paused ? " · paused" : ""}</span>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
              <div className="search" style={{ maxWidth: 240 }}>
                <Icon.search />
                <input placeholder="Filter host, IP, status, path…" value={filter} onChange={(e) => setFilter(e.target.value)} />
                {filter && <button className="map-pop-x" title="Clear filter" onClick={() => setFilter("")} style={{ marginLeft: 2 }}><Icon.x /></button>}
              </div>
              <span className="pill g"><span className="dot g" />streaming</span>
              <button className="btn btn-sm" onClick={() => setPaused((p) => !p)}>{paused ? "Resume" : "Pause"}</button>
            </div>
          </div>
          <div className="card-pad" style={{ maxHeight: 460, overflow: "auto" }}>
            <div className="code" style={{ border: "none", padding: 0, background: "none", lineHeight: 1.9 }}>
              {shown.length === 0 && <div className="muted"><span className="spinner" /> {filter ? `No lines match "${filter}" yet…` : "Waiting for requests…"}</div>}
              {shown.map((e, i) => (
                <div key={i}>
                  <span style={{ color: statusColor(e.status), fontWeight: 700 }}>{e.status}</span>{" "}
                  {e.method.padEnd(4)} {e.host}{" "}
                  <span className="muted">{e.path}</span>{"  "}
                  <span style={{ color: "var(--text-faint)" }}>{e.ip} · {e.ms}ms</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="info-line" style={{ marginTop: 16 }}>
          <Icon.info />
          Live tail of the nginx access log. Metrics also export at <span className="mono">/api/metrics/prometheus</span> for Grafana.
        </div>
      </div>
    </>
  );
}
