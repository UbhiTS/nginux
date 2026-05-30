import { useEffect, useState } from "react";
import type { Route } from "../App.tsx";
import { api } from "../api.ts";
import type { ProxyHost, Topology as TopologyData } from "../types.ts";
import { Icon } from "../icons.tsx";
import { NetworkTraffic } from "../components/NetworkTraffic.tsx";

export function Dashboard({
  hosts,
  navigate,
}: {
  hosts: ProxyHost[];
  navigate: (r: Route) => void;
}) {
  const [topology, setTopology] = useState<TopologyData | null>(null);

  useEffect(() => {
    api.topology().then(setTopology).catch(() => setTopology(null));
  }, [hosts]);

  const online = hosts.filter((h) => h.health === "online").length;
  const needsAttention = hosts.filter((h) => h.health !== "online").length;
  const withCert = hosts.filter((h) => h.certExpiresAt);
  const days = (iso: string) => Math.round((Date.parse(iso) - Date.now()) / 86400_000);
  const nextRenewal = withCert.length
    ? Math.min(...withCert.map((h) => days(h.certExpiresAt!)))
    : null;
  const unprotected = hosts.filter((h) => h.ssl && !h.requireLogin).length;

  return (
    <>
      <div className="topbar">
        <h1>Dashboard</h1>
      </div>
      <div className="content">
        <div className="stats">
          <div className="card stat">
            <div className="label">
              <Icon.check />
              Services online
            </div>
            <div className="value">
              {online} <small>/ {hosts.length}</small>
            </div>
            <div className="trend">
              {needsAttention > 0 ? (
                <>
                  <span className="dot y" />
                  <span style={{ color: "var(--yellow)" }}>{needsAttention} need attention</span>
                </>
              ) : (
                <span>All healthy</span>
              )}
            </div>
          </div>

          <div className="card stat">
            <div className="label">
              <Icon.cert />
              Certificates valid
            </div>
            <div className="value">
              {withCert.length} <small>/ {hosts.length}</small>
            </div>
            <div className="trend" style={{ color: "var(--text-dim)" }}>
              {nextRenewal !== null ? `Next renewal in ${nextRenewal} days` : "—"}
            </div>
          </div>

          <div className="card stat">
            <div className="label">
              <Icon.chart />
              Traffic today
            </div>
            <div className="value">
              142k <small>reqs</small>
            </div>
            <div className="trend">12% vs yesterday</div>
          </div>

          <div className="card stat">
            <div className="label">
              <Icon.shield />
              Security status
            </div>
            <div className="value" style={{ color: unprotected ? "var(--yellow)" : "var(--green)" }}>
              {unprotected ? "Review" : "Good"}
            </div>
            <div className="trend" style={{ color: unprotected ? "var(--yellow)" : "var(--text-dim)" }}>
              {unprotected ? (
                <a style={{ cursor: "pointer", textDecoration: "underline" }} onClick={() => navigate({ name: "security" })}>
                  {unprotected} service{unprotected > 1 ? "s" : ""} unprotected
                </a>
              ) : (
                "Nothing exposed without a login"
              )}
            </div>
          </div>
        </div>

        <NetworkTraffic data={topology} navigate={navigate} />
      </div>
    </>
  );
}
