import { useEffect, useState } from "react";
import { api, type Certificate } from "../api.ts";
import { Icon } from "../icons.tsx";

const statusPill: Record<Certificate["status"], string> = {
  valid: "g",
  expiring: "y",
  expired: "r",
  pending: "n",
  error: "r",
  none: "n",
};

export function Certificates() {
  const [certs, setCerts] = useState<Certificate[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = () => {
    api.certificates().then(setCerts).catch(() => {});
  };
  useEffect(load, []);

  const renew = async (domain: string) => {
    setBusy(domain);
    setError("");
    try {
      await api.renewCert(domain);
      await load();
    } catch (e) {
      setError(`${domain}: ${e instanceof Error ? e.message : "renewal failed"}`);
    } finally {
      setBusy(null);
    }
  };

  const valid = certs.filter((c) => c.status === "valid").length;
  const expiring = certs.filter((c) => c.status === "expiring" || c.status === "expired").length;
  const autoRenew = certs.filter((c) => c.autoRenew).length;

  return (
    <>
      <div className="topbar">
        <h1>Certificates</h1>
      </div>
      <div className="content">
        <div className="page-head">
          <div>
            <div className="page-title" style={{ fontSize: 18 }}>Certificates</div>
            <div className="sub">HTTPS certificates, renewed automatically before they expire.</div>
          </div>
        </div>

        {error && (
          <div className="test-result bad" style={{ marginTop: 0, marginBottom: 16 }}>
            <Icon.x />
            <div>{error}</div>
          </div>
        )}

        <div className="stats" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
          <div className="card stat"><div className="label">Valid</div><div className="value" style={{ color: "var(--green)" }}>{valid}</div></div>
          <div className="card stat"><div className="label">Expiring / expired</div><div className="value" style={{ color: expiring ? "var(--yellow)" : undefined }}>{expiring}</div></div>
          <div className="card stat"><div className="label">Auto-renew on</div><div className="value">{autoRenew} <small>/ {certs.length}</small></div></div>
        </div>

        <div className="card">
          <div className="ahead" style={{ gridTemplateColumns: "1.5fr 1fr 1fr 1.2fr auto" }}>
            <div>Domain</div>
            <div>Status</div>
            <div>Expires</div>
            <div>Issuer</div>
            <div />
          </div>
          {certs.map((c) => (
            <div key={c.domain} className="arow" style={{ gridTemplateColumns: "1.5fr 1fr 1fr 1.2fr auto" }}>
              <div className="cert-domain">
                {c.domain}
                {c.lastError && <div className="muted" style={{ fontSize: 11, color: "var(--red)" }}>{c.lastError}</div>}
              </div>
              <div><span className={`pill ${statusPill[c.status]}`}>{c.status}</span></div>
              <div>
                {c.daysRemaining !== null ? (
                  <span style={{ color: c.daysRemaining < 30 ? "var(--yellow)" : undefined }}>
                    {c.daysRemaining} days
                  </span>
                ) : "—"}
              </div>
              <div>
                {c.issuer || "—"}
                {c.wildcard && <span className="pill b" style={{ marginLeft: 4 }}>Wildcard</span>}
                {c.method === "selfsigned" && <span className="pill n" style={{ marginLeft: 4 }}>self-signed</span>}
              </div>
              <button className="btn btn-ghost btn-sm" disabled={busy === c.domain} onClick={() => renew(c.domain)}>
                {busy === c.domain ? <span className="spinner" /> : "Renew now"}
              </button>
            </div>
          ))}
          {certs.length === 0 && (
            <div className="placeholder">
              <p>No certificates yet. They're created automatically when you expose a service over HTTPS.</p>
            </div>
          )}
        </div>

        <div className="info-line" style={{ marginTop: 16 }}>
          <Icon.info />
          New HTTPS hosts get a self-signed certificate instantly. Add a Let's Encrypt email (and a DNS provider for wildcards) in Settings to upgrade them to trusted certificates.
        </div>
      </div>
    </>
  );
}
