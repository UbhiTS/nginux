import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Route } from "../App.tsx";
import type { Topology as TopologyData } from "../types.ts";
import { healthClass } from "../types.ts";
import { api } from "../api.ts";

interface Stroke { d: string; color: string; dashed: boolean; host: string; width: number; }
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
const OFF = 4; // vertical gap between the request (upper) and response (lower) lines
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
  const [stats, setStats] = useState<Record<string, { requests: number; bytesIn: number; bytesOut: number }>>({});

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

  const draw = useCallback(() => {
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
    const up = (p: P): P => ({ x: p.x, y: p.y - OFF });
    const dn = (p: P): P => ({ x: p.x, y: p.y + OFF });
    const curve = (a: P, b: P) => { const mx = (a.x + b.x) / 2; return `C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`; };
    const seg = (a: P, b: P) => `M ${a.x} ${a.y} ${curve(a, b)}`;
    const dist = (a: P, b: P) => Math.hypot(b.x - a.x, b.y - a.y);
    // A full journey curves to the gateway, crosses behind it, then curves to the far point.
    const through = (p1: P, p2: P, p3: P, p4: P) => `M ${p1.x} ${p1.y} ${curve(p1, p2)} L ${p3.x} ${p3.y} ${curve(p3, p4)}`;

    const services = data.servers.flatMap((s) => s.services);
    const n = services.length;
    if (n === 0) { setStrokes([]); setFlows([]); return; }

    const netR = net.getBoundingClientRect();
    const gwR = gw.getBoundingClientRect();
    const netA = anchor(net, "r");
    const gwLeft = anchor(gw, "l");
    const gwRight = anchor(gw, "r");
    const usable = Math.min(netR.height, gwR.height) - 14;
    const gap = n > 1 ? Math.min(18, usable / (n - 1)) : 0;
    const yAt = (cy: number, i: number) => cy + (i - (n - 1) / 2) * gap;

    // Dots scale with requests; line width scales with bandwidth. Width is
    // normalized against the busiest direction across all services, so a small
    // request line stays thin and a heavy response line goes fat.
    const reqMax = Math.max(1, ...services.map((s) => stats[s.domain]?.requests ?? 0));
    const byteMax = Math.max(1, ...services.flatMap((s) => {
      const st = stats[s.domain];
      return st ? [st.bytesIn, st.bytesOut] : [0];
    }));
    const widthFor = (bytes: number) => (bytes <= 0 ? MIN_W : Math.min(MAX_W, MIN_W + (bytes / byteMax) * (MAX_W - MIN_W)));

    const nextStrokes: Stroke[] = [];
    const nextFlows: Flow[] = [];

    services.forEach((svc, i) => {
      const color = PALETTE[i % PALETTE.length];
      const down = svc.health === "down";
      const st = stats[svc.domain];
      const req = st?.requests ?? 0;
      const reqN = req > 0 ? Math.max(1, Math.round((req / reqMax) * MAX_DOTS)) : (down ? 0 : 1);
      const respN = down ? 0 : reqN;
      const inW = widthFor(st?.bytesIn ?? 0);
      const outW = widthFor(st?.bytesOut ?? 0);

      const a1 = { x: netA.x, y: yAt(netA.y, i) };   // internet edge
      const b1 = { x: gwLeft.x, y: yAt(gwLeft.y, i) }; // gateway left
      const a2 = { x: gwRight.x, y: yAt(gwRight.y, i) }; // gateway right
      const el = svcRefs.current.get(svc.id);
      const b2 = el ? anchor(el, "l") : a2; // service row

      // Request (ingress) line — upper, width ∝ request bandwidth.
      nextStrokes.push({ d: seg(up(a1), up(b1)), color, dashed: false, host: svc.domain, width: inW });
      if (el) nextStrokes.push({ d: seg(up(a2), up(b2)), color, dashed: down, host: svc.domain, width: inW });
      // Response (egress) line — lower, width ∝ response bandwidth (only when reachable).
      if (el && !down) {
        nextStrokes.push({ d: seg(dn(a1), dn(b1)), color, dashed: false, host: svc.domain, width: outW });
        nextStrokes.push({ d: seg(dn(a2), dn(b2)), color, dashed: false, host: svc.domain, width: outW });
      }

      // Phase offset so services don't move in unison (speed is unaffected).
      const begin = `-${(i * 1.37).toFixed(2)}s`;

      const reqPath = down || !el ? seg(up(a1), up(b1)) : through(up(a1), up(b1), up(a2), up(b2));
      const len = down || !el ? dist(a1, b1) : dist(a1, b1) + dist(b1, a2) + dist(a2, b2);
      const tf = len / SPEED; // flight time (s) — constant speed
      const batch = (m: number) => (Math.max(1, m) - 1) * STEP_SEC + tf; // batch duration (s)
      const hasResp = respN > 0 && !!el;
      const reqBatch = batch(reqN);
      const cycle = hasResp
        ? HANDOFF_SEC / 2 + reqBatch + HANDOFF_SEC + batch(respN) + HANDOFF_SEC / 2
        : HANDOFF_SEC / 2 + reqBatch + HANDOFF_SEC / 2;

      nextFlows.push({
        path: reqPath, host: svc.domain, color, count: reqN, dur: cycle, begin,
        t0: (HANDOFF_SEC / 2) / cycle, step: STEP_SEC / cycle, travel: tf / cycle,
      });
      if (hasResp) {
        const respPath = through(dn(b2), dn(a2), dn(b1), dn(a1)); // service → gateway → internet (lower line)
        const respStart = HANDOFF_SEC / 2 + reqBatch + HANDOFF_SEC;
        nextFlows.push({
          path: respPath, host: svc.domain, color, count: respN, dur: cycle, begin,
          t0: respStart / cycle, step: STEP_SEC / cycle, travel: tf / cycle,
        });
      }
    });

    setStrokes(nextStrokes);
    setFlows(nextFlows);
  }, [data, stats]);

  useLayoutEffect(() => {
    const id = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(id);
  }, [draw]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(wrap);
    window.addEventListener("resize", draw);
    return () => { ro.disconnect(); window.removeEventListener("resize", draw); };
  }, [draw]);

  return (
      <div className="topo" ref={wrapRef}>
        <svg className="topo-lines" viewBox={`0 0 ${box.w} ${box.h}`} preserveAspectRatio="none">
          {strokes.map((s, i) => {
            const dim = hovered ? s.host !== hovered : false;
            return (
              <path
                key={`s${i}`}
                d={s.d}
                fill="none"
                stroke={s.color}
                strokeWidth={s.width}
                strokeLinecap="round"
                strokeOpacity={dim ? 0.07 : s.dashed ? 0.3 : 0.45}
                strokeDasharray={s.dashed ? "5 5" : undefined}
              />
            );
          })}
          {flows.flatMap((f, fi) => {
            // When a service is hovered, only its dots animate.
            if (hovered && f.host !== hovered) return [];
            return Array.from({ length: f.count }).map((_, k) => {
              const f0 = +(f.t0 + k * f.step).toFixed(4);
              const f1 = +(f0 + f.travel).toFixed(4);
              return (
                <circle key={`f${fi}-${k}`} r={3.1} fill={f.color} opacity={0}>
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
