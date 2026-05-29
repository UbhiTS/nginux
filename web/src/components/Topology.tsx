import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Route } from "../App.tsx";
import type { Topology as TopologyData, HealthStatus } from "../types.ts";
import { healthClass } from "../types.ts";

interface Path {
  d: string;
  color: string;
  dashed: boolean;
}

const cssVar = (n: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function colorFor(status: HealthStatus): { color: string; dashed: boolean } {
  if (status === "down") return { color: cssVar("--red"), dashed: true };
  if (status === "degraded") return { color: cssVar("--yellow"), dashed: false };
  return { color: cssVar("--green"), dashed: false };
}

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
  const serverRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [paths, setPaths] = useState<Path[]>([]);
  const [box, setBox] = useState({ w: 0, h: 0 });

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

    const next: Path[] = [];
    next.push({ d: link(anchor(net, "r"), anchor(gw, "l")), color: cssVar("--accent"), dashed: false });
    for (const server of data.servers) {
      const el = serverRefs.current.get(server.name);
      if (!el) continue;
      const { color, dashed } = colorFor(server.status);
      next.push({ d: link(anchor(gw, "r"), anchor(el, "l")), color, dashed });
    }
    setPaths(next);
  }, [data]);

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
        <span className="pill g">
          <span className="dot g" />
          live
        </span>
      </div>
      <div className="topo" ref={wrapRef}>
        <svg className="topo-lines" viewBox={`0 0 ${box.w} ${box.h}`} preserveAspectRatio="none">
          {paths.map((p, i) => (
            <g key={i}>
              <path
                d={p.d}
                fill="none"
                stroke={p.color}
                strokeWidth={2}
                strokeOpacity={p.dashed ? 0.35 : 0.7}
                strokeDasharray={p.dashed ? "5 5" : undefined}
              />
              {!p.dashed && (
                <circle r={3.2} fill={p.color}>
                  <animateMotion dur="2.4s" repeatCount="indefinite" path={p.d} />
                </circle>
              )}
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
            <div
              key={server.name}
              className="srv-card"
              ref={(el) => {
                if (el) serverRefs.current.set(server.name, el);
                else serverRefs.current.delete(server.name);
              }}
            >
              <div className="srv-head">
                <span className="srv-ico">🖥️</span>
                <span className="srv-name">{server.name}</span>
                <span className="srv-ip">{server.ip}</span>
              </div>
              {server.services.map((s) => (
                <div key={s.id} className="svc" onClick={() => navigate({ name: "host", hostId: s.id })}>
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
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
