import { useEffect, useState } from "react";
import type { Route } from "../App.tsx";
import { api, certForHost, type MetricsSummary, type Certificate } from "../api.ts";
import type { ProxyHost, Topology as TopologyData } from "../types.ts";
import { Icon } from "../icons.tsx";
import { NetworkTraffic } from "../components/NetworkTraffic.tsx";

const fmtCount = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));

export function Dashboard({
  hosts,
  navigate,
}: {
  hosts: ProxyHost[];
  navigate: (r: Route) => void;
}) {
  const [topology, setTopology] = useState<TopologyData | null>(null);
  const [summary, setSummary] = useState<MetricsSummary | null>(null);
  const [certs, setCerts] = useState<Certificate[]>([]);

  useEffect(() => {
    api.topology().then(setTopology).catch(() => setTopology(null));
    // Real traffic numbers; only admin/editor can read metrics, so a readonly
    // user simply sees "-" rather than a fabricated figure.
    api.metricsSummary().then(setSummary).catch(() => setSummary(null));
    // Cert status comes from the store (source of truth), like every other screen.
    api.certificates().then(setCerts).catch(() => setCerts([]));
  }, [hosts]);

  const online = hosts.filter((h) => h.enabled && h.health === "online").length;
  const paused = hosts.filter((h) => !h.enabled).length;
  // Paused services are intentionally offline, so they don't count as "needs
  // attention" - only enabled-but-unhealthy ones do.
  const needsAttention = hosts.filter((h) => h.enabled && h.health !== "online").length;
  // Only HTTPS L7 services use a web certificate. "Valid" here means a trusted
  // (non-self-signed) cert that's current - read from the cert store, so this
  // agrees with the host detail + Certificates page. Self-signed, expired, or
  // failed certs count as "needs a trusted cert".
  const sslHosts = hosts.filter((h) => h.ssl && (h.protocol === "http" || h.protocol === "grpc" || !h.protocol));
  const trustedValid = sslHosts.filter((h) => {
    const c = certForHost(h, certs);
    return !!c && c.method !== "selfsigned" && (c.status === "valid" || c.status === "expiring");
  });
  const needCert = sslHosts.length - trustedValid.length;
  const nextRenewal = trustedValid.length
    ? Math.min(...trustedValid.map((h) => certForHost(h, certs)!.daysRemaining ?? 99999))
    : null;
  const unprotected = hosts.filter((h) => h.ssl && !h.requireLogin).length;

  // Fresh install: a welcoming hero beats a grid of zeros + an empty map.
  if (hosts.length === 0) {
    return (
      <>
        <div className="topbar">
          <h1>Dashboard</h1>
        </div>
        <div className="content">
          <div className="card" style={{ textAlign: "center", padding: "52px 24px" }}>
            <div style={{ fontSize: 40 }}>🚀</div>
            <h2 style={{ marginTop: 12 }}>Welcome to NginUX</h2>
            <p className="muted" style={{ maxWidth: 460, margin: "10px auto 22px", lineHeight: 1.6 }}>
              Let's get your first service online. Point a domain at an app on your network and
              NginUX sets up the reverse proxy and a free HTTPS certificate for you - about a minute, no nginx config required.
            </p>
            <button className="btn btn-primary" onClick={() => navigate({ name: "wizard" })}>
              <Icon.plus />
              Expose your first service
            </button>
          </div>
        </div>
      </>
    );
  }

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
              ) : paused > 0 ? (
                <>
                  <span className="dot n" />
                  <span style={{ color: "var(--text-faint)" }}>{paused} paused</span>
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
              {trustedValid.length} <small>/ {sslHosts.length}</small>
            </div>
            <div className="trend" style={{ color: needCert > 0 ? "var(--yellow)" : "var(--text-dim)" }}>
              {needCert > 0
                ? `${needCert} need a trusted cert`
                : nextRenewal !== null ? `Next renewal in ${nextRenewal} days` : "-"}
            </div>
          </div>

          <div className="card stat">
            <div className="label">
              <Icon.chart />
              Requests
            </div>
            <div className="value">
              {summary ? fmtCount(summary.totalRequests) : "-"} <small>total</small>
            </div>
            <div className="trend" style={{ color: summary && summary.errorRate > 5 ? "var(--yellow)" : "var(--text-dim)" }}>
              {summary ? `${summary.errorRate}% errors · ${summary.p95}ms p95` : "Since the proxy started"}
            </div>
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
                <a style={{ cursor: "pointer", textDecoration: "underline" }} onClick={() => navigate({ name: "security", tab: "exposure" })}>
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
