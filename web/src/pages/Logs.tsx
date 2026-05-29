import { useEffect, useRef, useState } from "react";
import { api, type LogEntry, type MetricsSummary } from "../api.ts";
import { Icon } from "../icons.tsx";

const statusColor = (s: number) =>
  s >= 500 ? "var(--red)" : s >= 400 ? "var(--yellow)" : s >= 300 ? "var(--accent)" : "var(--green)";

const flag = (cc: string) =>
  cc.length === 2 ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 127397 + c.charCodeAt(0))) : "🌐";

// Rough country centroids [lat, lon] for the traffic bubble map.
const CENTROIDS: Record<string, [number, number]> = {
  CA: [56, -106], US: [38, -97], MX: [23, -102], BR: [-10, -55], AR: [-38, -63],
  GB: [54, -2], IE: [53, -8], FR: [46, 2], DE: [51, 10], NL: [52, 5], ES: [40, -4],
  PT: [39, -8], IT: [42, 12], CH: [47, 8], SE: [62, 15], NO: [62, 10], FI: [64, 26],
  PL: [52, 19], RU: [61, 90], UA: [48, 31], TR: [39, 35], IN: [21, 78], CN: [35, 103],
  JP: [36, 138], KR: [36, 128], SG: [1, 104], AU: [-25, 133], NZ: [-41, 174],
  ZA: [-29, 24], NG: [9, 8], EG: [26, 30], AE: [24, 54], SA: [24, 45], IL: [31, 35],
  ID: [-2, 118], TH: [15, 101], VN: [16, 108], PH: [13, 122], MY: [4, 102], HK: [22, 114], TW: [24, 121],
};

function TrafficMap({ countries }: { countries: { key: string; count: number }[] }) {
  const W = 640, H = 320;
  const proj = (lat: number, lon: number) => [((lon + 180) / 360) * W, ((90 - lat) / 180) * H];
  const max = Math.max(1, ...countries.map((c) => c.count));
  const grat: React.ReactNode[] = [];
  for (let lon = -180; lon <= 180; lon += 30) grat.push(<line key={"v" + lon} x1={proj(0, lon)[0]} y1={0} x2={proj(0, lon)[0]} y2={H} stroke="var(--border-soft)" strokeWidth={0.5} />);
  for (let lat = -60; lat <= 90; lat += 30) grat.push(<line key={"h" + lat} x1={0} y1={proj(lat, 0)[1]} x2={W} y2={proj(lat, 0)[1]} stroke="var(--border-soft)" strokeWidth={0.5} />);
  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-head">Traffic map <span className="pill n">by source country</span></div>
      <div className="card-pad">
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block", background: "var(--bg)", borderRadius: 8 }}>
          {grat}
          {countries.map((c) => {
            const ctr = CENTROIDS[c.key.toUpperCase()];
            if (!ctr) return null;
            const [x, y] = proj(ctr[0], ctr[1]);
            const r = 4 + (c.count / max) * 14;
            return (
              <g key={c.key}>
                <circle cx={x} cy={y} r={r} fill="var(--accent)" fillOpacity={0.35} stroke="var(--accent)" strokeWidth={1}>
                  <title>{flag(c.key)} {c.key}: {c.count} requests</title>
                </circle>
                <text x={x} y={y + 3} textAnchor="middle" fontSize={9} fill="var(--text)" style={{ pointerEvents: "none" }}>{c.key}</text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + " KB";
  return n + " B";
}

export function Logs() {
  const [summary, setSummary] = useState<MetricsSummary | null>(null);
  const [lines, setLines] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const filterRef = useRef("");
  pausedRef.current = paused;
  filterRef.current = filter;

  useEffect(() => {
    api.metricsSummary().then(setSummary).catch(() => {});
    api.recentLogs(undefined, 100).then(setLines).catch(() => {});
    const poll = setInterval(() => api.metricsSummary().then(setSummary).catch(() => {}), 4000);

    const es = new EventSource("/api/logs/stream", { withCredentials: true });
    es.addEventListener("log", (e) => {
      if (pausedRef.current) return;
      try {
        const entry: LogEntry = JSON.parse((e as MessageEvent).data);
        const f = filterRef.current.toLowerCase();
        if (f && !(entry.host.includes(f) || entry.path.toLowerCase().includes(f) || entry.ip.includes(f) || String(entry.status) === f)) return;
        setLines((p) => [entry, ...p].slice(0, 150));
      } catch { /* ignore */ }
    });
    return () => { clearInterval(poll); es.close(); };
  }, []);

  const totalStatus = summary ? Object.values(summary.statusClass).reduce((a, b) => a + b, 0) || 1 : 1;

  return (
    <>
      <div className="topbar">
        <h1>Logs</h1>
        <div className="search" style={{ maxWidth: 300 }}>
          <Icon.search />
          <input placeholder="Filter by host, IP, status, path…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div style={{ flex: 1 }} />
        <span className="pill g"><span className="dot g" />streaming</span>
        <button className="btn btn-sm" onClick={() => setPaused((p) => !p)}>{paused ? "Resume" : "Pause"}</button>
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

        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 18 }}>
          {summary && (
            <div className="card">
              <div className="card-head">Status codes</div>
              <div className="card-pad">
                {(["2xx", "3xx", "4xx", "5xx"] as const).map((c) => (
                  <div key={c} style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
                      <span className="mono">{c}</span>
                      <span className="muted">{summary.statusClass[c]}</span>
                    </div>
                    <div style={{ height: 6, background: "var(--bg-elev2)", borderRadius: 4, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${(summary.statusClass[c] / totalStatus) * 100}%`, background: statusColor(parseInt(c) * 100) }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {summary && (
            <div className="card">
              <div className="card-head">Top source IPs</div>
              <div className="card-pad">
                {summary.topIps.map((t) => (
                  <div key={t.key} className="kv"><span className="k mono">{t.key}</span><span className="v">{t.count}</span></div>
                ))}
                {summary.topIps.length === 0 && <div className="muted">No traffic yet.</div>}
              </div>
            </div>
          )}
        </div>

        {summary && summary.topCountries && summary.topCountries.length > 0 && (
          <TrafficMap countries={summary.topCountries} />
        )}

        {summary && summary.topCountries && summary.topCountries.length > 0 && (
          <div className="card" style={{ marginBottom: 18 }}>
            <div className="card-head">Traffic by country</div>
            <div className="card-pad">
              {summary.topCountries.map((c) => {
                const max = summary.topCountries[0].count || 1;
                return (
                  <div key={c.key} style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
                      <span>{flag(c.key)} {c.key}</span>
                      <span className="muted">{c.count}</span>
                    </div>
                    <div style={{ height: 6, background: "var(--bg-elev2)", borderRadius: 4, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${(c.count / max) * 100}%`, background: "var(--accent)" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="card">
          <div className="card-head">Live access log <span className="pill n">{lines.length} shown{paused ? " · paused" : ""}</span></div>
          <div className="card-pad" style={{ maxHeight: 460, overflow: "auto" }}>
            <div className="code" style={{ border: "none", padding: 0, background: "none", lineHeight: 1.9 }}>
              {lines.length === 0 && <div className="muted"><span className="spinner" /> Waiting for requests…</div>}
              {lines.map((e, i) => (
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
