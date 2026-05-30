import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Route } from "../App.tsx";
import type { Topology as TopologyData } from "../types.ts";
import { healthClass } from "../types.ts";
import { api } from "../api.ts";

interface Line {
  fwd: string; // path in the request direction (internet → service)
  rev: string; // same curve, reversed (service → internet) for responses
  color: string;
  dashed: boolean;
  inDots: number; // requests flowing toward the service ∝ traffic
  outDots: number; // responses flowing back toward the internet
  dur: number; // seconds per loop (busier = faster, so streams overtake)
}

const MAX_DOTS = 6;
// Categorical palette — distinguishable for 12 services, readable on light & dark.
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
  const [paths, setPaths] = useState<Line[]>([]);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [traffic, setTraffic] = useState<Record<string, number>>({});
  const [dir, setDir] = useState<"in" | "out">("in"); // show one direction at a time

  // Poll per-host request counts; the map is "live".
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
    const link = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const mx = (a.x + b.x) / 2;
      return `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`;
    };

    const services = data.servers.flatMap((s) => s.services); // top-to-bottom render order
    const n = services.length;
    if (n === 0) { setPaths([]); return; }

    const netR = net.getBoundingClientRect();
    const gwR = gw.getBoundingClientRect();
    const netA = anchor(net, "r");
    const gwLeft = anchor(gw, "l");
    const gwRight = anchor(gw, "r");

    // One shared vertical gap, used for the internet→gateway lines AND for the
    // (spaced) start points of the gateway→service lines.
    const usable = Math.min(netR.height, gwR.height) - 14;
    const gap = n > 1 ? Math.min(18, usable / (n - 1)) : 0;
    const yAt = (cy: number, i: number) => cy + (i - (n - 1) / 2) * gap;

    const max = Math.max(1, ...services.map((s) => traffic[s.domain] ?? 0));

    const lines: Line[] = [];
    services.forEach((svc, i) => {
      const color = PALETTE[i % PALETTE.length];
      const down = svc.health === "down";
      const c = traffic[svc.domain] ?? 0;
      const ratio = c / max;
      // Requests flowing in (toward the service). A down service still receives
      // traffic at the gateway, so this stays > 0 when there's traffic.
      const reqDots = c > 0 ? Math.max(1, Math.round(ratio * MAX_DOTS)) : (down ? 0 : 1);
      // Responses flow back only if the service is actually reachable.
      const respDots = down ? 0 : reqDots;
      const dur = 3.2 - ratio * 1.7; // busier lines flow faster → overtaking

      // Segment 1: internet ↔ gateway. Always carries the incoming requests
      // (even for a down service — the traffic does reach the gateway).
      const a1 = { x: netA.x, y: yAt(netA.y, i) };
      const b1 = { x: gwLeft.x, y: yAt(gwLeft.y, i) };
      lines.push({ fwd: link(a1, b1), rev: link(b1, a1), color, dashed: false, inDots: reqDots, outDots: respDots, dur });

      // Segment 2: gateway ↔ service. For a down service this hop is dead —
      // dashed with no dots — so you can see traffic die before the service.
      const el = svcRefs.current.get(svc.id);
      if (el) {
        const a2 = { x: gwRight.x, y: yAt(gwRight.y, i) };
        const b2 = anchor(el, "l");
        lines.push({
          fwd: link(a2, b2), rev: link(b2, a2), color,
          dashed: down, inDots: down ? 0 : reqDots, outDots: down ? 0 : respDots, dur,
        });
      }
    });
    setPaths(lines);
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
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", draw);
    };
  }, [draw]);

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-head">
        Network map
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          <div className="range-tabs">
            <button className={`range${dir === "in" ? " active" : ""}`} onClick={() => setDir("in")}>Inbound</button>
            <button className={`range${dir === "out" ? " active" : ""}`} onClick={() => setDir("out")}>Outbound</button>
          </div>
          <span className="pill g">
            <span className="dot g" />
            live
          </span>
        </div>
      </div>
      <div className="topo" ref={wrapRef}>
        <svg className="topo-lines" viewBox={`0 0 ${box.w} ${box.h}`} preserveAspectRatio="none">
          {paths.map((p, i) => (
            <g key={i}>
              <path
                d={p.fwd}
                fill="none"
                stroke={p.color}
                strokeWidth={1.6}
                strokeOpacity={p.dashed ? 0.3 : 0.4}
                strokeDasharray={p.dashed ? "5 5" : undefined}
              />
              {/* one direction at a time; dot count ∝ that service's traffic */}
              {dir === "in"
                ? Array.from({ length: p.inDots }).map((_, k) => (
                    <circle key={`in${k}`} r={3.1} fill={p.color}>
                      <animateMotion
                        dur={`${p.dur}s`}
                        begin={`-${((k * p.dur) / Math.max(1, p.inDots)).toFixed(2)}s`}
                        repeatCount="indefinite"
                        path={p.fwd}
                      />
                    </circle>
                  ))
                : Array.from({ length: p.outDots }).map((_, k) => (
                    <circle key={`out${k}`} r={3.1} fill={p.color}>
                      <animateMotion
                        dur={`${p.dur}s`}
                        begin={`-${((k * p.dur) / Math.max(1, p.outDots)).toFixed(2)}s`}
                        repeatCount="indefinite"
                        path={p.rev}
                      />
                    </circle>
                  ))}
            </g>
          ))}
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
