import { type MetricsSummary } from "../api.ts";
import { Icon } from "../icons.tsx";
import { statusColor, flag, countryName } from "../format.ts";

// The three traffic-analytics panels that render straight off a MetricsSummary.
// They're shared verbatim by the global Logs page and the per-service
// HostAnalytics section so the two can't drift. Each is a pure presentational
// fragment (no card chrome) — the caller wraps it in whatever card/collapsible
// layout that page uses and owns the data fetch + click handlers.

/** Stacked 2xx/3xx/4xx/5xx bars, each sized to its share of the total. */
export function StatusCodeBars({ statusClass }: { statusClass: MetricsSummary["statusClass"] }) {
  const total = Object.values(statusClass).reduce((a, b) => a + b, 0) || 1;
  return (
    <>
      {(["2xx", "3xx", "4xx", "5xx"] as const).map((c) => (
        <div key={c} style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
            <span className="mono">{c}</span>
            <span className="muted">{statusClass[c]}</span>
          </div>
          <div style={{ height: 6, background: "var(--bg-elev2)", borderRadius: 4, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${(statusClass[c] / total) * 100}%`, background: statusColor(parseInt(c) * 100) }} />
          </div>
        </div>
      ))}
    </>
  );
}

/** Top source-IP list: each row filters the log on click and can be banned
 *  globally via the shield button (with per-IP busy/done feedback). */
export function TopSourceIps({
  ips, blocked, onPick, onBlock,
  pickTitle = "Show logs from this IP", emptyText = "No traffic yet.",
}: {
  ips: MetricsSummary["topIps"];
  blocked: Record<string, "busy" | "done">;
  onPick: (ip: string) => void;
  onBlock: (ip: string) => void;
  pickTitle?: string;
  emptyText?: string;
}) {
  return (
    <>
      {ips.map((t) => {
        const st = blocked[t.key];
        return (
          <div key={t.key} className="kv">
            <span className="k" style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <button className="map-ip-pick mono" style={{ flex: "0 1 auto" }} title={pickTitle} onClick={() => onPick(t.key)}>{t.key}</button>
              {t.country && <span className="muted" style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{flag(t.country)} {countryName(t.country)}</span>}
            </span>
            <span className="v" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {t.count}
              <button className={`map-ip-block${st === "done" ? " done" : ""}`} disabled={!!st}
                title={st === "done" ? "Blocked on all services" : "Block this IP on all services"} onClick={() => onBlock(t.key)}>
                {st === "done" ? <Icon.check /> : st === "busy" ? <span className="spinner" style={{ width: 11, height: 11 }} /> : <Icon.shield />}
              </button>
            </span>
          </div>
        );
      })}
      {ips.length === 0 && <div className="muted">{emptyText}</div>}
    </>
  );
}

/** Traffic-by-country bars, each relative to the busiest country. Renders
 *  `emptyHint` (if given) when there are no located visitors, else nothing. */
export function CountryBars({ countries, emptyHint }: { countries: MetricsSummary["topCountries"]; emptyHint?: string }) {
  if (countries.length === 0) return emptyHint ? <div className="muted" style={{ fontSize: 12.5 }}>{emptyHint}</div> : null;
  const max = countries[0].count || 1;
  return (
    <>
      {countries.map((c) => (
        <div key={c.key} style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
            <span>{flag(c.key)} {countryName(c.key)}</span>
            <span className="muted">{c.count}</span>
          </div>
          <div style={{ height: 6, background: "var(--bg-elev2)", borderRadius: 4, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${(c.count / max) * 100}%`, background: "var(--accent)" }} />
          </div>
        </div>
      ))}
    </>
  );
}
