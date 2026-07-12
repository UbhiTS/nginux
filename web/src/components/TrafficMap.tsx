import { useCallback, useEffect, useRef, useState } from "react";
import type { MetricsSummary } from "../api.ts";
import { Icon } from "../icons.tsx";
import { WORLD_LAND } from "./worldland.ts";
import { flag, countryName } from "../format.ts";
import { usePrefersReducedMotion } from "../hooks.ts";

// Rough country centroids [lat, lon] for the traffic bubble map.
const CENTROIDS: Record<string, [number, number]> = {
  CA: [56, -106], US: [38, -97], MX: [23, -102], BR: [-10, -55], AR: [-38, -63],
  GB: [54, -2], IE: [53, -8], FR: [46, 2], DE: [51, 10], NL: [52, 5], ES: [40, -4],
  PT: [39, -8], IT: [42, 12], CH: [47, 8], SE: [62, 15], NO: [62, 10], FI: [64, 26],
  PL: [52, 19], RU: [61, 90], UA: [48, 31], TR: [39, 35], IN: [21, 78], CN: [35, 103],
  JP: [36, 138], KR: [36, 128], SG: [1, 104], AU: [-25, 133], NZ: [-41, 174],
  ZA: [-29, 24], NG: [9, 8], EG: [26, 30], AE: [24, 54], SA: [24, 45], IL: [31, 35],
  ID: [-2, 118], TH: [15, 101], VN: [16, 108], PH: [13, 122], MY: [4, 102], HK: [22, 114], TW: [24, 121],
};

const W = 640, H = 320;
const proj = (lat: number, lon: number): [number, number] => [((lon + 180) / 360) * W, ((90 - lat) / 180) * H];
// Build an SVG path from a flat [lon,lat,lon,lat,...] land ring (equirectangular).
const landPath = (ring: number[]) => {
  let d = "";
  for (let i = 0; i < ring.length; i += 2) {
    const [x, y] = proj(ring[i + 1], ring[i]);
    d += (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1);
  }
  return d + "Z";
};

// Pan/zoom transform for the map: translate (x,y) then scale (s), in SVG units.
type View = { s: number; x: number; y: number };
const MAX_ZOOM = 8;
// Keep the content covering the viewport (no empty margins): at scale s the content
// spans [x, x + W*s]; to cover [0,W] we need W*(1-s) <= x <= 0 (and likewise y).
const clampView = (v: View): View => ({
  s: v.s,
  x: Math.min(0, Math.max(W * (1 - v.s), v.x)),
  y: Math.min(0, Math.max(H * (1 - v.s), v.y)),
});

