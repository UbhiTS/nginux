import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type GeoipStatus, type LogEntry, type MetricsSummary } from "../api.ts";
import { Icon } from "../icons.tsx";
import { TrafficChart } from "./TrafficChart.tsx";
import { TrafficMap } from "./TrafficMapLazy.tsx";
import { StatusCodeBars, TopSourceIps, CountryBars } from "./AnalyticsPanels.tsx";
import { statusColor, fmtBytes } from "../format.ts";

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
  // The traffic section is controlled so we can gate the polling TrafficChart on
  // it: a collapsed (or background-tab) chart is unmounted, tearing down its
  // interval, instead of kept alive behind display:none and polling forever.
  const [trafficOpen, setTrafficOpen] = useState(false);
  const [docVisible, setDocVisible] = useState(!document.hidden);
  useEffect(() => {
    const onVis = () => setDocVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  const chartActive = trafficOpen && docVisible;

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

  const countryHint = geoip && !geoip.present
    ? "Add the free GeoIP database under Settings → Country lock to map visitors by source country."
    : "No located visitors yet — requests from your LAN / private IPs don't carry a country.";
  const loadingNote = loading && !summary ? <span className="muted"><span className="spinner" /> Loading…</span> : null;

  return (
    <div className="host-analytics" style={{ marginTop: 18 }}>
      <div className="section-title animate-rise" style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span className="ch-t"><Icon.activity /> Traffic &amp; logs</span>
        <div className="range-tabs" role="tablist" aria-label="Time range" style={{ marginLeft: "auto" }}>
          {RANGES.map((r) => (
            <button key={r} role="tab" aria-selected={range === r} className={`range${range === r ? " active" : ""}`} onClick={() => setRange(r)}>
              {r === "live" ? <><span className="dot g" style={{ marginRight: 5 }} />live</> : r}
            </button>
          ))}
        </div>
      </div>

      <Collapsible title={<><Icon.chart /> Traffic & errors</>} badge={<span className="pill n">{range}</span>} open={trafficOpen} onToggle={setTrafficOpen} onFirstOpen={() => setNeedSummary(true)}>
        <div className="card-pad">
          <div className="stats" style={{ marginBottom: 14 }}>
            <Kpi label="Requests" value={summary ? summary.totalRequests.toLocaleString() : (loadingNote ?? "—")} />
            <Kpi label="Bandwidth" value={summary ? fmtBytes(summary.totalBytes) : "—"} />
            <Kpi label="Response p95" value={summary ? summary.p95 : "—"} suffix={summary ? "ms" : undefined} />
            <Kpi label="Error rate" value={summary ? `${summary.errorRate}%` : "—"} color={summary && summary.errorRate > 5 ? "var(--yellow)" : "var(--green)"} />
          </div>
          <div className="range-tabs" role="tablist" aria-label="Chart metric" style={{ marginBottom: 6 }}>
            {(["requests", "bandwidth"] as const).map((m) => (
              <button key={m} role="tab" aria-selected={metric === m} className={`range${metric === m ? " active" : ""}`} onClick={() => setMetric(m)}>{m === "requests" ? "Requests" : "Bandwidth"}</button>
            ))}
          </div>
          {chartActive && <TrafficChart range={range} metric={metric} host={domain} />}
          {summary && (
            <div style={{ marginTop: 14 }}>
              <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 8 }}>Status codes</div>
              <StatusCodeBars statusClass={summary.statusClass} />
            </div>
          )}
        </div>
      </Collapsible>

      <Collapsible title={<><Icon.users /> Top clients & paths</>} onFirstOpen={() => setNeedSummary(true)}>
        <div className="card-pad">
          {loadingNote}
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 18 }}>
            <div>
              <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 8 }}>Top source IPs · click to filter the log</div>
              {summary && (
                <TopSourceIps ips={summary.topIps} blocked={blockedTop} onPick={pickIp} onBlock={blockTop}
                  pickTitle="Show this IP in the live log" emptyText="No traffic in this window." />
              )}
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

      <Collapsible title={<><Icon.globe /> Geography</>} onFirstOpen={() => { setNeedSummary(true); ensureGeo(); }}>
        <div className="card-pad">
          {loadingNote}
          {summary && <TrafficMap countries={summary.topCountries ?? []} emptyHint={countryHint} homeCountry={homeCountry} onPickIp={pickIp} onBlockIp={blockIp} />}
          {summary && (summary.topCountries ?? []).length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 8 }}>Traffic by country</div>
              <CountryBars countries={summary.topCountries} />
            </div>
          )}
        </div>
      </Collapsible>

      <Collapsible title={<><Icon.logs /> Live access log</>} keepMounted={false} open={logOpen} onToggle={setLogOpen}
        badge={logFilter ? <span className="pill n">filtered: {logFilter}</span> : undefined}>
        <HostLiveLog domain={domain} filter={logFilter} onClearFilter={() => setLogFilter("")} />
      </Collapsible>
    </div>
  );
}

/** Live, host-scoped access log. Holds the SSE only while mounted (i.e. while the
 *  section is expanded), so collapsing it closes the stream. */
/** A log line tagged with a stable, monotonic id assigned on arrival, so React
 *  keys rows by identity rather than array index. Keying by index made every
 *  prepend rewrite all ~200 rows (defeating the DOM diff and clearing any
 *  in-progress text selection); with a stable id it inserts just the new row. */
type KeyedLine = { id: number; entry: LogEntry };

function HostLiveLog({ domain, filter, onClearFilter }: { domain: string; filter: string; onClearFilter: () => void }) {
  const [lines, setLines] = useState<KeyedLine[]>([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false); pausedRef.current = paused;
  const seqRef = useRef(0);
  const dom = domain.toLowerCase();

  useEffect(() => {
    let alive = true;
    api.recentLogs(domain, 150)
      .then((ls) => { if (alive) setLines(ls.filter((e) => e.host.toLowerCase() === dom).map((entry) => ({ id: seqRef.current++, entry }))); })
      .catch(() => {});
    const es = new EventSource("/api/logs/stream", { withCredentials: true });
    es.addEventListener("log", (e) => {
      if (pausedRef.current) return;
      try {
        const entry: LogEntry = JSON.parse((e as MessageEvent).data);
        if (entry.host.toLowerCase() !== dom) return; // this service only
        setLines((p) => [{ id: seqRef.current++, entry }, ...p].slice(0, 200));
      } catch { /* ignore */ }
    });
    return () => es.close();
  }, [domain]); // eslint-disable-line react-hooks/exhaustive-deps

  const f = filter.trim().toLowerCase();
  const shown = f ? lines.filter(({ entry: e }) => e.ip.includes(f) || e.path.toLowerCase().includes(f) || String(e.status) === f) : lines;

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
        {shown.map(({ id, entry: e }) => (
          <div key={id}>
            <span style={{ color: statusColor(e.status), fontWeight: 700 }}>{e.status}</span>{" "}
            {e.method.padEnd(4)} <span className="muted">{e.path}</span>{"  "}
            <span style={{ color: "var(--text-faint)" }}>{e.ip} · {e.ms}ms</span>
          </div>
        ))}
      </div>
    </div>
  );
}
