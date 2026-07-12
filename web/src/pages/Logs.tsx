import { useEffect, useRef, useState } from "react";
import { api, type GeoipStatus, type LogEntry, type MetricsSummary } from "../api.ts";
import { Icon } from "../icons.tsx";
import { TrafficChart } from "../components/TrafficChart.tsx";
import { TrafficMap } from "../components/TrafficMap.tsx";
import { StatusCodeBars, TopSourceIps, CountryBars } from "../components/AnalyticsPanels.tsx";
import { statusColor, fmtBytes } from "../format.ts";

const RANGES = ["1h", "4h", "1d", "7d", "30d", "live"];

export function Logs() {
  const [summary, setSummary] = useState<MetricsSummary | null>(null);
  const [geoip, setGeoip] = useState<GeoipStatus | null>(null);
  const [lines, setLines] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [paused, setPaused] = useState(false);
  const [range, setRange] = useState("1h");
  const [metric, setMetric] = useState<"requests" | "bandwidth">("requests");
  const [homeCountry, setHomeCountry] = useState("");
  const [blockedTop, setBlockedTop] = useState<Record<string, "busy" | "done">>({});
  const pausedRef = useRef(false);
  const logCardRef = useRef<HTMLDivElement>(null);
  pausedRef.current = paused;

  // Range-scoped summary: every analytics panel reflects the selected window.
  useEffect(() => {
    let alive = true;
    const pull = () => api.metricsSummary(range).then((s) => { if (alive) setSummary(s); }).catch(() => {});
    pull();
    const poll = setInterval(pull, range === "live" ? 3000 : 6000);
    return () => { alive = false; clearInterval(poll); };
  }, [range]);

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
          <div className="range-tabs">
            {(["requests", "bandwidth"] as const).map((m) => (
              <button key={m} className={`range${metric === m ? " active" : ""}`} onClick={() => setMetric(m)}>{m === "requests" ? "Requests" : "Bandwidth"}</button>
            ))}
          </div>
          <div className="range-tabs">
            {RANGES.map((r) => (
              <button key={r} className={`range${range === r ? " active" : ""}`} onClick={() => setRange(r)}>
                {r === "live" ? <><span className="dot g" style={{ marginRight: 5 }} />live</> : r}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="content">
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
