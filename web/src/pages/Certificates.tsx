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
  const [issueFor, setIssueFor] = useState<string | null>(null);
  const [method, setMethod] = useState<"http-01" | "dns-01">("http-01");
  const [issuing, setIssuing] = useState(false);

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

  const issueTrusted = async () => {
    if (!issueFor) return;
    setIssuing(true);
    setError("");
    try {
      await api.issueCert(issueFor, method);
      setIssueFor(null);
      await load();
    } catch (e) {
      setError(`${issueFor}: ${e instanceof Error ? e.message : "couldn't get a certificate"}`);
      setIssueFor(null);
    } finally {
      setIssuing(false);
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
          <div className="ahead" style={{ gridTemplateColumns: "1.5fr 1fr 1fr 1.2fr 150px" }}>
            <div>Domain</div>
            <div style={{ textAlign: "center" }}>Status</div>
            <div>Expires</div>
            <div>Issuer</div>
            <div />
          </div>
          {certs.map((c) => (
            <div key={c.domain} className="arow" style={{ gridTemplateColumns: "1.5fr 1fr 1fr 1.2fr 150px" }}>
              <div className="cert-domain">
                {c.domain}
                {c.lastError && <div className="muted" style={{ fontSize: 11, color: "var(--red)" }}>{c.lastError}</div>}
              </div>
              <div style={{ textAlign: "center" }}><span className={`pill ${statusPill[c.status]}`}>{c.status}</span></div>
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
              {c.method === "selfsigned" ? (
                <button className="btn btn-primary btn-sm" style={{ justifySelf: "end" }} onClick={() => { setMethod("http-01"); setIssueFor(c.domain); }}>
                  Get trusted cert
                </button>
              ) : (
                <button className="btn btn-ghost btn-sm" style={{ justifySelf: "end" }} disabled={busy === c.domain} onClick={() => renew(c.domain)}>
                  {busy === c.domain ? <span className="spinner" /> : "Renew now"}
                </button>
              )}
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
          New HTTPS hosts get a self-signed certificate instantly (browsers show a warning). Use "Get trusted cert" to upgrade to a free Let's Encrypt certificate.
        </div>
      </div>

      {issueFor && (
        <div className="modal-backdrop" onClick={() => !issuing && setIssueFor(null)}>
          <div className="card card-pad modal-card" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 650, marginBottom: 4 }}>Get a trusted certificate</div>
            <p className="muted" style={{ fontSize: 13, marginBottom: 16 }}>
              A free Let's Encrypt certificate for <b>{issueFor}</b>. Pick how Let's Encrypt should verify you own the domain.
            </p>

            <label className={`radio-card${method === "http-01" ? " sel" : ""}`} onClick={() => setMethod("http-01")}>
              <div className="rc-top"><input type="radio" checked={method === "http-01"} readOnly /> HTTP validation</div>
              <div className="rc-desc">Simplest. Requires port <b>80</b> on this server to be reachable from the internet (forward TCP 80 → this NAS on your router), and public DNS for {issueFor} pointing at your home IP.</div>
            </label>

            <label className={`radio-card${method === "dns-01" ? " sel" : ""}`} onClick={() => setMethod("dns-01")}>
              <div className="rc-top"><input type="radio" checked={method === "dns-01"} readOnly /> DNS validation</div>
              <div className="rc-desc">No open ports needed — works even for LAN-only domains. Requires a DNS provider (GoDaddy / Cloudflare) connected in <b>Settings</b> so NginUX can add the verification record for you.</div>
            </label>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 18 }}>
              <button className="btn btn-ghost" onClick={() => setIssueFor(null)} disabled={issuing}>Cancel</button>
              <button className="btn btn-primary" onClick={issueTrusted} disabled={issuing}>
                {issuing ? <span className="spinner" /> : null}Request certificate
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