export function TrafficMap({ countries, emptyHint, homeCountry, onPickIp, onBlockIp }: {
  countries: MetricsSummary["topCountries"];
  emptyHint?: string;
  homeCountry?: string;
  onPickIp: (ip: string) => void;
  onBlockIp: (ip: string) => Promise<void>;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const max = Math.max(1, ...countries.map((c) => c.count));
  // The popup stays open while the cursor is over a bubble OR the popup itself,
  // and auto-closes 3s after the cursor leaves both (or immediately via the X).
  const [open, setOpen] = useState<{ c: MetricsSummary["topCountries"][number]; x: number; y: number } | null>(null);
  const [blocked, setBlocked] = useState<Record<string, "busy" | "done">>({});
  const closeTimer = useRef<number | null>(null);
  const cancelClose = () => { if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; } };
  const scheduleClose = () => { cancelClose(); closeTimer.current = window.setTimeout(() => setOpen(null), 3000); };
  useEffect(() => () => cancelClose(), []);

  // ---- pan / zoom: double-click or wheel to zoom (toward the cursor), drag to pan ----
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [view, setView] = useState<View>({ s: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ cx: number; cy: number; ox: number; oy: number } | null>(null);
  // Client px -> SVG user units (the viewBox is 0..W x 0..H scaled to the element).
  const toSvg = useCallback((cx: number, cy: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: ((cx - r.left) / r.width) * W, y: ((cy - r.top) / r.height) * H };
  }, []);
  // Zoom by factor f keeping the SVG-space point p stationary under the cursor.
  const zoomAt = useCallback((p: { x: number; y: number }, f: number) => setView((v) => {
    const s = Math.min(MAX_ZOOM, Math.max(1, v.s * f));
    if (s === v.s) return v;
    let x = p.x - (p.x - v.x) * (s / v.s);
    let y = p.y - (p.y - v.y) * (s / v.s);
    if (s === 1) { x = 0; y = 0; }
    return clampView({ s, x, y });
  }), []);
  // Wheel zoom needs a non-passive listener to preventDefault the page scroll.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => { e.preventDefault(); zoomAt(toSvg(e.clientX, e.clientY), e.deltaY < 0 ? 1.2 : 1 / 1.2); };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [toSvg, zoomAt]);

  const homeCc = homeCountry?.toUpperCase();
  const homeCtr = homeCc ? CENTROIDS[homeCc] : undefined;
  const home = homeCtr ? proj(homeCtr[0], homeCtr[1]) : null;

  const block = async (ip: string) => {
    setBlocked((b) => ({ ...b, [ip]: "busy" }));
    try { await onBlockIp(ip); setBlocked((b) => ({ ...b, [ip]: "done" })); }
    catch { setBlocked((b) => { const n = { ...b }; delete n[ip]; return n; }); }
  };

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-head">Traffic map <span className="pill n">by source country</span>
        <span className="muted" style={{ fontSize: 11, marginLeft: 8, fontWeight: 400 }}>· drag to pan · scroll / double-click to zoom</span>
        {home && <span className="muted" style={{ fontSize: 11, marginLeft: "auto", fontWeight: 400 }}>arcs converge on {flag(homeCc!)} {countryName(homeCc!)}</span>}
      </div>
      <div className="card-pad">
        <div style={{ position: "relative" }}>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            style={{ width: "100%", height: "auto", display: "block", background: "var(--bg)", borderRadius: 8, cursor: dragging ? "grabbing" : view.s > 1 ? "grab" : "default", touchAction: "none" }}
            onDoubleClick={(e) => zoomAt(toSvg(e.clientX, e.clientY), 1.7)}
            onPointerDown={(e) => { if (e.button !== 0) return; svgRef.current!.setPointerCapture(e.pointerId); drag.current = { cx: e.clientX, cy: e.clientY, ox: view.x, oy: view.y }; setDragging(true); }}
            onPointerMove={(e) => { const d = drag.current; if (!d) return; const r = svgRef.current!.getBoundingClientRect(); const dx = (e.clientX - d.cx) * (W / r.width); const dy = (e.clientY - d.cy) * (H / r.height); setView((v) => clampView({ s: v.s, x: d.ox + dx, y: d.oy + dy })); }}
            onPointerUp={(e) => { drag.current = null; setDragging(false); try { svgRef.current?.releasePointerCapture(e.pointerId); } catch { /* ignore */ } }}
          >
            <g transform={`translate(${view.x.toFixed(2)} ${view.y.toFixed(2)}) scale(${view.s.toFixed(3)})`}>
            <g>
              {WORLD_LAND.map((ring, i) => (
                <path key={i} d={landPath(ring)} fill="var(--bg-elev2)" stroke="var(--border)" strokeWidth={0.4} />
              ))}
            </g>
            {/* Thin solid arc from each source to home, with one dot travelling
                source -> home -> source at constant speed (like the Network Map).
                Curvature scales with length (no cap) so near and far arcs share
                the same shape. */}
            {home && countries.map((c) => {
              const ctr = CENTROIDS[c.key.toUpperCase()];
              if (!ctr || c.key.toUpperCase() === homeCc) return null;
              const [x, y] = proj(ctr[0], ctr[1]);
              const dx = home[0] - x, dy = home[1] - y, len = Math.hypot(dx, dy) || 1;
              const off = len * 0.16; // proportional bulge -> consistent curvature
              const cx = (x + home[0]) / 2 + (-dy / len) * off, cy = (y + home[1]) / 2 + (dx / len) * off;
              const d = `M${x.toFixed(1)} ${y.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${home[0].toFixed(1)} ${home[1].toFixed(1)}`;
              const dur = Math.max(2, (len * 2.2) / 130).toFixed(2); // ~constant px/sec, both ways
              return (
                <g key={"arc-" + c.key}>
                  <path d={d} fill="none" stroke="var(--accent)" strokeWidth={0.6} strokeOpacity={0.2} strokeLinecap="round" />
                  {/* Static dot at the source when reduced motion is preferred; a dot
                      travelling source -> home -> source otherwise. */}
                  {reducedMotion ? (
                    <circle cx={x} cy={y} r={2.0} fill="var(--accent)" />
                  ) : (
                    <circle r={2.0} fill="var(--accent)">
                      <animateMotion path={d} dur={`${dur}s`} repeatCount="indefinite" keyPoints="0;1;0" keyTimes="0;0.5;1" calcMode="linear" />
                    </circle>
                  )}
                </g>
              );
            })}
            {home && <circle cx={home[0]} cy={home[1]} r={4.5} fill="var(--green)" stroke="var(--green)" strokeOpacity={0.4} strokeWidth={3} />}
            {countries.map((c) => {
              const ctr = CENTROIDS[c.key.toUpperCase()];
              if (!ctr) return null;
              const [x, y] = proj(ctr[0], ctr[1]);
              const r = 4 + (c.count / max) * 14;
              const on = open?.c.key === c.key;
              return (
                <g key={c.key} style={{ cursor: "pointer" }} onMouseEnter={() => { if (drag.current) return; cancelClose(); setOpen({ c, x, y }); }} onMouseLeave={scheduleClose}>
                  <circle cx={x} cy={y} r={r} fill="var(--accent)" fillOpacity={on ? 0.8 : 0.45} stroke="var(--accent)" strokeWidth={on ? 1.8 : 1} />
                  <text x={x} y={y + 3} textAnchor="middle" fontSize={9} fill="var(--text)" style={{ pointerEvents: "none", fontWeight: 600 }}>{c.key}</text>
                </g>
              );
            })}
            </g>
          </svg>
          {view.s > 1 && (
            <button className="btn btn-sm" onClick={() => setView({ s: 1, x: 0, y: 0 })}
              style={{ position: "absolute", top: 8, right: 8, zIndex: 6 }} title="Reset zoom">Reset</button>
          )}
          {open && (
            <div onMouseEnter={cancelClose} onMouseLeave={scheduleClose} style={{
              position: "absolute",
              left: `${((view.x + open.x * view.s) / W) * 100}%`,
              top: `${((view.y + open.y * view.s) / H) * 100}%`,
              transform: `translate(${open.x < W * 0.25 ? "0%" : open.x > W * 0.75 ? "-100%" : "-50%"}, ${open.y < H * 0.4 ? "16px" : "calc(-100% - 16px)"})`,
              background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 8,
              padding: "8px 10px", boxShadow: "var(--shadow)", minWidth: 200, zIndex: 5,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: open.c.topIps.length ? 6 : 0 }}>
                <div style={{ fontWeight: 600, fontSize: 12.5, flex: 1 }}>
                  {flag(open.c.key)} {countryName(open.c.key)} <span className="muted" style={{ fontWeight: 400 }}>· {open.c.count} req</span>
                </div>
                <button className="map-pop-x" title="Close" onClick={() => { cancelClose(); setOpen(null); }}><Icon.x /></button>
              </div>
              {open.c.topIps.length > 0 && (
                <div style={{ borderTop: "1px solid var(--border-soft)", paddingTop: 5 }}>
                  <div className="muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 4 }}>Top IPs · click to filter</div>
                  {open.c.topIps.map((t) => {
                    const st = blocked[t.ip];
                    return (
                      <div key={t.ip} className="map-ip">
                        <button className="map-ip-pick mono" title="Show logs from this IP" onClick={() => onPickIp(t.ip)}>{t.ip}</button>
                        <span className="muted">{t.count}</span>
                        <button className={`map-ip-block${st === "done" ? " done" : ""}`} disabled={!!st}
                          title={st === "done" ? "Blocked on all services" : "Block this IP on all services"}
                          onClick={() => block(t.ip)}>
                          {st === "done" ? <Icon.check /> : st === "busy" ? <span className="spinner" style={{ width: 11, height: 11 }} /> : <Icon.shield />}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
        {countries.length === 0 && emptyHint && (
          <div className="muted" style={{ fontSize: 12.5, textAlign: "center", marginTop: 10 }}>{emptyHint}</div>
        )}
      </div>
    </div>
  );
}
