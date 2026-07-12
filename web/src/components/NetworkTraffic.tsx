import { useState } from "react";
import type { Route } from "../App.tsx";
import type { Topology as TopologyData } from "../types.ts";
import { Topology } from "./Topology.tsx";
import { TrafficChart } from "./TrafficChart.tsx";

const RANGES = ["1h", "4h", "1d", "7d", "30d", "live"];

/** Network map (where traffic flows) + traffic graph (when it flows) in one
 *  card, sharing a single metric (requests/bandwidth) and time-range control. */
export function NetworkTraffic({
  data,
  navigate,
}: {
  data: TopologyData | null;
  navigate: (r: Route) => void;
}) {
  const [metric, setMetric] = useState<"requests" | "bandwidth">("requests");
  const [range, setRange] = useState("live");
  // Click-to-pin scoping: clicking a service tile pins BOTH views to it (graph
  // filters, map shows only that service's dots). Clicking it again (or the chip)
  // clears. Pinning replaces the old hover-to-scope, which released the instant the
  // pointer moved off the tile toward the graph.
  const [scoped, setScoped] = useState<string | null>(null);
  const toggleScope = (domain: string) => setScoped((cur) => (cur === domain ? null : domain));

  const scopedName = scoped
    ? data?.servers.flatMap((s) => s.services).find((x) => x.domain === scoped)?.name ?? scoped
    : null;

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-head">
        Network &amp; traffic
        {scoped && (
          <button
            type="button"
            onClick={() => setScoped(null)}
            aria-label={`Clear filter — currently showing ${scopedName}`}
            title="Clear filter"
            style={{
              marginLeft: 12,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "2px 8px 2px 10px",
              fontSize: "var(--fs-xs)",
              fontWeight: 600,
              lineHeight: 1.6,
              color: "var(--text)",
              background: "var(--accent-soft, rgba(59,130,246,.15))",
              border: "1px solid var(--accent)",
              borderRadius: "var(--radius-pill, 999px)",
              cursor: "pointer",
            }}
          >
            <span style={{ color: "var(--text-dim)" }}>Showing:</span> {scopedName}
            <span aria-hidden="true" style={{ fontSize: "1.1em", lineHeight: 1 }}>✕</span>
          </button>
        )}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div className="range-tabs">
            {(["requests", "bandwidth"] as const).map((m) => (
              <button key={m} className={`range${metric === m ? " active" : ""}`} onClick={() => setMetric(m)}>
                {m === "requests" ? "Requests" : "Bandwidth"}
              </button>
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

      {data ? (
        <Topology data={data} navigate={navigate} range={range} scoped={scoped} onScope={toggleScope} />
      ) : (
        <div className="placeholder"><span className="spinner" /> Loading network map…</div>
      )}

      <div style={{ borderTop: "1px solid var(--border)" }}>
        <TrafficChart range={range} metric={metric} host={scoped} />
      </div>
    </div>
  );
}
