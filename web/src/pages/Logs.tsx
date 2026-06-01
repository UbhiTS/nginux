import { useEffect, useRef, useState } from "react";
import { api, type GeoipStatus, type LogEntry, type MetricsSummary } from "../api.ts";
import { Icon } from "../icons.tsx";
import { WORLD_LAND } from "../components/worldland.ts";
import { TrafficChart } from "../components/TrafficChart.tsx";

const RANGES = ["1h", "4h", "1d", "7d", "30d", "live"];

const statusColor = (s: number) =>
  s >= 500 ? "var(--red)" : s >= 400 ? "var(--yellow)" : s >= 300 ? "var(--accent)" : "var(--green)";

const flag = (cc: string) =>
  cc.length === 2 ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 127397 + c.charCodeAt(0))) : "🌐";

// ISO 3166 code -> full name via the browser (no data file); falls back to the code.
const regionNames = (() => { try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch { return null; } })();
const countryName = (cc: string) =>
  cc && cc.length === 2 && regionNames ? (regionNames.of(cc.toUpperCase()) ?? cc) : cc || "";

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

const W = 640, H = 320;
const proj = (lat: number, lon: number): [number, number] => [((lon + 180) / 360) * W, ((90 - lat) / 180) * H];
// Build an SVG path from a flat [lon,lat,lon,lat,...] land ring (equirectangular).
const landPath = (ring: number[]) => {
  let d = "";
  for (let i = 0; i < ring.length; i += 2) {
    const [x, y] = proj(ring[i + 1], ring[i]);
    d += (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1);
  }
  return d + "Z";
};

function TrafficMap({ countries, emptyHint }: { countries: MetricsSummary["topCountries"]; emptyHint?: string }) {
  const max = Math.max(1, ...countries.map((c) => c.count));
  const [hover, setHover] = useState<{ c: MetricsSummary["topCountries"][number]; x: number; y: number } | null>(null);
  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-head">Traffic map <span className="pill n">by source country</span></div>
      <div className="card-pad">
        <div style={{ position: "relative" }}>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block", background: "var(--bg)", borderRadius: 8 }}>
            <g>
              {WORLD_LAND.map((ring, i) => (
                <path key={i} d={landPath(ring)} fill="var(--bg-elev2)" stroke="var(--border)" strokeWidth={0.4} />
              ))}
            </g>
            {countries.map((c) => {
              const ctr = CENTROIDS[c.key.toUpperCase()];
              if (!ctr) return null;
              const [x, y] = proj(ctr[0], ctr[1]);
              const r = 4 + (c.count / max) * 14;
              const on = hover?.c.key === c.key;
              return (
                <g key={c.key} style={{ cursor: "pointer" }} onMouseEnter={() => setHover({ c, x, y })} onMouseLeave={() => setHover(null)}>
                  <circle cx={x} cy={y} r={r} fill="var(--accent)" fillOpacity={on ? 0.75 : 0.45} stroke="var(--accent)" strokeWidth={on ? 1.8 : 1} />
                  <text x={x} y={y + 3} textAnchor="middle" fontSize={9} fill="var(--text)" style={{ pointerEvents: "none", fontWeight: 600 }}>{c.key}</text>
                </g>
              );
            })}
          </svg>
          {hover && (
            <div style={{
              position: "absolute",
              left: `${(hover.x / W) * 100}%`,
              top: `${(hover.y / H) * 100}%`,
              transform: `translate(${hover.x < W * 0.25 ? "0%" : hover.x > W * 0.75 ? "-100%" : "-50%"}, ${hover.y < H * 0.4 ? "16px" : "calc(-100% - 16px)"})`,
              background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 8,
              padding: "8px 10px", boxShadow: "var(--shadow)", minWidth: 160, pointerEvents: "none", zIndex: 5,
            }}>
              <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: hover.c.topIps.length ? 6 : 0 }}>
                {flag(hover.c.key)} {countryName(hover.c.key)} <span className="muted" style={{ fontWeight: 400 }}>· {hover.c.count} req</span>
              </div>
              {hover.c.topIps.length > 0 && (
                <div style={{ borderTop: "1px solid var(--border-soft)", paddingTop: 5 }}>
                  <div className="muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 3 }}>Top IPs</div>
                  {hover.c.topIps.map((t) => (
                    <div key={t.ip} style={{ display: "flex", justifyContent: "space-between", gap: 14, fontSize: 11.5 }}>
                      <span className="mono">{t.ip}</span><span className="muted">{t.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        {countries.length === 0 && emptyHint && (
          <div className="muted" style={{ fontSize: 12.5, textAlign: "center", marginTop: 10 }}>{emptyHint}</div>
        )}
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
  const [geoip, setGeoip] = useState<GeoipStatus | null>(null);
  const [lines, setLines] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [paused, setPaused] = useState(false);
  const [range, setRange] = useState("1h");
  const [metric, setMetric] = useState<"requests" | "bandwidth">("requests");
  const pausedRef = useRef(false);
  const filterRef = useRef("");
  pausedRef.current = paused;
  filterRef.current = filter;

  // Range-scoped summary: every analytics panel reflects the selected window.
  useEffect(() => {
    let alive = true;
    const pull = () => api.metricsSummary(range).then((s) => { if (alive) setSummary(s); }).catch(() => {});
    pull();
    const poll = setInterval(pull, range === "live" ? 3000 : 6000);
    return () => { alive = false; clearInterval(poll); };
  }, [range]);

  // Live tail + GeoIP status (independent of the analytics range).
  useEffect(() => {
    api.geoipStatus().then(setGeoip).catch(() => {});
    api.recentLogs(undefined, 100).then(setLines).catch(() => {});
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
    return () => es.close();
  }, []);

  const totalStatus = summary ? Object.values(summary.statusClass).reduce((a, b) => a + b, 0) || 1 : 1;

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
                  <div key={t.key} className="kv">
                    <span className="k" style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <span className="mono">{t.key}</span>
                      {t.country && <span className="muted" style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{flag(t.country)} {countryName(t.country)}</span>}
                    </span>
                    <span className="v">{t.count}</span>
                  </div>
                ))}
                {summary.topIps.length === 0 && <div className="muted">No traffic yet.</div>}
              </div>
            </div>
          )}
        </div>

        {summary && <TrafficMap countries={summary.topCountries ?? []} emptyHint={countryHint} />}

        {summary && (
          <div className="card" style={{ marginBottom: 18 }}>
            <div className="card-head">Traffic by country</div>
            <div className="card-pad">
              {(summary.topCountries ?? []).length === 0 && (
                <div className="muted" style={{ fontSize: 12.5 }}>{countryHint}</div>
              )}
              {(summary.topCountries ?? []).map((c) => {
                const max = summary.topCountries[0].count || 1;
                return (
                  <div key={c.key} style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
                      <span>{flag(c.key)} {countryName(c.key)}</span>
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
          <div className="card-head">
            Live access log <span className="pill n">{lines.length} shown{paused ? " · paused" : ""}</span>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
              <div className="search" style={{ maxWidth: 240 }}>
                <Icon.search />
                <input placeholder="Filter host, IP, status, path…" value={filter} onChange={(e) => setFilter(e.target.value)} />
              </div>
              <span className="pill g"><span className="dot g" />streaming</span>
              <button className="btn btn-sm" onClick={() => setPaused((p) => !p)}>{paused ? "Resume" : "Pause"}</button>
            </div>
          </div>
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
