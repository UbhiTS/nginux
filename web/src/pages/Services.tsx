import { useState } from "react";
import type { Route } from "../App.tsx";
import { api } from "../api.ts";
import type { ProxyHost } from "../types.ts";
import { healthClass } from "../types.ts";
import { Icon } from "../icons.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";

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
  const [pending, setPending] = useState<ProxyHost | null>(null);
  const [deleting, setDeleting] = useState(false);
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

  const remove = async () => {
    if (!pending) return;
    setDeleting(true);
    try {
      await api.deleteHost(pending.id);
      await reload();
      setPending(null);
    } finally {
      setDeleting(false);
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
            <div />
          </div>
          {hosts.map((h) => {
            const d = days(h.certExpiresAt);
            return (
              <div key={h.id} className={`host-row${h.enabled ? "" : " is-paused"}`} onClick={() => navigate({ name: "host", hostId: h.id })}>
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
                  <span className="strong">{d !== null ? "Valid" : "No cert"}</span>
                  {d !== null ? `${d} days left` : "—"}
                </div>
                <div className="host-meta mono">
                  {h.forwardHost}:{h.forwardPort}
                </div>
                <button
                  className={`switch${h.enabled ? " on" : ""}`}
                  title={h.enabled ? "Serving — click to pause" : "Paused — click to serve"}
                  disabled={toggling === h.id}
                  onClick={(e) => { e.stopPropagation(); void toggle(h); }}
                />
                <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); setPending(h); }}>
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

      {pending && (
        <ConfirmDialog
          danger
          title={`Remove ${pending.emoji} ${pending.name}?`}
          message={<>This takes <b>{pending.domain}</b> offline and deletes its proxy configuration. You can expose it again later.</>}
          confirmLabel="Remove service"
          busy={deleting}
          onConfirm={remove}
          onCancel={() => setPending(null)}
        />
      )}
    </>
  );
}
