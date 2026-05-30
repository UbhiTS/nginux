import { useCallback, useEffect, useRef, useState } from "react";
import type { Route } from "../App.tsx";
import type { Topology as TopologyData } from "../types.ts";
import { healthClass } from "../types.ts";
import { api, type Reachability } from "../api.ts";

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
const LINE_OFF = 4; // vertical gap between the request (upper) and response (lower) lines
const PALETTE = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#a855f7", "#ec4899",
  "#06b6d4", "#f97316", "#84cc16", "#eab308", "#8b5cf6", "#14b8a6",
];

type Pt = { x: number; y: number };
const curveTo = (a: Pt, b: Pt) => { const mx = (a.x + b.x) / 2; return `C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`; };
const segPath = (a: Pt, b: Pt) => `M ${a.x} ${a.y} ${curveTo(a, b)}`;
const distOf = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);
// A full journey curves to the gateway, crosses behind it, then curves to the far point.
const throughPath = (p1: Pt, p2: Pt, p3: Pt, p4: Pt) => `M ${p1.x} ${p1.y} ${curveTo(p1, p2)} L ${p3.x} ${p3.y} ${curveTo(p3, p4)}`;

interface SvcAnim { strokes: Stroke[]; flows: Flow[]; gen: number }

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
  // Per-service animation, each committed on its OWN cycle boundary so one
  // service refreshing never cuts another's dots. `gen` (per service) bumps only
  // at that service's boundary, remounting just its elements.
  const [anim, setAnim] = useState<Record<string, SvcAnim>>({});
  const [box, setBox] = useState({ w: 0, h: 0 });
  // `stats` drives the per-row numbers (updates every poll). The animation reads
  // the latest only via `statsRef`, and only at each service's boundary.
  const [stats, setStats] = useState<Record<string, { requests: number; bytesIn: number; bytesOut: number }>>({});
  const statsRef = useRef(stats);
  const timersRef = useRef<Map<string, number>>(new Map());
  const [reach, setReach] = useState<Reachability | null>(null);

  useEffect(() => { statsRef.current = stats; }, [stats]);

  // Live gateway reachability — is nginx serving 80/443, and has the public IP drifted?
  useEffect(() => {
    let alive = true;
    const pull = () => api.reachability().then((x) => { if (alive) setReach(x); }).catch(() => {});
    pull();
    const id = setInterval(pull, 30000);
    return () => { alive = false; clearInterval(id); };
  }, []);

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

  // Measure the shared layout (internet/gateway anchors + per-row positions).
  const measure = useCallback(() => {
    const wrap = wrapRef.current, net = internetRef.current, gw = gatewayRef.current;
    if (!wrap || !net || !gw) return null;
    const r = wrap.getBoundingClientRect();
    const anchor = (el: HTMLElement, side: "l" | "r") => {
      const b = el.getBoundingClientRect();
      return { x: (side === "r" ? b.right : b.left) - r.left, y: b.top - r.top + b.height / 2 };
    };
    const n = dataRef.current.servers.flatMap((s) => s.services).length;
    const netR = net.getBoundingClientRect(), gwR = gw.getBoundingClientRect();
    const netA = anchor(net, "r"), gwLeft = anchor(gw, "l"), gwRight = anchor(gw, "r");
    const usable = Math.min(netR.height, gwR.height) - 14;
    const gap = n > 1 ? Math.min(18, usable / (n - 1)) : 0;
    const yAt = (cy: number, i: number) => cy + (i - (n - 1) / 2) * gap;
    const svcAnchor = (id: string) => { const el = svcRefs.current.get(id); return el ? anchor(el, "l") : null; };
    return { box: { w: r.width, h: r.height }, netA, gwLeft, gwRight, yAt, svcAnchor };
  }, []);

  // Build ONE service's strokes/flows + its own cycle length, from the latest
  // stats. Width is still normalized against the busiest direction across all
  // services so the in-thin / out-fat contrast holds.
  const buildOne = useCallback((layout: NonNullable<ReturnType<typeof measure>>, svc: { id: string; domain: string; health: string }, i: number, live: boolean): SvcAnim & { cycle: number } => {
    const sx = statsRef.current;
    const services = dataRef.current.servers.flatMap((s) => s.services);
    const reqMax = Math.max(1, ...services.map((s) => sx[s.domain]?.requests ?? 0));
    const byteMax = Math.max(1, ...services.flatMap((s) => { const st = sx[s.domain]; return st ? [st.bytesIn, st.bytesOut] : [0]; }));
    const widthFor = (b: number) => (b <= 0 ? MIN_W : Math.min(MAX_W, MIN_W + (b / byteMax) * (MAX_W - MIN_W)));

    const down = svc.health === "down";
    const st = sx[svc.domain];
    const req = st?.requests ?? 0;
    const reqN = req > 0 ? Math.max(1, Math.round((req / reqMax) * MAX_DOTS)) : (down ? 0 : 1);
    const a1 = { x: layout.netA.x, y: layout.yAt(layout.netA.y, i) };
    const b1 = { x: layout.gwLeft.x, y: layout.yAt(layout.gwLeft.y, i) };
    const a2 = { x: layout.gwRight.x, y: layout.yAt(layout.gwRight.y, i) };
    const b2a = layout.svcAnchor(svc.id);
    const el = !!b2a;
    const b2 = b2a ?? a2;
    const len = down || !el ? distOf(a1, b1) : distOf(a1, b1) + distOf(b1, a2) + distOf(a2, b2);
    const tf = len / SPEED;
    const hasResp = !down && el;
    const respN = hasResp ? reqN : 0;
    const batch = (m: number) => (Math.max(1, m) - 1) * STEP_SEC + tf;
    const reqBatch = batch(reqN);
    const respBatch = hasResp ? batch(respN) : 0;
    // This service's own cycle, sized to its content, with a short quiet tail so
    // the boundary commit never lands while one of ITS dots is in flight.
    const cycle = (hasResp
      ? HANDOFF_SEC / 2 + reqBatch + HANDOFF_SEC + respBatch + HANDOFF_SEC / 2
      : HANDOFF_SEC / 2 + reqBatch + HANDOFF_SEC / 2) + QUIET_SEC;
    const reqStart = HANDOFF_SEC / 2;
    const respStart = reqStart + reqBatch + HANDOFF_SEC;

    const inW = widthFor(st?.bytesIn ?? 0), outW = widthFor(st?.bytesOut ?? 0);
    const color = PALETTE[i % PALETTE.length];
    const up = (p: Pt): Pt => ({ x: p.x, y: p.y - LINE_OFF });
    const dn = (p: Pt): Pt => ({ x: p.x, y: p.y + LINE_OFF });

    // Request (ingress) line — upper: width ∝ request bandwidth, pulses on the request batch.
    const fwdBase = live ? MIN_W : inW;
    const fwdPulse: Pulse | undefined = live && reqN > 0
      ? { dur: cycle, begin: "0s", phases: [{ t0: reqStart / cycle, t1: (reqStart + reqBatch) / cycle, width: inW }] }
      : undefined;
    // Response (egress) line — lower: width ∝ response bandwidth, pulses on the response batch.
    const retBase = live ? MIN_W : outW;
    const retPulse: Pulse | undefined = live && hasResp
      ? { dur: cycle, begin: "0s", phases: [{ t0: respStart / cycle, t1: (respStart + respBatch) / cycle, width: outW }] }
      : undefined;

    const strokes: Stroke[] = [{ d: segPath(up(a1), up(b1)), color, dashed: false, host: svc.domain, width: fwdBase, pulse: fwdPulse }];
    if (el) strokes.push({ d: segPath(up(a2), up(b2)), color, dashed: down, host: svc.domain, width: fwdBase, pulse: fwdPulse });
    if (hasResp) {
      strokes.push({ d: segPath(dn(a1), dn(b1)), color, dashed: false, host: svc.domain, width: retBase, pulse: retPulse });
      strokes.push({ d: segPath(dn(a2), dn(b2)), color, dashed: false, host: svc.domain, width: retBase, pulse: retPulse });
    }

    const reqPath = down || !el ? segPath(up(a1), up(b1)) : throughPath(up(a1), up(b1), up(a2), up(b2));
    const flows: Flow[] = [{ path: reqPath, host: svc.domain, color, count: reqN, dur: cycle, begin: "0s", t0: reqStart / cycle, step: STEP_SEC / cycle, travel: tf / cycle }];
    if (hasResp) {
      flows.push({ path: throughPath(dn(b2), dn(a2), dn(b1), dn(a1)), host: svc.domain, color, count: respN, dur: cycle, begin: "0s", t0: respStart / cycle, step: STEP_SEC / cycle, travel: tf / cycle });
    }
    return { strokes, flows, gen: 0, cycle };
  }, [measure]);

  // Start one independent commit chain per service. Each renders its generation,
  // then schedules its next swap one cycle later (in its own quiet tail), so its
  // dots always land first — and other services are untouched (separate keys).
  const startChains = useCallback(() => {
    const timers = timersRef.current;
    timers.forEach((id) => clearTimeout(id));
    timers.clear();
    const services = dataRef.current.servers.flatMap((s) => s.services);
    const live = range === "live";
    setAnim((prev) => { const next: Record<string, SvcAnim> = {}; for (const s of services) if (prev[s.id]) next[s.id] = prev[s.id]; return next; });

    services.forEach((svc, i) => {
      const run = () => {
        const layout = measure();
        if (!layout) { timers.set(svc.id, window.setTimeout(run, 200)); return; }
        setBox(layout.box);
        const built = buildOne(layout, svc, i, live);
        setAnim((prev) => ({ ...prev, [svc.id]: { strokes: built.strokes, flows: built.flows, gen: (prev[svc.id]?.gen ?? 0) + 1 } }));
        timers.set(svc.id, window.setTimeout(run, Math.max(700, built.cycle * 1000)));
      };
      timers.set(svc.id, window.setTimeout(run, Math.round(i * STAGGER_SEC * 1000))); // staggered start
    });
  }, [measure, buildOne, range]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => startChains());
    return () => { cancelAnimationFrame(raf); timersRef.current.forEach((id) => clearTimeout(id)); timersRef.current.clear(); };
  }, [startChains, svcKey]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onResize = () => startChains();
    const ro = new ResizeObserver(onResize);
    ro.observe(wrap);
    window.addEventListener("resize", onResize);
    return () => { ro.disconnect(); window.removeEventListener("resize", onResize); };
  }, [startChains]);

  return (
      <div className="topo" ref={wrapRef}>
        <svg className="topo-lines" viewBox={`0 0 ${box.w} ${box.h}`} preserveAspectRatio="none">
          {Object.entries(anim).flatMap(([host, a]) => a.strokes.map((s, si) => {
            const dim = hovered ? s.host !== hovered : false;
            const p = s.pulse;
            // Build a keyframe envelope: min between phases, swell to each phase's
            // width while that batch is in flight.
            let env: { keyTimes: string; values: string } | null = null;
            if (p && p.phases.length) {
              const kt: number[] = [0];
              const val: number[] = [s.width];
              for (const ph of p.phases) {
                const e = Math.min(0.004, Math.max(0.001, (ph.t1 - ph.t0) / 4));
                kt.push(+ph.t0.toFixed(4), +(ph.t0 + e).toFixed(4), +(ph.t1 - e).toFixed(4), +ph.t1.toFixed(4));
                val.push(s.width, ph.width, ph.width, s.width);
              }
              kt.push(1); val.push(s.width);
              env = { keyTimes: kt.join(";"), values: val.join(";") };
            }
            return (
              <path
                key={`${host}-g${a.gen}-s${si}`}
                d={s.d}
                fill="none"
                stroke={s.color}
                strokeWidth={s.width}
                strokeLinecap="round"
                strokeOpacity={dim ? 0.07 : s.dashed ? 0.3 : 0.45}
                strokeDasharray={s.dashed ? "5 5" : undefined}
              >
                {env && p && (
                  <animate
                    attributeName="stroke-width"
                    dur={`${p.dur}s`}
                    begin={p.begin}
                    repeatCount="indefinite"
                    calcMode="linear"
                    keyTimes={env.keyTimes}
                    values={env.values}
                  />
                )}
              </path>
            );
          }))}
          {Object.entries(anim).flatMap(([host, a]) => a.flows.flatMap((f, fi) => {
            // When a service is hovered, only its dots animate.
            if (hovered && f.host !== hovered) return [];
            return Array.from({ length: f.count }).map((_, k) => {
              const f0 = +(f.t0 + k * f.step).toFixed(4);
              const f1 = +(f0 + f.travel).toFixed(4);
              return (
                <circle key={`${host}-g${a.gen}-f${fi}-${k}`} r={3.1} fill={f.color} opacity={0}>
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
          }))}
        </svg>

        <div className="topo-legend">
          <span><span className="lg-dot" /> dots = requests</span>
          <span><span className="lg-bar" /> line width = bandwidth</span>
          <span className="lg-dim">upper line in · lower line out</span>
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
            {(() => {
              const r = reach;
              let cls = "g", text = "NginUX · ports 80 / 443", title = "Checking reachability…";
              if (r) {
                if (!r.nginxUp) {
                  cls = "r"; text = "nginx down on 80 / 443";
                  title = "nginx isn't responding on ports 80/443 — the proxy data plane may be down.";
                } else if (r.ipMismatch) {
                  cls = "y"; text = "Public IP changed";
                  title = `Your public IP looks like ${r.detectedPublicIp}, but ${r.configuredPublicIp} is configured. DNS A records may now point to the wrong address — update them (and Settings).`;
                } else {
                  cls = "g"; text = "Serving 80 / 443";
                  const extOk = r.ext443 === true || r.ext80 === true;
                  title = `nginx is serving on 80/443. Externally reachable: ${extOk ? "yes ✓" : "couldn't confirm from inside your network (test from outside / check the port-forward)"}.`;
                }
              }
              return (
                <div className="node-foot" title={title}>
                  <span className={`dot ${cls}`} />
                  {text}
                </div>
              );
            })()}
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
