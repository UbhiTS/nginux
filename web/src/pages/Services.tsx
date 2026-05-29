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
  const days = (iso: string | null) =>
    iso ? Math.round((Date.parse(iso) - Date.now()) / 86400_000) : null;

  const remove = async (e: React.MouseEvent, h: ProxyHost) => {
    e.stopPropagation();
    if (!confirm(`Remove ${h.name} (${h.domain})? This takes it offline.`)) return;
    await api.deleteHost(h.id);
    await reload();
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
            <div />
          </div>
          {hosts.map((h) => {
            const d = days(h.certExpiresAt);
            return (
              <div key={h.id} className="host-row" onClick={() => navigate({ name: "host", hostId: h.id })}>
                <div className="host-main">
                  <div className="host-icon">{h.emoji}</div>
                  <div>
                    <div className="host-name">{h.name}</div>
                    <div className="host-url">{h.domain}</div>
                  </div>
                </div>
                <div className="host-status-text">
                  <span className={`dot ${healthClass[h.health]}`} />
                  <span style={{ color: h.health === "down" ? "var(--red)" : undefined }}>
                    {statusText(h)}
                  </span>
                </div>
                <div className="host-meta">
                  <span className="strong">{d !== null ? "Valid" : "No cert"}</span>
                  {d !== null ? `${d} days left` : "—"}
                </div>
                <div className="host-meta mono">
                  {h.forwardHost}:{h.forwardPort}
                </div>
                <button className="btn btn-ghost btn-sm" onClick={(e) => remove(e, h)}>
                  Delete
                </button>
              </div>
            );
          })}
          {hosts.length === 0 && (
            <div className="placeholder">
              <h2>No services yet</h2>
              <p>Expose your first internal service — it takes about a minute.</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
