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

function TrafficMap({ countries, emptyHint, homeCountry, onPickIp, onBlockIp }: {
  countries: MetricsSummary["topCountries"];
  emptyHint?: string;
  homeCountry?: string;
  onPickIp: (ip: string) => void;
  onBlockIp: (ip: string) => Promise<void>;
}) {
  const max = Math.max(1, ...countries.map((c) => c.count));
  // The popup stays open while the cursor is over a bubble OR the popup itself,
  // and auto-closes 3s after the cursor leaves both (or immediately via the X).
  const [open, setOpen] = useState<{ c: MetricsSummary["topCountries"][number]; x: number; y: number } | null>(null);
  const [blocked, setBlocked] = useState<Record<string, "busy" | "done">>({});
  const closeTimer = useRef<number | null>(null);
  const cancelClose = () => { if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; } };
  const scheduleClose = () => { cancelClose(); closeTimer.current = window.setTimeout(() => setOpen(null), 3000); };
  useEffect(() => () => cancelClose(), []);

  const homeCc = homeCountry?.toUpperCase();
  const homeCtr = homeCc ? CENTROIDS[homeCc] : undefined;
  const home = homeCtr ? proj(homeCtr[0], homeCtr[1]) : null;

  const block = async (ip: string) => {
    setBlocked((b) => ({ ...b, [ip]: "busy" }));
    try { await onBlockIp(ip); setBlocked((b) => ({ ...b, [ip]: "done" })); }
    catch { setBlocked((b) => { const n = { ...b }; delete n[ip]; return n; }); }
  };

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-head">Traffic map <span className="pill n">by source country</span>
        {home && <span className="muted" style={{ fontSize: 11, marginLeft: "auto", fontWeight: 400 }}>arcs converge on {flag(homeCc!)} {countryName(homeCc!)}</span>}
      </div>
      <div className="card-pad">
        <div style={{ position: "relative" }}>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block", background: "var(--bg)", borderRadius: 8 }}>
            <g>
              {WORLD_LAND.map((ring, i) => (
                <path key={i} d={landPath(ring)} fill="var(--bg-elev2)" stroke="var(--border)" strokeWidth={0.4} />
              ))}
            </g>
            {/* Thin solid arc from each source to home, with one dot travelling
                source -> home -> source at constant speed (like the Network Map).
                Curvature scales with length (no cap) so near and far arcs share
                the same shape. */}
            {home && countries.map((c) => {
              const ctr = CENTROIDS[c.key.toUpperCase()];
              if (!ctr || c.key.toUpperCase() === homeCc) return null;
              const [x, y] = proj(ctr[0], ctr[1]);
              const dx = home[0] - x, dy = home[1] - y, len = Math.hypot(dx, dy) || 1;
              const off = len * 0.16; // proportional bulge -> consistent curvature
              const cx = (x + home[0]) / 2 + (-dy / len) * off, cy = (y + home[1]) / 2 + (dx / len) * off;
              const d = `M${x.toFixed(1)} ${y.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${home[0].toFixed(1)} ${home[1].toFixed(1)}`;
              const dur = Math.max(2, (len * 2.2) / 130).toFixed(2); // ~constant px/sec, both ways
              return (
                <g key={"arc-" + c.key}>
                  <path d={d} fill="none" stroke="var(--accent)" strokeWidth={0.6} strokeOpacity={0.2} strokeLinecap="round" />
                  <circle r={2.0} fill="var(--accent)">
                    <animateMotion path={d} dur={`${dur}s`} repeatCount="indefinite" keyPoints="0;1;0" keyTimes="0;0.5;1" calcMode="linear" />
                  </circle>
                </g>
              );
            })}
            {home && <circle cx={home[0]} cy={home[1]} r={4.5} fill="var(--green)" stroke="var(--green)" strokeOpacity={0.4} strokeWidth={3} />}
            {countries.map((c) => {
              const ctr = CENTROIDS[c.key.toUpperCase()];
              if (!ctr) return null;
              const [x, y] = proj(ctr[0], ctr[1]);
              const r = 4 + (c.count / max) * 14;
              const on = open?.c.key === c.key;
              return (
                <g key={c.key} style={{ cursor: "pointer" }} onMouseEnter={() => { cancelClose(); setOpen({ c, x, y }); }} onMouseLeave={scheduleClose}>
                  <circle cx={x} cy={y} r={r} fill="var(--accent)" fillOpacity={on ? 0.8 : 0.45} stroke="var(--accent)" strokeWidth={on ? 1.8 : 1} />
                  <text x={x} y={y + 3} textAnchor="middle" fontSize={9} fill="var(--text)" style={{ pointerEvents: "none", fontWeight: 600 }}>{c.key}</text>
                </g>
              );
            })}
          </svg>
          {open && (
            <div onMouseEnter={cancelClose} onMouseLeave={scheduleClose} style={{
              position: "absolute",
              left: `${(open.x / W) * 100}%`,
              top: `${(open.y / H) * 100}%`,
              transform: `translate(${open.x < W * 0.25 ? "0%" : open.x > W * 0.75 ? "-100%" : "-50%"}, ${open.y < H * 0.4 ? "16px" : "calc(-100% - 16px)"})`,
              background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 8,
              padding: "8px 10px", boxShadow: "var(--shadow)", minWidth: 200, zIndex: 5,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: open.c.topIps.length ? 6 : 0 }}>
                <div style={{ fontWeight: 600, fontSize: 12.5, flex: 1 }}>
                  {flag(open.c.key)} {countryName(open.c.key)} <span className="muted" style={{ fontWeight: 400 }}>· {open.c.count} req</span>
                </div>
                <button className="map-pop-x" title="Close" onClick={() => { cancelClose(); setOpen(null); }}><Icon.x /></button>
              </div>
              {open.c.topIps.length > 0 && (
                <div style={{ borderTop: "1px solid var(--border-soft)", paddingTop: 5 }}>
                  <div className="muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 4 }}>Top IPs · click to filter</div>
                  {open.c.topIps.map((t) => {
                    const st = blocked[t.ip];
                    return (
                      <div key={t.ip} className="map-ip">
                        <button className="map-ip-pick mono" title="Show logs from this IP" onClick={() => onPickIp(t.ip)}>{t.ip}</button>
                        <span className="muted">{t.count}</span>
                        <button className={`map-ip-block${st === "done" ? " done" : ""}`} disabled={!!st}
                          title={st === "done" ? "Blocked on all services" : "Block this IP on all services"}
                          onClick={() => block(t.ip)}>
                          {st === "done" ? <Icon.check /> : st === "busy" ? <span className="spinner" style={{ width: 11, height: 11 }} /> : <Icon.shield />}
                        </button>
                      </div>
                    );
                  })}
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
              <div className="card-head">Top source IPs <span className="pill n">click to filter</span></div>
              <div className="card-pad">
                {summary.topIps.map((t) => {
                  const st = blockedTop[t.key];
                  return (
                    <div key={t.key} className="kv">
                      <span className="k" style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <button className="map-ip-pick mono" style={{ flex: "0 1 auto" }} title="Show logs from this IP" onClick={() => pickIp(t.key)}>{t.key}</button>
                        {t.country && <span className="muted" style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{flag(t.country)} {countryName(t.country)}</span>}
                      </span>
                      <span className="v" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {t.count}
                        <button className={`map-ip-block${st === "done" ? " done" : ""}`} disabled={!!st}
                          title={st === "done" ? "Blocked on all services" : "Block this IP on all services"} onClick={() => blockTop(t.key)}>
                          {st === "done" ? <Icon.check /> : st === "busy" ? <span className="spinner" style={{ width: 11, height: 11 }} /> : <Icon.shield />}
                        </button>
                      </span>
                    </div>
                  );
                })}
                {summary.topIps.length === 0 && <div className="muted">No traffic yet.</div>}
              </div>
            </div>
          )}
        </div>

        {summary && <TrafficMap countries={summary.topCountries ?? []} emptyHint={countryHint} homeCountry={homeCountry} onPickIp={pickIp} onBlockIp={blockIp} />}

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
