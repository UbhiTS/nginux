import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type { Traffic } from "../types.ts";

const RANGES = ["1h", "4h", "1d", "7d", "30d"];

export function TrafficChart() {
  const [range, setRange] = useState("1d");
  const [traffic, setTraffic] = useState<Traffic | null>(null);

  useEffect(() => {
    api.traffic(range).then(setTraffic).catch(() => setTraffic(null));
  }, [range]);

  return (
    <div className="card">
      <div className="card-head">
        Traffic
        <div className="range-tabs">
          {RANGES.map((r) => (
            <button
              key={r}
              className={`range${range === r ? " active" : ""}`}
              onClick={() => setRange(r)}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      <div className="card-pad">
        {traffic && (
          <>
            <div style={{ display: "flex", gap: 26, marginBottom: 12 }}>
              <Metric label="Requests" value={traffic.total} />
              <Metric label="Peak" value={traffic.peak} suffix={traffic.unit} />
              <Metric label="Avg p95" value="112" suffix="ms" />
            </div>
            <Chart data={traffic.data} />
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 11,
                color: "var(--text-faint)",
                marginTop: 6,
              }}
            >
              {traffic.axis.map((a) => (
                <span key={a}>{a}</span>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, suffix }: { label: string; value: string; suffix?: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          color: "var(--text-faint)",
          textTransform: "uppercase",
          letterSpacing: ".5px",
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700 }}>
        {value}
        {suffix && <small style={{ fontSize: 12, color: "var(--text-dim)" }}>{suffix}</small>}
      </div>
    </div>
  );
}

function Chart({ data }: { data: number[] }) {
  const W = 600;
  const H = 170;
  const pad = 8;
  const max = Math.max(...data) * 1.1;
  const px = (i: number) => pad + (i * (W - 2 * pad)) / (data.length - 1);
  const py = (v: number) => H - pad - (v / max) * (H - 2 * pad);
  const line = data.map((v, i) => `${i ? "L" : "M"}${px(i).toFixed(1)} ${py(v).toFixed(1)}`).join(" ");
  const area =
    `M ${pad} ${H - pad} ` +
    data.map((v, i) => `L${px(i).toFixed(1)} ${py(v).toFixed(1)}`).join(" ") +
    ` L ${W - pad} ${H - pad} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 170, display: "block" }}>
      <defs>
        <linearGradient id="tgrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#tgrad)" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2.2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
