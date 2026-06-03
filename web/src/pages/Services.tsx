import { useState } from "react";
import type { Route } from "../App.tsx";
import { api } from "../api.ts";
import type { ProxyHost } from "../types.ts";
import { healthClass } from "../types.ts";
import { Icon } from "../icons.tsx";

const statusText = (h: ProxyHost) => {
  if (h.health === "down") return "Can't reach service";
  const bits = ["Online"];
  if (h.ssl) bits.push("Secured");
  if (h.require2fa) bits.push("2FA");
  else if (h.requireLogin) bits.push("Login");
  else bits.push("No login");
  return bits.join(" · ");
};

export function Services({
  hosts,
  navigate,
  reload,
}: {
  hosts: ProxyHost[];
  navigate: (r: Route) => void;
  reload: () => Promise<void>;
}) {
  const [toggling, setToggling] = useState<string | null>(null);

  const days = (iso: string | null) =>
    iso ? Math.round((Date.parse(iso) - Date.now()) / 86400_000) : null;

  // Flip a service between served (enabled) and paused (disabled). Disabling
  // removes its nginx server block so the site stops responding publicly.
  const toggle = async (h: ProxyHost) => {
    setToggling(h.id);
    try {
      await api.updateHost(h.id, { enabled: !h.enabled });
      await reload();
    } finally {
      setToggling(null);
    }
  };

  return (
    <>
      <div className="topbar">
        <h1>Exposed services</h1>
        <div style={{ flex: 1 }} />
        <button className="btn btn-primary" onClick={() => navigate({ name: "wizard" })}>
          <Icon.plus />
          Expose a service
        </button>
      </div>
      <div className="content">
        <div className="card">
          <div className="col-head">
            <div>Service</div>
            <div>Status</div>
            <div>Certificate</div>
            <div>Address</div>
            <div>Enabled</div>
          </div>
          {hosts.map((h) => {
            const d = days(h.certExpiresAt);
            return (
              <div
                key={h.id}
                className={`host-row${h.enabled ? "" : " is-paused"}`}
                role="button"
                tabIndex={0}
                aria-label={`Open ${h.name}`}
                onClick={() => navigate({ name: "host", hostId: h.id })}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigate({ name: "host", hostId: h.id }); } }}
              >
                <div className="host-main">
                  <div className="host-icon">{h.emoji}</div>
                  <div>
                    <div className="host-name">{h.name}</div>
                    <div className="host-url">{h.domain}</div>
                  </div>
                </div>
                <div className="host-status-text">
                  <span className={`dot ${h.enabled ? healthClass[h.health] : "n"}`} />
                  <span style={{ color: !h.enabled ? "var(--text-faint)" : h.health === "down" ? "var(--red)" : undefined }}>
                    {h.enabled ? statusText(h) : "Paused · not served"}
                  </span>
                </div>
                <div className="host-meta">
                  <span className="strong">{d !== null ? "Valid" : h.ssl ? "Self-signed" : "No cert"}</span>
                  {d !== null ? `${d} days left` : h.ssl ? "untrusted" : "-"}
                </div>
                <div className="host-meta mono">
                  {h.forwardHost}:{h.forwardPort}
                </div>
                <button
                  className={`switch${h.enabled ? " on" : ""}`}
                  title={h.enabled ? "Serving - click to pause" : "Paused - click to serve"}
                  aria-label={h.enabled ? `Pause ${h.name}` : `Serve ${h.name}`}
                  aria-pressed={h.enabled}
                  disabled={toggling === h.id}
                  onClick={(e) => { e.stopPropagation(); void toggle(h); }}
                />
              </div>
            );
          })}
          {hosts.length === 0 && (
            <div className="placeholder">
              <h2>No services yet</h2>
              <p>Expose your first internal service - it takes about a minute.</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
