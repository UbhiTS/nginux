import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type { Traffic } from "../types.ts";

const RANGES = ["1h", "4h", "1d", "7d", "30d", "live"];

export function TrafficChart() {
  const [range, setRange] = useState("live");
  const [metric, setMetric] = useState<"requests" | "bandwidth">("requests");
  const [traffic, setTraffic] = useState<Traffic | null>(null);

  useEffect(() => {
    let alive = true;
    const pull = () => api.traffic(range, metric).then((t) => { if (alive) setTraffic(t); }).catch(() => {});
    pull();
    // "live" refreshes in near-real-time; other ranges are mostly static.
    const id = setInterval(pull, range === "live" ? 3000 : 15000);
    return () => { alive = false; clearInterval(id); };
  }, [range, metric]);

  return (
    <div className="card">
      <div className="card-head">
        Traffic
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
              <button
                key={r}
                className={`range${range === r ? " active" : ""}`}
                onClick={() => setRange(r)}
              >
                {r === "live" ? <><span className="dot g" style={{ marginRight: 5 }} />live</> : r}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="card-pad">
        {traffic && (
          <>
            <div style={{ display: "flex", gap: 26, marginBottom: 12 }}>
              <Metric label={metric === "bandwidth" ? "Bandwidth" : "Requests"} value={traffic.total} />
              <Metric label="Peak" value={traffic.peak} suffix={traffic.unit} />
              <Metric label="Avg p95" value="112" suffix="ms" />
            </div>
            <Chart data={traffic.data} metric={metric} />
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 11,
                color: "var(--text-faint)",
                marginTop: 6,
                paddingLeft: 40,
                paddingRight: 10,
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

function fmtReq(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}

function fmtBytes(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + "GB";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "MB";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "KB";
  return Math.round(n) + "B";
}

/** Round up to a "nice" value (1/2/5 × 10ⁿ) for a clean bandwidth axis. */
function niceCeil(n: number): number {
  if (n <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(n)));
  const f = n / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

function Chart({ data, metric }: { data: number[]; metric: "requests" | "bandwidth" }) {
  const W = 600, H = 170, padL = 40, padR = 10, padT = 10, padB = 10;
  const maxData = Math.max(1, ...data);
  const fmtY = metric === "bandwidth" ? fmtBytes : fmtReq;
  // Requests: next multiple of 10 (min 10). Bandwidth: next 1/2/5×10ⁿ.
  const max = metric === "bandwidth" ? niceCeil(maxData) : Math.max(10, Math.ceil(maxData / 10) * 10);
  const px = (i: number) => padL + (i * (W - padL - padR)) / (data.length - 1);
  const py = (v: number) => H - padB - (v / max) * (H - padT - padB);
  const line = data.map((v, i) => `${i ? "L" : "M"}${px(i).toFixed(1)} ${py(v).toFixed(1)}`).join(" ");
  const area =
    `M ${px(0).toFixed(1)} ${H - padB} ` +
    data.map((v, i) => `L${px(i).toFixed(1)} ${py(v).toFixed(1)}`).join(" ") +
    ` L ${(W - padR).toFixed(1)} ${H - padB} Z`;

  const hLevels = [0, 0.25, 0.5, 0.75, 1];
  const vCount = 5;

  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 170, display: "block" }}>
        <defs>
          <linearGradient id="tgrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
          </linearGradient>
        </defs>
        {/* horizontal grid (request levels) */}
        {hLevels.map((L) => {
          const y = H - padB - L * (H - padT - padB);
          return <line key={`h${L}`} x1={padL} y1={y} x2={W - padR} y2={y} stroke="var(--border)" strokeOpacity={0.5} strokeWidth={1} vectorEffect="non-scaling-stroke" />;
        })}
        {/* vertical grid (time) */}
        {Array.from({ length: vCount }).map((_, j) => {
          const x = padL + (j * (W - padL - padR)) / (vCount - 1);
          return <line key={`v${j}`} x1={x} y1={padT} x2={x} y2={H - padB} stroke="var(--border)" strokeOpacity={0.5} strokeWidth={1} vectorEffect="non-scaling-stroke" />;
        })}
        <path d={area} fill="url(#tgrad)" />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2.2} vectorEffect="non-scaling-stroke" />
      </svg>
      {/* y-axis request-count labels (HTML overlay; vertical scale is 1:1 with px) */}
      {[1, 0.5, 0].map((L) => {
        const y = H - padB - L * (H - padT - padB);
        return (
          <span key={`yl${L}`} style={{ position: "absolute", left: 0, top: `${y - 6}px`, width: 34, textAlign: "right", fontSize: 10, color: "var(--text-faint)" }}>
            {fmtY(max * L)}
          </span>
        );
      })}
    </div>
  );
}
