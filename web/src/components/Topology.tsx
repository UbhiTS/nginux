import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Route } from "../App.tsx";
import type { Topology as TopologyData } from "../types.ts";
import { healthClass } from "../types.ts";
import { api } from "../api.ts";

interface Stroke { d: string; color: string; dashed: boolean; }
interface Flow {
  path: string; // path a dot travels (full journey, through the gateway)
  color: string;
  count: number; // dots in this batch ∝ traffic
  dur: number; // full cycle length (request phase + response phase), per-service
  begin: string; // negative offset so services don't sync
  winStart: number; // when this batch's first dot launches (fraction of dur)
  winEnd: number; // when the last dot arrives (fraction of dur)
  travel: number; // fraction of dur a single dot spends in flight
}

const MAX_DOTS = 6;
const PALETTE = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#a855f7", "#ec4899",
  "#06b6d4", "#f97316", "#84cc16", "#eab308", "#8b5cf6", "#14b8a6",
];

export function Topology({
  data,
  navigate,
}: {
  data: TopologyData;
  navigate: (r: Route) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const internetRef = useRef<HTMLDivElement>(null);
  const gatewayRef = useRef<HTMLDivElement>(null);
  const svcRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [traffic, setTraffic] = useState<Record<string, number>>({});

  useEffect(() => {
    let alive = true;
    const pull = () =>
      api.metricsSummary()
        .then((s) => { if (alive) setTraffic(Object.fromEntries(s.topHosts.map((h) => [h.key, h.count]))); })
        .catch(() => {});
    pull();
    const id = setInterval(pull, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

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
    const curve = (a: P, b: P) => { const mx = (a.x + b.x) / 2; return `C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`; };
    const seg = (a: P, b: P) => `M ${a.x} ${a.y} ${curve(a, b)}`;
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
    const max = Math.max(1, ...services.map((s) => traffic[s.domain] ?? 0));

    const nextStrokes: Stroke[] = [];
    const nextFlows: Flow[] = [];

    services.forEach((svc, i) => {
      const color = PALETTE[i % PALETTE.length];
      const down = svc.health === "down";
      const c = traffic[svc.domain] ?? 0;
      const ratio = c / max;
      const reqN = c > 0 ? Math.max(1, Math.round(ratio * MAX_DOTS)) : (down ? 0 : 1);
      const respN = down ? 0 : reqN;

      const a1 = { x: netA.x, y: yAt(netA.y, i) };   // internet edge
      const b1 = { x: gwLeft.x, y: yAt(gwLeft.y, i) }; // gateway left
      const a2 = { x: gwRight.x, y: yAt(gwRight.y, i) }; // gateway right
      const el = svcRefs.current.get(svc.id);
      const b2 = el ? anchor(el, "l") : a2; // service row

      // Visible lines: internet→gateway (always) and gateway→service (dead/dashed if down).
      nextStrokes.push({ d: seg(a1, b1), color, dashed: false });
      if (el) nextStrokes.push({ d: seg(a2, b2), color, dashed: down });

      // Per-service clock: busier flows a little faster; offset so none are in sync.
      const dur = 4.4 + (i % 4) * 0.8 - ratio * 1.3;
      const begin = `-${(i * 1.37).toFixed(2)}s`;

      // Request batch: full path to the service (or just to the gateway if it's
      // unreachable — the dots arrive at the router and are dropped).
      const reqPath = down || !el ? seg(a1, b1) : through(a1, b1, a2, b2);
      nextFlows.push({ path: reqPath, color, count: reqN, dur, begin, winStart: 0.03, winEnd: 0.46, travel: 0.3 });

      // Response batch: full path back, starting only after the requests land.
      if (respN > 0 && el) {
        const respPath = through(b2, a2, b1, a1); // service → gateway → internet
        nextFlows.push({ path: respPath, color, count: respN, dur, begin, winStart: 0.54, winEnd: 0.97, travel: 0.3 });
      }
    });

    setStrokes(nextStrokes);
    setFlows(nextFlows);
  }, [data, traffic]);

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
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-head">
        Network map
        <span className="pill g">
          <span className="dot g" />
          live
        </span>
      </div>
      <div className="topo" ref={wrapRef}>
        <svg className="topo-lines" viewBox={`0 0 ${box.w} ${box.h}`} preserveAspectRatio="none">
          {strokes.map((s, i) => (
            <path
              key={`s${i}`}
              d={s.d}
              fill="none"
              stroke={s.color}
              strokeWidth={1.6}
              strokeOpacity={s.dashed ? 0.3 : 0.4}
              strokeDasharray={s.dashed ? "5 5" : undefined}
            />
          ))}
          {flows.flatMap((f, fi) => {
            const span = f.winEnd - f.winStart;
            const travel = Math.min(f.travel, span * 0.9);
            const step = f.count > 1 ? (span - travel) / (f.count - 1) : 0;
            return Array.from({ length: f.count }).map((_, k) => {
              const f0 = +(f.winStart + k * step).toFixed(3);
              const f1 = +(f0 + travel).toFixed(3);
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
    </div>
  );
}
