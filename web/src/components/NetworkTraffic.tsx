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
  // When a service is hovered, both views scope to it (graph filters, map shows
  // only that service's dots).
  const [hovered, setHovered] = useState<string | null>(null);

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-head">
        Network &amp; traffic
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
        <Topology data={data} navigate={navigate} range={range} metric={metric} hovered={hovered} onHover={setHovered} />
      ) : (
        <div className="placeholder"><span className="spinner" /> Loading network map…</div>
      )}

      <div style={{ borderTop: "1px solid var(--border)" }}>
        <TrafficChart range={range} metric={metric} host={hovered} />
      </div>
    </div>
  );
}
