import { useState, useEffect } from "react";
import type { Route } from "../App.tsx";
import { api, certForHost, type Certificate } from "../api.ts";
import type { ProxyHost, SecurityProfile } from "../types.ts";
import { healthClass } from "../types.ts";
import { Icon } from "../icons.tsx";
import { ServiceIcon } from "../components/ServiceIcon.tsx";

const statusText = (h: ProxyHost) => {
  if (h.health === "down") return "Can't reach service";
  const bits = ["Online"];
  if (h.ssl) bits.push("Secured");
  if (h.require2fa) bits.push("2FA");
  else if (h.requireLogin) bits.push("Login");
  else bits.push("No login");
  return bits.join(" · ");
};

// The cert badge, read from the cert store (the source of truth) - not the stale
// host.certExpiresAt - so it matches the host detail + Certificates page exactly.
function certBadge(h: ProxyHost, certs: Certificate[]): { label: string; detail: string } {
  if (!h.ssl) return { label: "No HTTPS", detail: "not encrypted" };
  const c = certForHost(h, certs);
  if (!c) return { label: "Self-signed", detail: "untrusted" };
  const trusted = c.method !== "selfsigned";
  const detail = c.daysRemaining != null
    ? (c.daysRemaining < 0 ? "expired" : `${c.daysRemaining} days left`)
    : trusted ? "-" : "untrusted";
  const label = c.status === "valid" ? (trusted ? "Valid" : "Self-signed")
    : c.status === "expiring" ? "Expiring"
    : c.status === "expired" ? "Expired"
    : c.status === "error" ? "Failed"
    : c.status === "pending" ? "Pending"
    : "Self-signed";
  return { label, detail: c.status === "error" ? "issuance failed" : detail };
}

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
  const [certs, setCerts] = useState<Certificate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [profiles, setProfiles] = useState<SecurityProfile[]>([]);
  useEffect(() => { api.certificates().then(setCerts).catch(() => {}); }, []);
  useEffect(() => { api.securityProfiles().then(setProfiles).catch(() => {}); }, []);

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

  const toggleSel = (id: string) => setSelected((s) => {
    const next = new Set(s);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const allSelected = hosts.length > 0 && selected.size === hosts.length;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(hosts.map((h) => h.id)));

  const runBulk = async (action: "enable" | "disable" | "maintenance-on" | "maintenance-off" | "delete") => {
    const ids = [...selected];
    if (!ids.length) return;
    if (action === "delete" && !confirm(`Delete ${ids.length} service${ids.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api.batchHosts(ids, action);
      setSelected(new Set());
      await reload();
    } finally {
      setBusy(false);
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
        {selected.size > 0 && (
          <div className="card card-pad" style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <b style={{ fontSize: 13 }}>{selected.size} selected</b>
            <div style={{ flex: 1 }} />
            <button className="btn btn-sm" disabled={busy} onClick={() => runBulk("enable")}>Enable</button>
            <button className="btn btn-sm" disabled={busy} onClick={() => runBulk("disable")}>Pause</button>
            <button className="btn btn-sm" disabled={busy} onClick={() => runBulk("maintenance-on")}>Maintenance on</button>
            <button className="btn btn-sm" disabled={busy} onClick={() => runBulk("maintenance-off")}>Maintenance off</button>
            <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => runBulk("delete")}>Delete</button>
            {profiles.length > 0 && (
              <select className="input" style={{ maxWidth: 200, height: 30, padding: "0 8px", fontSize: 12 }} disabled={busy} value=""
                onChange={async (e) => {
                  const pid = e.target.value; if (!pid) return;
                  const ids = [...selected]; setBusy(true);
                  try { await api.applySecurityProfile(pid, ids); setSelected(new Set()); await reload(); } finally { setBusy(false); }
                }}>
                <option value="">Apply profile…</option>
                {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setSelected(new Set())}>Clear</button>
          </div>
        )}
        <div className="card">
          <div className="col-head" style={{ gridTemplateColumns: "34px 1fr 1fr 1fr 1fr auto" }}>
            <div style={{ display: "flex", alignItems: "center" }}>
              <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all services" />
            </div>
            <div>Service</div>
            <div>Status</div>
            <div>Certificate</div>
            <div>Address</div>
            <div>Enabled</div>
          </div>
          {hosts.map((h) => {
            const cb = certBadge(h, certs);
            return (
              <div
                key={h.id}
                className={`host-row${h.enabled ? "" : " is-paused"}${selected.has(h.id) ? " is-selected" : ""}`}
                style={{ gridTemplateColumns: "34px 1fr 1fr 1fr 1fr auto" }}
                role="button"
                tabIndex={0}
                aria-label={`Open ${h.name}`}
                onClick={() => navigate({ name: "host", hostId: h.id })}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigate({ name: "host", hostId: h.id }); } }}
              >
                <div style={{ display: "flex", alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={selected.has(h.id)} onChange={() => toggleSel(h.id)} aria-label={`Select ${h.name}`} />
                </div>
                <div className="host-main">
                  <div className="host-icon"><ServiceIcon iconUrl={h.iconUrl} size={26} /></div>
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
                  <span className="strong">{cb.label}</span>
                  {cb.detail}
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
