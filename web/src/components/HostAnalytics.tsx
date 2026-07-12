import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type GeoipStatus, type LogEntry, type MetricsSummary } from "../api.ts";
import { Icon } from "../icons.tsx";
import { TrafficChart } from "./TrafficChart.tsx";
import { TrafficMap } from "./TrafficMap.tsx";
import { statusColor, flag, countryName, fmtBytes } from "../format.ts";

const RANGES = ["1h", "4h", "1d", "7d", "30d", "live"];

/** A lazy collapsible card: its children (and their data fetches) don't mount
 *  until it's first opened. `keepMounted` keeps them mounted-but-hidden after
 *  that (so the data is cached); set it false for things holding a live
 *  connection (the access-log stream) so collapsing tears the connection down. */
function Collapsible({
  title, badge, keepMounted = true, open: openProp, onToggle, onFirstOpen, children,
}: {
  title: ReactNode; badge?: ReactNode; keepMounted?: boolean;
  open?: boolean; onToggle?: (open: boolean) => void; onFirstOpen?: () => void; children: ReactNode;
}) {
  const [openState, setOpenState] = useState(false);
  const controlled = openProp !== undefined;
  const open = controlled ? !!openProp : openState;
  const [ever, setEver] = useState(false);
  useEffect(() => { if (open && !ever) { setEver(true); onFirstOpen?.(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = () => (controlled ? onToggle?.(!open) : setOpenState((o) => !o));
  return (
    <div className="card collapsible">
      <button type="button" className="collapsible-head" aria-expanded={open} onClick={toggle}>
        <Icon.chevron className={`collapsible-caret${open ? " open" : ""}`} />
        <span className="collapsible-title">{title}</span>
        {badge}
      </button>
      {ever && (keepMounted
        ? <div style={{ display: open ? "block" : "none" }}>{children}</div>
        : (open ? <div>{children}</div> : null))}
    </div>
  );
}

const Kpi = ({ label, value, suffix, color }: { label: string; value: ReactNode; suffix?: string; color?: string }) => (
  <div className="card stat" style={{ flex: 1 }}>
    <div className="label">{label}</div>
    <div className="value" style={color ? { color } : undefined}>{value}{suffix && <small>{suffix}</small>}</div>
  </div>
);

/** Per-service analytics, scoped to one host's domain. Each section loads on
 *  first expand (the summary is fetched once and shared across the panels that
 *  need it; the live log holds its own stream). */
export function HostAnalytics({ domain }: { domain: string }) {
  const [range, setRange] = useState("1d");
  const [metric, setMetric] = useState<"requests" | "bandwidth">("requests");
  const [summary, setSummary] = useState<MetricsSummary | null>(null);
  const [needSummary, setNeedSummary] = useState(false);
  const [loading, setLoading] = useState(false);
  const [geoip, setGeoip] = useState<GeoipStatus | null>(null);
  const [homeCountry, setHomeCountry] = useState("");
  // map / top-IP click → filter the live access log and open its section.
  const [logOpen, setLogOpen] = useState(false);
  const [logFilter, setLogFilter] = useState("");
  const [blockedTop, setBlockedTop] = useState<Record<string, "busy" | "done">>({});

  // Fetch the host summary once a summary-backed section opens; refetch on range.
  useEffect(() => {
    if (!needSummary) return;
    let alive = true; setLoading(true);
    api.hostMetrics(domain, range)
      .then((s) => { if (alive) setSummary(s); })
      .catch(() => { if (alive) setSummary(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [needSummary, range, domain]);

  const ensureGeo = () => {
    if (!geoip) api.geoipStatus().then(setGeoip).catch(() => {});
    if (!homeCountry) api.settings().then((s) => setHomeCountry(s.homeCountry || "")).catch(() => {});
  };
  const pickIp = (ip: string) => { setLogFilter(ip); setLogOpen(true); };
  const blockIp = (ip: string) => api.addBan(ip, "Blocked from service analytics").then(() => undefined);
  const blockTop = async (ip: string) => {
    setBlockedTop((b) => ({ ...b, [ip]: "busy" }));
    try { await api.addBan(ip, "Blocked from service analytics"); setBlockedTop((b) => ({ ...b, [ip]: "done" })); }
    catch { setBlockedTop((b) => { const n = { ...b }; delete n[ip]; return n; }); }
  };

  const totalStatus = summary ? Object.values(summary.statusClass).reduce((a, b) => a + b, 0) || 1 : 1;
  const countryHint = geoip && !geoip.present
    ? "Add the free GeoIP database under Settings → Country lock to map visitors by source country."
    : "No located visitors yet — requests from your LAN / private IPs don't carry a country.";
  const loadingNote = loading && !summary ? <span className="muted"><span className="spinner" /> Loading…</span> : null;

  return (
    <div className="host-analytics" style={{ marginTop: 18 }}>
      <div className="section-title" style={{ display: "flex", alignItems: "center", gap: 12 }}>
        Traffic &amp; logs
        <div className="range-tabs" style={{ marginLeft: "auto" }}>
          {RANGES.map((r) => (
            <button key={r} className={`range${range === r ? " active" : ""}`} onClick={() => setRange(r)}>
              {r === "live" ? <><span className="dot g" style={{ marginRight: 5 }} />live</> : r}
            </button>
          ))}
        </div>
      </div>

      <Collapsible title="Traffic & errors" badge={<span className="pill n">{range}</span>} onFirstOpen={() => setNeedSummary(true)}>
        <div className="card-pad">
          <div className="stats" style={{ marginBottom: 14 }}>
            <Kpi label="Requests" value={summary ? summary.totalRequests.toLocaleString() : (loadingNote ?? "—")} />
            <Kpi label="Bandwidth" value={summary ? fmtBytes(summary.totalBytes) : "—"} />
            <Kpi label="Response p95" value={summary ? summary.p95 : "—"} suffix={summary ? "ms" : undefined} />
            <Kpi label="Error rate" value={summary ? `${summary.errorRate}%` : "—"} color={summary && summary.errorRate > 5 ? "var(--yellow)" : "var(--green)"} />
          </div>
          <div className="range-tabs" style={{ marginBottom: 6 }}>
            {(["requests", "bandwidth"] as const).map((m) => (
              <button key={m} className={`range${metric === m ? " active" : ""}`} onClick={() => setMetric(m)}>{m === "requests" ? "Requests" : "Bandwidth"}</button>
            ))}
          </div>
          <TrafficChart range={range} metric={metric} host={domain} />
          {summary && (
            <div style={{ marginTop: 14 }}>
              <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 8 }}>Status codes</div>
              {(["2xx", "3xx", "4xx", "5xx"] as const).map((c) => (
                <div key={c} style={{ marginBottom: 9 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
                    <span className="mono">{c}</span><span className="muted">{summary.statusClass[c]}</span>
                  </div>
                  <div style={{ height: 6, background: "var(--bg-elev2)", borderRadius: 4, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${(summary.statusClass[c] / totalStatus) * 100}%`, background: statusColor(parseInt(c) * 100) }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Collapsible>

      <Collapsible title="Top clients & paths" onFirstOpen={() => setNeedSummary(true)}>
        <div className="card-pad">
          {loadingNote}
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 18 }}>
            <div>
              <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 8 }}>Top source IPs · click to filter the log</div>
              {summary?.topIps.map((t) => {
                const st = blockedTop[t.key];
                return (
                  <div key={t.key} className="kv">
                    <span className="k" style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <button className="map-ip-pick mono" style={{ flex: "0 1 auto" }} title="Show this IP in the live log" onClick={() => pickIp(t.key)}>{t.key}</button>
                      {t.country && <span className="muted" style={{ fontSize: 11.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{flag(t.country)} {countryName(t.country)}</span>}
                    </span>
                    <span className="v" style={{ display: "flex", alignItems: "center", gap: 8 }}>{t.count}
                      <button className={`map-ip-block${st === "done" ? " done" : ""}`} disabled={!!st} title={st === "done" ? "Blocked on all services" : "Block this IP on all services"} onClick={() => blockTop(t.key)}>
                        {st === "done" ? <Icon.check /> : st === "busy" ? <span className="spinner" style={{ width: 11, height: 11 }} /> : <Icon.shield />}
                      </button>
                    </span>
                  </div>
                );
              })}
              {summary && summary.topIps.length === 0 && <div className="muted">No traffic in this window.</div>}
            </div>
            <div>
              <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 8 }}>Top paths</div>
              {summary?.topPaths.map((t) => (
                <div key={t.key} className="kv"><span className="k mono" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.key}</span><span className="v">{t.count}</span></div>
              ))}
              {summary && summary.topPaths.length === 0 && <div className="muted">No traffic in this window.</div>}
            </div>
          </div>
        </div>
      </Collapsible>

      <Collapsible title="Geography" onFirstOpen={() => { setNeedSummary(true); ensureGeo(); }}>
        <div className="card-pad">
          {loadingNote}
          {summary && <TrafficMap countries={summary.topCountries ?? []} emptyHint={countryHint} homeCountry={homeCountry} onPickIp={pickIp} onBlockIp={blockIp} />}
          {summary && (summary.topCountries ?? []).length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 8 }}>Traffic by country</div>
              {summary.topCountries.map((c) => {
                const max = summary.topCountries[0].count || 1;
                return (
                  <div key={c.key} style={{ marginBottom: 9 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
                      <span>{flag(c.key)} {countryName(c.key)}</span><span className="muted">{c.count}</span>
                    </div>
                    <div style={{ height: 6, background: "var(--bg-elev2)", borderRadius: 4, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${(c.count / max) * 100}%`, background: "var(--accent)" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Collapsible>

      <Collapsible title="Live access log" keepMounted={false} open={logOpen} onToggle={setLogOpen}
        badge={logFilter ? <span className="pill n">filtered: {logFilter}</span> : undefined}>
        <HostLiveLog domain={domain} filter={logFilter} onClearFilter={() => setLogFilter("")} />
      </Collapsible>
    </div>
  );
}

/** Live, host-scoped access log. Holds the SSE only while mounted (i.e. while the
 *  section is expanded), so collapsing it closes the stream. */
function HostLiveLog({ domain, filter, onClearFilter }: { domain: string; filter: string; onClearFilter: () => void }) {
  const [lines, setLines] = useState<LogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false); pausedRef.current = paused;
  const dom = domain.toLowerCase();

  useEffect(() => {
    let alive = true;
    api.recentLogs(domain, 150).then((ls) => { if (alive) setLines(ls.filter((e) => e.host.toLowerCase() === dom)); }).catch(() => {});
    const es = new EventSource("/api/logs/stream", { withCredentials: true });
    es.addEventListener("log", (e) => {
      if (pausedRef.current) return;
      try {
        const entry: LogEntry = JSON.parse((e as MessageEvent).data);
        if (entry.host.toLowerCase() !== dom) return; // this service only
        setLines((p) => [entry, ...p].slice(0, 200));
      } catch { /* ignore */ }
    });
    return () => es.close();
  }, [domain]); // eslint-disable-line react-hooks/exhaustive-deps

  const f = filter.trim().toLowerCase();
  const shown = f ? lines.filter((e) => e.ip.includes(f) || e.path.toLowerCase().includes(f) || String(e.status) === f) : lines;

  return (
    <div className="card-pad">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <span className="pill g"><span className="dot g" />streaming</span>
        <span className="muted" style={{ fontSize: 12 }}>{shown.length} shown{filter ? ` · filtered: ${filter}` : ""}</span>
        {filter && <button className="btn btn-ghost btn-sm" onClick={onClearFilter}>Clear filter</button>}
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => setPaused((p) => !p)}>{paused ? "Resume" : "Pause"}</button>
      </div>
      <div className="code" style={{ border: "none", padding: 0, background: "none", lineHeight: 1.9, maxHeight: 420, overflow: "auto" }}>
        {shown.length === 0 && <div className="muted"><span className="spinner" /> {filter ? `No lines match "${filter}" yet…` : "Waiting for requests to this service…"}</div>}
        {shown.map((e, i) => (
          <div key={i}>
            <span style={{ color: statusColor(e.status), fontWeight: 700 }}>{e.status}</span>{" "}
            {e.method.padEnd(4)} <span className="muted">{e.path}</span>{"  "}
            <span style={{ color: "var(--text-faint)" }}>{e.ip} · {e.ms}ms</span>
          </div>
        ))}
      </div>
    </div>
  );
}
