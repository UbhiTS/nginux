import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import type { Traffic } from "../types.ts";

export function TrafficChart({ range, metric, host }: { range: string; metric: "requests" | "bandwidth"; host?: string | null }) {
  const [traffic, setTraffic] = useState<Traffic | null>(null);

  useEffect(() => {
    let alive = true;
    const pull = () => api.traffic(range, metric, host ?? undefined).then((t) => { if (alive) setTraffic(t); }).catch(() => {});
    pull();
    // "live" refreshes in near-real-time; other ranges are mostly static.
    const id = setInterval(pull, range === "live" ? 3000 : 15000);
    return () => { alive = false; clearInterval(id); };
  }, [range, metric, host]);

  return (
      <div className="card-pad">
        {traffic && (
          <>
            <div style={{ display: "flex", gap: 26, marginBottom: 12, alignItems: "flex-start" }}>
              <Metric label={(metric === "bandwidth" ? "Bandwidth" : "Requests") + (host ? ` · ${host}` : "")} value={traffic.total} />
              <Metric label="Peak" value={traffic.peak} suffix={traffic.unit} />
              {metric === "bandwidth" && (
                <div style={{ marginLeft: "auto", display: "flex", gap: 14, fontSize: 11, color: "var(--text-dim)", alignSelf: "center" }}>
                  <span><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: "var(--accent)", marginRight: 5 }} />Out (response)</span>
                  <span><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: "var(--green)", marginRight: 5 }} />In (request)</span>
                </div>
              )}
            </div>
            <Chart data={traffic.data} dataIn={metric === "bandwidth" ? traffic.dataIn : undefined} metric={metric} />
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

function Chart({ data, dataIn, metric }: { data: number[]; dataIn?: number[]; metric: "requests" | "bandwidth" }) {
  const W = 600, H = 170, padL = 40, padR = 10, padT = 10, padB = 10;
  const series = dataIn ? [
    { values: data, color: "var(--accent)", grad: "tgradOut" },
    { values: dataIn, color: "var(--green)", grad: "tgradIn" },
  ] : [
    { values: data, color: "var(--accent)", grad: "tgradOut" },
  ];
  const maxData = Math.max(1, ...data, ...(dataIn ?? []));
  const fmtY = metric === "bandwidth" ? fmtBytes : fmtReq;
  // Requests: next multiple of 10 (min 10). Bandwidth: next 1/2/5×10ⁿ.
  const target = metric === "bandwidth" ? niceCeil(maxData) : Math.max(10, Math.ceil(maxData / 10) * 10);
  // Hysteresis: grow the axis the moment data needs more room, but only shrink
  // after a big sustained drop — so values hovering near a boundary (e.g. 9–12)
  // don't make the whole chart rescale between 10 and 20 on every refresh.
  const ceilRef = useRef(0);
  const prev = ceilRef.current;
  const max = prev === 0 || target > prev ? target : maxData < prev * 0.4 ? target : prev;
  ceilRef.current = max;
  const px = (i: number) => padL + (i * (W - padL - padR)) / (data.length - 1);
  const py = (v: number) => H - padB - (v / max) * (H - padT - padB);
  const linePath = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${px(i).toFixed(1)} ${py(v).toFixed(1)}`).join(" ");
  const areaPath = (vals: number[]) =>
    `M ${px(0).toFixed(1)} ${H - padB} ` +
    vals.map((v, i) => `L${px(i).toFixed(1)} ${py(v).toFixed(1)}`).join(" ") +
    ` L ${(W - padR).toFixed(1)} ${H - padB} Z`;

  const hLevels = [0, 0.25, 0.5, 0.75, 1];
  const vCount = 5;

  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 170, display: "block" }}>
        <defs>
          <linearGradient id="tgradOut" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.3} />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="tgradIn" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--green)" stopOpacity={0.25} />
            <stop offset="100%" stopColor="var(--green)" stopOpacity={0} />
          </linearGradient>
        </defs>
        {/* horizontal grid (value levels) */}
        {hLevels.map((L) => {
          const y = H - padB - L * (H - padT - padB);
          return <line key={`h${L}`} x1={padL} y1={y} x2={W - padR} y2={y} stroke="var(--border)" strokeOpacity={0.5} strokeWidth={1} vectorEffect="non-scaling-stroke" />;
        })}
        {/* vertical grid (time) */}
        {Array.from({ length: vCount }).map((_, j) => {
          const x = padL + (j * (W - padL - padR)) / (vCount - 1);
          return <line key={`v${j}`} x1={x} y1={padT} x2={x} y2={H - padB} stroke="var(--border)" strokeOpacity={0.5} strokeWidth={1} vectorEffect="non-scaling-stroke" />;
        })}
        {series.map((s) => <path key={`a${s.grad}`} d={areaPath(s.values)} fill={`url(#${s.grad})`} />)}
        {series.map((s) => <path key={`l${s.grad}`} d={linePath(s.values)} fill="none" stroke={s.color} strokeWidth={2.2} vectorEffect="non-scaling-stroke" />)}
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
