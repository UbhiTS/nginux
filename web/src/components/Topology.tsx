import { useCallback, useEffect, useRef, useState } from "react";
import type { Route } from "../App.tsx";
import type { Topology as TopologyData } from "../types.ts";
import { healthClass } from "../types.ts";
import { api } from "../api.ts";

interface PulsePhase { t0: number; t1: number; width: number; }
interface Pulse { dur: number; begin: string; phases: PulsePhase[]; }
interface Stroke { d: string; color: string; dashed: boolean; host: string; width: number; pulse?: Pulse; }

const fmtCount = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n)));
const fmtBytes = (n: number) => (n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : n >= 1e3 ? (n / 1e3).toFixed(0) + " KB" : Math.round(n) + " B");
const fmtMbps = (bytes: number) => { const m = (bytes * 8) / 1e6 / 60; return m >= 10 ? m.toFixed(0) : m.toFixed(m >= 1 ? 1 : 2); };
interface Flow {
  path: string; // path a dot travels
  host: string; // the service domain this flow belongs to
  color: string;
  count: number; // dots in this batch ∝ requests (not bandwidth)
  dur: number; // full cycle length in seconds (sized to fit its own content)
  begin: string; // negative offset so services don't sync (phase only, not speed)
  t0: number; // fraction of dur when the first dot launches
  step: number; // fraction of dur between consecutive dots
  travel: number; // fraction of dur a single dot is in flight
}

const MAX_DOTS = 6;
const SPEED = 190; // px/second — identical for every dot
const STEP_SEC = 0.09; // seconds between consecutive dots in a batch (controls spacing)
const HANDOFF_SEC = 0.12; // brief pause between a batch finishing and the next starting
const MIN_W = 1.4; // thinnest line (idle / tiny bandwidth)
const MAX_W = 8; // thickest line (busiest direction across all services)
const STAGGER_SEC = 0.22; // small per-service phase offset within the shared cycle
const QUIET_SEC = 0.5; // quiet tail at the end of the cycle (no dots in flight) for safe commits
const PALETTE = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#a855f7", "#ec4899",
  "#06b6d4", "#f97316", "#84cc16", "#eab308", "#8b5cf6", "#14b8a6",
];

