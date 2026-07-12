import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { usePrefersReducedMotion } from "../hooks.ts";
import type { Traffic } from "../types.ts";

export function TrafficChart({ range, metric, host }: { range: string; metric: "requests" | "bandwidth"; host?: string | null }) {
  const [traffic, setTraffic] = useState<Traffic | null>(null);

  useEffect(() => {
    let alive = true;
    // Paused while the tab is backgrounded (document.hidden) so a hidden dashboard
    // stops polling the API and re-rendering the chart. Resumes on re-focus.
    const pull = () => { if (document.hidden) return; api.traffic(range, metric, host ?? undefined).then((t) => { if (alive) setTraffic(t); }).catch(() => {}); };
    pull();
    // "live" refreshes in near-real-time; other ranges are mostly static.
    const id = setInterval(pull, range === "live" ? 3000 : 15000);
    const onVis = () => { if (!document.hidden) pull(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { alive = false; clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [range, metric, host]);

  const kind = metric === "bandwidth" ? "Bandwidth" : "Requests";
  const ariaLabel = traffic
    ? `${kind}${host ? ` for ${host}` : ""} over ${range}. Total ${traffic.total}, peak ${traffic.peak}${traffic.unit}.`
    : `${kind} chart loading`;

  return (
      <div className="card-pad">
        {traffic ? (
          <>
            <div style={{ display: "flex", gap: 26, marginBottom: 12, alignItems: "flex-start" }}>
              <Metric label={kind + (host ? ` · ${host}` : "")} value={traffic.total} />
              <Metric label="Peak" value={traffic.peak} suffix={traffic.unit} />
              {metric === "bandwidth" && (
                <div style={{ marginLeft: "auto", display: "flex", gap: 14, fontSize: 11, color: "var(--text-dim)", alignSelf: "center" }}>
                  <span><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: "var(--accent)", marginRight: 5 }} />Out (response)</span>
                  <span><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: "var(--green)", marginRight: 5 }} />In (request)</span>
                </div>
              )}
            </div>
            <Chart
              data={traffic.data}
              dataIn={metric === "bandwidth" ? traffic.dataIn : undefined}
              metric={metric}
              axis={traffic.axis}
              ariaLabel={ariaLabel}
            />
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
        ) : (
          // Reserve the chart's footprint with a skeleton so nothing jumps when the
          // first sample lands.
          <div aria-hidden="true">
            <div className="skeleton skeleton-text" style={{ width: 130, height: 16, marginBottom: 18 }} />
            <div className="skeleton" style={{ height: 170, borderRadius: 8 }} />
            <div className="skeleton skeleton-text" style={{ height: 11, marginTop: 8, width: "100%" }} />
          </div>
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

function Chart({
  data,
  dataIn,
  metric,
  axis,
  ariaLabel,
}: {
  data: number[];
  dataIn?: number[];
  metric: "requests" | "bandwidth";
  axis: string[];
  ariaLabel: string;
}) {
  const reduced = usePrefersReducedMotion();
  const W = 600, H = 170, padL = 40, padR = 10, padT = 10, padB = 10;
  const series = dataIn ? [
    { key: "out", label: "Out", values: data, color: "var(--accent)", grad: "tgradOut" },
    { key: "in", label: "In", values: dataIn, color: "var(--green)", grad: "tgradIn" },
  ] : [
    { key: "out", label: metric === "bandwidth" ? "Bandwidth" : "Requests", values: data, color: "var(--accent)", grad: "tgradOut" },
  ];
  const maxData = Math.max(1, ...data, ...(dataIn ?? []));
  const fmtY = metric === "bandwidth" ? fmtBytes : fmtReq;
  // Requests: next multiple of 10 (min 10). Bandwidth: next 1/2/5×10ⁿ.
  const target = metric === "bandwidth" ? niceCeil(maxData) : Math.max(10, Math.ceil(maxData / 10) * 10);
  // Hysteresis: grow the axis the moment data needs more room, but only shrink
  // after a big sustained drop - so values hovering near a boundary (e.g. 9-12)
  // don't make the whole chart rescale between 10 and 20 on every refresh.
  const ceilRef = useRef(0);
  const prev = ceilRef.current;
  const max = prev === 0 || target > prev ? target : maxData < prev * 0.4 ? target : prev;
  ceilRef.current = max;
  const n = data.length;
  const px = (i: number) => padL + (n > 1 ? (i * (W - padL - padR)) / (n - 1) : 0);
  const py = (v: number) => H - padB - (v / max) * (H - padT - padB);
  const linePath = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${px(i).toFixed(1)} ${py(v).toFixed(1)}`).join(" ");
  const areaPath = (vals: number[]) =>
    `M ${px(0).toFixed(1)} ${H - padB} ` +
    vals.map((v, i) => `L${px(i).toFixed(1)} ${py(v).toFixed(1)}`).join(" ") +
    ` L ${(W - padR).toFixed(1)} ${H - padB} Z`;

  const hLevels = [0, 0.25, 0.5, 0.75, 1];
  const vCount = 5;

  // Draw the larger-area series FIRST (behind) so the smaller one's fill + line sit
  // on top and aren't occluded by a bigger neighbour.
  const sum = (vs: number[]) => vs.reduce((a, b) => a + b, 0);
  const areaOrder = [...series].sort((a, b) => sum(b.values) - sum(a.values));

  // Hover crosshair: map the pointer's x to the nearest sample index.
  const [hoverI, setHoverI] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const onMove = (e: React.MouseEvent) => {
    const el = wrapRef.current;
    if (!el || n < 2) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return;
    const fx = (e.clientX - rect.left) / rect.width; // 0..1 across rendered width
    const left = padL / W, right = (W - padR) / W; // plotted band within the viewBox
    const t = (fx - left) / (right - left);
    const i = Math.round(t * (n - 1));
    setHoverI(Math.max(0, Math.min(n - 1, i)));
  };
  const onLeave = () => setHoverI(null);

  const tip = hoverI != null ? (() => {
    const xFrac = px(hoverI) / W;
    const ts = axis.length ? axis[Math.min(axis.length - 1, Math.round((hoverI / Math.max(1, n - 1)) * (axis.length - 1)))] : "";
    const rows = dataIn
      ? [{ label: "Out", v: data[hoverI], c: "var(--accent)" }, { label: "In", v: dataIn[hoverI], c: "var(--green)" }]
      : [{ label: metric === "bandwidth" ? "Bandwidth" : "Requests", v: data[hoverI], c: "var(--accent)" }];
    return { xFrac, ts, rows };
  })() : null;

  return (
    <div ref={wrapRef} style={{ position: "relative" }} onMouseMove={onMove} onMouseLeave={onLeave}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height: 170, display: "block" }}
        role="img"
        aria-label={ariaLabel}
      >
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
        {areaOrder.map((s) => <path key={`a${s.grad}`} d={areaPath(s.values)} fill={`url(#${s.grad})`} />)}
        {series.map((s) => <path key={`l${s.grad}`} d={linePath(s.values)} fill="none" stroke={s.color} strokeWidth={2.2} vectorEffect="non-scaling-stroke" />)}
        {/* hover crosshair: vertical guide + a dot on each series at the nearest sample */}
        {hoverI != null && (
          <g>
            <line x1={px(hoverI)} y1={padT} x2={px(hoverI)} y2={H - padB} stroke="var(--text-faint)" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
            {series.map((s) => (
              <circle key={`x${s.grad}`} cx={px(hoverI)} cy={py(s.values[hoverI])} r={3.6} fill={s.color} stroke="var(--card, var(--bg))" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            ))}
          </g>
        )}
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
      {/* hover tooltip: value(s) + timestamp at the nearest sample */}
      {tip && (
        <div
          role="tooltip"
          style={{
            position: "absolute",
            left: `${tip.xFrac * 100}%`,
            top: 4,
            transform: tip.xFrac > 0.6 ? "translateX(calc(-100% - 10px))" : "translateX(10px)",
            pointerEvents: "none",
            background: "var(--card-elev, var(--card, #1b1f27))",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "5px 8px",
            fontSize: 11,
            lineHeight: 1.5,
            whiteSpace: "nowrap",
            boxShadow: "0 4px 14px rgba(0,0,0,.28)",
            zIndex: 3,
            transition: reduced ? "none" : "left 60ms linear",
          }}
        >
          {tip.ts && <div style={{ color: "var(--text-faint)", marginBottom: 2 }}>{tip.ts}</div>}
          {tip.rows.map((r) => (
            <div key={r.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: r.c }} />
              <span style={{ color: "var(--text-dim)" }}>{r.label}</span>
              <span style={{ marginLeft: "auto", fontWeight: 600, color: "var(--text)" }}>{fmtY(r.v)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
