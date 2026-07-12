import { useEffect, useState } from "react";
import { routeHash, type Route } from "../App.tsx";
import { api, certForHost, type MetricsSummary, type Certificate } from "../api.ts";
import type { ProxyHost, Topology as TopologyData } from "../types.ts";
import { Icon } from "../icons.tsx";
import { useCountUp } from "../hooks.ts";
import { NetworkTraffic } from "../components/NetworkTraffic.tsx";

const fmtCount = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));

// A drill-down count rendered as a real link (href + keyboard-operable) instead of the
// old bare <a onClick> that had no href/role and couldn't be reached by keyboard.
function DrillLink({
  route,
  navigate,
  children,
  style,
}: {
  route: Route;
  navigate: (r: Route) => void;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <a
      href={routeHash(route)}
      style={{ textDecoration: "underline", cursor: "pointer", color: "inherit", ...style }}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(route);
      }}
    >
      {children}
    </a>
  );
}

export function Dashboard({
  hosts,
  navigate,
  loadError = false,
  onRetry,
  hostsLoaded = true,
}: {
  hosts: ProxyHost[];
  navigate: (r: Route) => void;
  loadError?: boolean;
  onRetry?: () => void;
  hostsLoaded?: boolean;
}) {
  const [topology, setTopology] = useState<TopologyData | null>(null);
  const [summary, setSummary] = useState<MetricsSummary | null>(null);
  const [certs, setCerts] = useState<Certificate[]>([]);
  const [version, setVersion] = useState("");

  // The running NginUX version, shown top-right of the header.
  useEffect(() => {
    api.health().then((h) => setVersion(h.version)).catch(() => {});
  }, []);

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

  // Gentle count-up for the single biggest headline number (total requests).
  // Called unconditionally before the early returns so hook order stays stable.
  const requestsCount = useCountUp(summary?.totalRequests ?? 0);

  // Still waiting on the first host load: show a skeleton, not the "expose your first
  // service" hero. App seeds hosts=[] before the fetch settles, so gating on hostsLoaded
  // stops the hero from flashing for users who actually have services.
  if (!hostsLoaded && hosts.length === 0) {
    return (
      <>
        <div className="topbar">
          <h1>Dashboard</h1>
        </div>
        <div className="content">
          <div className="stats">
            {[0, 1, 2, 3].map((i) => (
              <div className="card stat skeleton-row" key={i} aria-hidden="true">
                <div className="skeleton skeleton-text" style={{ width: "55%" }} />
                <div className="skeleton skeleton-text" style={{ width: "35%", height: 28, marginTop: 10 }} />
                <div className="skeleton skeleton-text" style={{ width: "70%", marginTop: 10 }} />
              </div>
            ))}
          </div>
          <div className="card skeleton" style={{ height: 260, marginTop: 16 }} aria-hidden="true" />
          <span className="sr-only" role="status">Loading dashboard…</span>
        </div>
      </>
    );
  }

  // Fresh install: a welcoming hero beats a grid of zeros + an empty map.
  if (hosts.length === 0) {
    return (
      <>
        <div className="topbar">
          <h1>Dashboard</h1>
          {version && <span className="pill n" style={{ marginLeft: "auto" }} title="Running NginUX version">v{version}</span>}
        </div>
        <div className="content">
          {loadError ? (
            // A fetch failure must not masquerade as "no services yet" - that would nudge
            // the user to re-create hosts they already have. Show the truth + a retry.
            <div className="card" style={{ textAlign: "center", padding: "52px 24px" }}>
              <div style={{ fontSize: 40 }}>⚠️</div>
              <h2 style={{ marginTop: 12 }}>Couldn't reach the server</h2>
              <p className="muted" style={{ maxWidth: 460, margin: "10px auto 22px", lineHeight: 1.6 }}>
                We couldn't load your services just now. This is usually a brief backend hiccup -
                your configuration is safe. Try again in a moment.
              </p>
              {onRetry && (
                <button className="btn btn-primary" onClick={onRetry}>
                  <Icon.refresh />
                  Retry
                </button>
              )}
            </div>
          ) : (
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
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="topbar">
        <h1>Dashboard</h1>
        {version && (
          <span className="pill n" style={{ marginLeft: "auto" }} title="Running NginUX version">
            <Icon.bolt />v{version}
          </span>
        )}
      </div>
      <div className="content">
        <div className="stats animate-rise-stagger">
          <div className="card stat">
            <div className="label">
              <Icon.server />
              Services online
            </div>
            <div className="value">
              {online} <small>/ {hosts.length}</small>
            </div>
            <div className="trend">
              {needsAttention > 0 ? (
                <>
                  <span className="dot y" />
                  <DrillLink route={{ name: "services" }} navigate={navigate} style={{ color: "var(--yellow)" }}>
                    {needsAttention} need attention
                  </DrillLink>
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
              {needCert > 0 ? (
                <DrillLink route={{ name: "certs" }} navigate={navigate} style={{ color: "var(--yellow)" }}>
                  {needCert} need a trusted cert
                </DrillLink>
              ) : nextRenewal !== null ? (
                `Next renewal in ${nextRenewal} days`
              ) : (
                "-"
              )}
            </div>
          </div>

          <div className="card stat">
            <div className="label">
              <Icon.chart />
              Requests
            </div>
            <div className="value">
              {summary ? fmtCount(requestsCount) : "-"} <small>total</small>
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
                <DrillLink route={{ name: "security", tab: "exposure" }} navigate={navigate}>
                  {unprotected} service{unprotected > 1 ? "s" : ""} unprotected
                </DrillLink>
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