export function Topology({
  data,
  navigate,
  range,
  hovered,
  onHover,
}: {
  data: TopologyData;
  navigate: (r: Route) => void;
  range: string;
  metric: "requests" | "bandwidth";
  hovered: string | null;
  onHover: (domain: string | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const internetRef = useRef<HTMLDivElement>(null);
  const gatewayRef = useRef<HTMLDivElement>(null);
  const svcRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [box, setBox] = useState({ w: 0, h: 0 });
  // `stats` drives the per-row numbers and updates on every poll. The animation,
  // though, only reads the latest via `statsRef` and is recommitted at cycle
  // boundaries (see the commit loop) so in-flight dots are never cut mid-journey.
  const [stats, setStats] = useState<Record<string, { requests: number; bytesIn: number; bytesOut: number }>>({});
  const statsRef = useRef(stats);
  const [gen, setGen] = useState(0); // bumped each commit; remounts animations cleanly at a boundary
  const cycleRef = useRef(3); // current global cycle length (s)
  const timerRef = useRef<number | null>(null);
  const tickRef = useRef<() => void>(() => {});

  useEffect(() => { statsRef.current = stats; }, [stats]);

  // The parent refetches topology on a poll, handing us a new `data` object each
  // time. Read it through a ref so commits don't restart just because the object
  // identity changed — only when the actual service set/health changes (svcKey).
  const dataRef = useRef(data);
  dataRef.current = data;
  const svcKey = data.servers.flatMap((s) => s.services).map((x) => `${x.id}:${x.health}`).join("|");

  useEffect(() => {
    let alive = true;
    const pull = () =>
      api.hostStats(range)
        .then((rows) => { if (alive) setStats(Object.fromEntries(rows.map((r) => [r.key, r]))); })
        .catch(() => {});
    pull();
    const id = setInterval(pull, range === "live" ? 3000 : 8000);
    return () => { alive = false; clearInterval(id); };
  }, [range]);

  // Build the whole animation generation at once. All services share ONE global
  // cycle with a quiet tail at the end (no dots in flight); the commit loop swaps
  // to a fresh generation only at that boundary, so dots always finish their trip.
  const commit = useCallback(() => {
    const wrap = wrapRef.current;
    const net = internetRef.current;
    const gw = gatewayRef.current;
    if (!wrap || !net || !gw) return;
    const r = wrap.getBoundingClientRect();
    setBox({ w: r.width, h: r.height });

    const anchor = (el: HTMLElement, side: "l" | "r") => {
      const b = el.getBoundingClientRect();
      return { x: (side === "r" ? b.right : b.left) - r.left, y: b.top - r.top + b.height / 2 };
    };
    type P = { x: number; y: number };
    const curve = (a: P, b: P) => { const mx = (a.x + b.x) / 2; return `C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`; };
    const seg = (a: P, b: P) => `M ${a.x} ${a.y} ${curve(a, b)}`;
    const dist = (a: P, b: P) => Math.hypot(b.x - a.x, b.y - a.y);
    const through = (p1: P, p2: P, p3: P, p4: P) => `M ${p1.x} ${p1.y} ${curve(p1, p2)} L ${p3.x} ${p3.y} ${curve(p3, p4)}`;

    const services = dataRef.current.servers.flatMap((s) => s.services);
    const n = services.length;
    if (n === 0) { setStrokes([]); setFlows([]); cycleRef.current = 3; return; }

    const netR = net.getBoundingClientRect();
    const gwR = gw.getBoundingClientRect();
    const netA = anchor(net, "r");
    const gwLeft = anchor(gw, "l");
    const gwRight = anchor(gw, "r");
    const usable = Math.min(netR.height, gwR.height) - 14;
    const gap = n > 1 ? Math.min(18, usable / (n - 1)) : 0;
    const yAt = (cy: number, i: number) => cy + (i - (n - 1) / 2) * gap;

    const live = range === "live";
    const sx = statsRef.current;
    const reqMax = Math.max(1, ...services.map((s) => sx[s.domain]?.requests ?? 0));
    const byteMax = Math.max(1, ...services.flatMap((s) => {
      const st = sx[s.domain];
      return st ? [st.bytesIn, st.bytesOut] : [0];
    }));
    const widthFor = (bytes: number) => (bytes <= 0 ? MIN_W : Math.min(MAX_W, MIN_W + (bytes / byteMax) * (MAX_W - MIN_W)));
    const batch = (tf: number, m: number) => (Math.max(1, m) - 1) * STEP_SEC + tf;

    // Pass 1: per-service geometry, counts, batch lengths, and stagger.
    const items = services.map((svc, i) => {
      const down = svc.health === "down";
      const st = sx[svc.domain];
      const req = st?.requests ?? 0;
      const reqN = req > 0 ? Math.max(1, Math.round((req / reqMax) * MAX_DOTS)) : (down ? 0 : 1);
      const a1 = { x: netA.x, y: yAt(netA.y, i) };
      const b1 = { x: gwLeft.x, y: yAt(gwLeft.y, i) };
      const a2 = { x: gwRight.x, y: yAt(gwRight.y, i) };
      const el = svcRefs.current.get(svc.id);
      const b2 = el ? anchor(el, "l") : a2;
      const len = down || !el ? dist(a1, b1) : dist(a1, b1) + dist(b1, a2) + dist(a2, b2);
      const tf = len / SPEED;
      const hasResp = !down && !!el;
      const respN = hasResp ? reqN : 0;
      const reqBatch = batch(tf, reqN);
      const respBatch = hasResp ? batch(tf, respN) : 0;
      const offset = (i % 5) * STAGGER_SEC; // small phase stagger, bounded so it stays before the tail
      const reqPath = down || !el ? seg(a1, b1) : through(a1, b1, a2, b2);
      const respPath = hasResp ? through(b2, a2, b1, a1) : "";
      return {
        svc, i, color: PALETTE[i % PALETTE.length], down, el, hasResp,
        reqN, respN, reqBatch, respBatch, tf, offset, reqPath, respPath,
        inW: widthFor(st?.bytesIn ?? 0), outW: widthFor(st?.bytesOut ?? 0),
        a1, b1, a2, b2,
      };
    });

    // One global cycle that fits every service's batches, plus a quiet tail so a
    // boundary commit never lands while a dot is mid-flight.
    const cycle = Math.max(...items.map((it) =>
      it.offset + HANDOFF_SEC / 2 + it.reqBatch + (it.hasResp ? HANDOFF_SEC + it.respBatch : 0) + HANDOFF_SEC / 2,
    )) + QUIET_SEC;
    cycleRef.current = cycle;

    const nextStrokes: Stroke[] = [];
    const nextFlows: Flow[] = [];
    for (const it of items) {
      const reqStart = it.offset + HANDOFF_SEC / 2;
      const respStart = reqStart + it.reqBatch + HANDOFF_SEC;
      const base = live ? MIN_W : it.outW;
      const phases: PulsePhase[] = [];
      if (live) {
        if (it.reqN > 0) phases.push({ t0: reqStart / cycle, t1: (reqStart + it.reqBatch) / cycle, width: it.inW });
        if (it.hasResp) phases.push({ t0: respStart / cycle, t1: (respStart + it.respBatch) / cycle, width: it.outW });
      }
      const pulse: Pulse | undefined = phases.length ? { dur: cycle, begin: "0s", phases } : undefined;

      nextStrokes.push({ d: seg(it.a1, it.b1), color: it.color, dashed: false, host: it.svc.domain, width: base, pulse });
      if (it.el) nextStrokes.push({ d: seg(it.a2, it.b2), color: it.color, dashed: it.down, host: it.svc.domain, width: base, pulse });

      nextFlows.push({
        path: it.reqPath, host: it.svc.domain, color: it.color, count: it.reqN, dur: cycle, begin: "0s",
        t0: reqStart / cycle, step: STEP_SEC / cycle, travel: it.tf / cycle,
      });
      if (it.hasResp) {
        nextFlows.push({
          path: it.respPath, host: it.svc.domain, color: it.color, count: it.respN, dur: cycle, begin: "0s",
          t0: respStart / cycle, step: STEP_SEC / cycle, travel: it.tf / cycle,
        });
      }
    }

    setStrokes(nextStrokes);
    setFlows(nextFlows);
    setGen((g) => g + 1);
  }, [svcKey, range]);

  // Commit loop: render a generation, then schedule the next swap for one full
  // cycle later (i.e. in the quiet tail), so the previous generation's dots have
  // all landed first. Polled stats are picked up by the next commit, not mid-flight.
  useEffect(() => {
    const tick = () => {
      commit();
      timerRef.current = window.setTimeout(tick, Math.max(800, cycleRef.current * 1000));
    };
    tickRef.current = tick;
    const raf = requestAnimationFrame(tick); // wait for layout before the first measure
    return () => { cancelAnimationFrame(raf); if (timerRef.current) clearTimeout(timerRef.current); };
  }, [commit]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onResize = () => { if (timerRef.current) clearTimeout(timerRef.current); tickRef.current(); };
    const ro = new ResizeObserver(onResize);
    ro.observe(wrap);
    window.addEventListener("resize", onResize);
    return () => { ro.disconnect(); window.removeEventListener("resize", onResize); };
  }, []);

  return (
      <div className="topo" ref={wrapRef}>
        <svg className="topo-lines" viewBox={`0 0 ${box.w} ${box.h}`} preserveAspectRatio="none">
          {strokes.map((s, i) => {
            const dim = hovered ? s.host !== hovered : false;
            const p = s.pulse;
            // Build a keyframe envelope: min between phases, swell to each phase's
            // width while that batch is in flight.
            let anim: { keyTimes: string; values: string } | null = null;
            if (p && p.phases.length) {
              const kt: number[] = [0];
              const val: number[] = [s.width];
              for (const ph of p.phases) {
                const e = Math.min(0.004, Math.max(0.001, (ph.t1 - ph.t0) / 4));
                kt.push(+ph.t0.toFixed(4), +(ph.t0 + e).toFixed(4), +(ph.t1 - e).toFixed(4), +ph.t1.toFixed(4));
                val.push(s.width, ph.width, ph.width, s.width);
              }
              kt.push(1); val.push(s.width);
              anim = { keyTimes: kt.join(";"), values: val.join(";") };
            }
            return (
              <path
                key={`g${gen}-s${i}`}
                d={s.d}
                fill="none"
                stroke={s.color}
                strokeWidth={s.width}
                strokeLinecap="round"
                strokeOpacity={dim ? 0.07 : s.dashed ? 0.3 : 0.45}
                strokeDasharray={s.dashed ? "5 5" : undefined}
              >
                {anim && p && (
                  <animate
                    attributeName="stroke-width"
                    dur={`${p.dur}s`}
                    begin={p.begin}
                    repeatCount="indefinite"
                    calcMode="linear"
                    keyTimes={anim.keyTimes}
                    values={anim.values}
                  />
                )}
              </path>
            );
          })}
          {flows.flatMap((f, fi) => {
            // When a service is hovered, only its dots animate.
            if (hovered && f.host !== hovered) return [];
            return Array.from({ length: f.count }).map((_, k) => {
              const f0 = +(f.t0 + k * f.step).toFixed(4);
              const f1 = +(f0 + f.travel).toFixed(4);
              return (
                <circle key={`g${gen}-f${fi}-${k}`} r={3.1} fill={f.color} opacity={0}>
                  <animateMotion
                    dur={`${f.dur}s`}
                    begin={f.begin}
                    repeatCount="indefinite"
                    calcMode="linear"
                    keyPoints="0;0;1;1"
                    keyTimes={`0;${f0};${f1};1`}
                    path={f.path}
                  />
                  <animate
                    attributeName="opacity"
                    dur={`${f.dur}s`}
                    begin={f.begin}
                    repeatCount="indefinite"
                    calcMode="linear"
                    keyTimes={`0;${f0};${+(f0 + 0.004).toFixed(3)};${+(f1 - 0.004).toFixed(3)};${f1};1`}
                    values="0;0;1;1;0;0"
                  />
                </circle>
              );
            });
          })}
        </svg>

        <div className="topo-legend">
          <span><span className="lg-dot" /> dots = requests</span>
          <span><span className="lg-bar" /> line width = bandwidth</span>
          <span className="lg-dim">per-service in/out shown on each row</span>
        </div>

        <div className="topo-tier">
          <div className="node node-internet" ref={internetRef}>
            <div className="node-ico">🌐</div>
            <div className="node-title">Internet</div>
            <div className="node-sub">incoming visitors</div>
          </div>
        </div>

        <div className="topo-tier">
          <div className="node node-gw" ref={gatewayRef}>
            <div className="node-ico">🛡️</div>
            <div className="node-title">Gateway / Router</div>
            <div className="node-ip">
              <span className="ip-label">Public</span> {data.gateway.publicIp}
            </div>
            <div className="node-ip">
              <span className="ip-label">LAN</span> {data.gateway.gatewayIp}
            </div>
            <div className="node-foot">
              <span className="dot g" />
              NginUX · ports 80 / 443
            </div>
          </div>
        </div>

        <div className="topo-tier tier-srv">
          {data.servers.map((server) => (
            <div key={server.name} className="srv-card">
              <div className="srv-head">
                <span className="srv-ico">🖥️</span>
                <span className="srv-name">{server.name}</span>
                <span className="srv-ip">{server.ip}</span>
              </div>
              {server.services.map((s) => {
                const idx = data.servers.flatMap((sv) => sv.services).findIndex((x) => x.id === s.id);
                return (
                  <div
                    key={s.id}
                    className="svc"
                    ref={(el) => {
                      if (el) svcRefs.current.set(s.id, el);
                      else svcRefs.current.delete(s.id);
                    }}
                    onMouseEnter={() => onHover(s.domain)}
                    onMouseLeave={() => onHover(null)}
                    onClick={() => navigate({ name: "host", hostId: s.id })}
                  >
                    <span className="svc-tag" style={{ background: PALETTE[idx % PALETTE.length] }} />
                    <span className="svc-emoji">{s.emoji}</span>
                    <div className="svc-body">
                      <div className="svc-name">
                        {s.name} <span className="port">:{s.port}</span>
                      </div>
                      <div className={`svc-route${s.health === "down" ? " svc-down" : ""}`}>
                        → {s.domain}
                        {s.health === "down" ? " · unreachable" : ""}
                      </div>
                    </div>
                    {(() => {
                      const st = stats[s.domain];
                      if (!st || (st.requests === 0 && st.bytesIn === 0 && st.bytesOut === 0)) return null;
                      const rps = st.requests / 60;
                      return (
                        <div className="svc-metrics">
                          <span className="m-req">{range === "live" ? `${rps >= 10 ? Math.round(rps) : rps.toFixed(1)}/s` : `${fmtCount(st.requests)} req`}</span>
                          <span className="m-bw" title="in / out">
                            {range === "live"
                              ? `${fmtMbps(st.bytesIn)} / ${fmtMbps(st.bytesOut)} Mbps`
                              : `${fmtBytes(st.bytesIn)} / ${fmtBytes(st.bytesOut)}`}
                          </span>
                        </div>
                      );
                    })()}
                    <span className="svc-stat">
                      <span className={`dot ${healthClass[s.health]}`} />
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
  );
}
