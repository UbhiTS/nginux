import { useEffect, useState } from "react";
import { api, type CertDetails, type Certificate } from "../api.ts";
import { Icon } from "../icons.tsx";

const statusPill: Record<Certificate["status"], string> = {
  valid: "g", expiring: "y", expired: "r", pending: "n", error: "r", none: "n",
};
const methodLabel: Record<Certificate["method"], string> = {
  selfsigned: "Self-signed", "http-01": "Let's Encrypt", "dns-01": "Let's Encrypt",
};
const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "-";

/** Read-only certificate inspector - the same details popup as the Certificates
 *  store, reusable wherever a cert needs to be shown (e.g. the service page). */
export function CertDetailModal({ cert, onClose, onChanged }: {
  cert: Certificate;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [info, setInfo] = useState<CertDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRenew, setAutoRenew] = useState(cert.autoRenew);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.certDetails(cert.domain).then(setInfo).catch(() => setInfo(null)).finally(() => setLoading(false));
  }, [cert.domain]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggleAuto = async () => {
    const next = !autoRenew;
    setAutoRenew(next);
    try { await api.setCertAutoRenew(cert.domain, next); onChanged?.(); } catch { setAutoRenew(!next); }
  };
  const renew = async () => {
    setBusy(true);
    try { await api.renewCert(cert.domain); onChanged?.(); onClose(); } catch { /* surfaced elsewhere */ } finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card card-pad modal-card" role="dialog" aria-modal="true" aria-label={`Certificate for ${cert.domain}`} style={{ width: 540, maxWidth: "100%" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 2 }}>
          <Icon.cert className="acct-ic" />
          <div style={{ fontWeight: 650, fontSize: 15, wordBreak: "break-all" }}>{cert.domain}</div>
          <span className={`pill ${statusPill[cert.status]}`} style={{ marginLeft: "auto" }}>{cert.status}</span>
        </div>
        <p className="muted" style={{ fontSize: 12.5, marginBottom: 14 }}>
          {methodLabel[cert.method]}{cert.method !== "selfsigned" ? ` · ${cert.method === "http-01" ? "HTTP validation" : "DNS validation"}` : ""}
          {/staging/i.test(cert.issuer) && <span className="pill y" style={{ marginLeft: 8 }}>staging - not browser-trusted</span>}
        </p>

        {loading ? (
          <div className="placeholder"><span className="spinner" /> Reading certificate…</div>
        ) : info ? (
          <>
            <div className="kv"><span className="k">Issued to</span><span className="v">{info.subject}</span></div>
            <div className="kv"><span className="k">Issued by</span><span className="v">{info.issuer}{info.selfSigned ? " (self-signed)" : ""}</span></div>
            <div className="kv"><span className="k">Valid from</span><span className="v">{fmtDate(info.notBefore)}</span></div>
            <div className="kv"><span className="k">Valid until</span><span className="v">{fmtDate(info.notAfter)}{cert.daysRemaining !== null ? ` · ${cert.daysRemaining < 0 ? "expired" : `${cert.daysRemaining} days left`}` : ""}</span></div>
            <div className="kv"><span className="k">Covers</span><span className="v" style={{ wordBreak: "break-all" }}>{info.sans.length ? info.sans.join(", ") : cert.domain}</span></div>
            <div className="kv"><span className="k">Public key</span><span className="v">{info.publicKey}</span></div>
            {info.signatureAlgorithm && <div className="kv"><span className="k">Signature</span><span className="v">{info.signatureAlgorithm}</span></div>}
            <div className="kv"><span className="k">Serial</span><span className="v mono" style={{ wordBreak: "break-all", fontSize: 12 }}>{info.serialNumber}</span></div>
            <div className="kv" style={{ border: "none" }}><span className="k">SHA-256</span><span className="v mono" style={{ wordBreak: "break-all", fontSize: 11 }}>{info.fingerprintSha256}</span></div>
          </>
        ) : (
          <div className="muted" style={{ fontSize: 13 }}>No certificate file on disk yet for this domain.</div>
        )}

        <div className="switch-row" style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
          <div className="sw-text"><div className="t">Auto-renew</div><div className="d">Re-issue automatically before it expires.</div></div>
          <button className={`switch${autoRenew ? " on" : ""}`} onClick={toggleAuto} />
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 18, alignItems: "center" }}>
          <div style={{ flex: 1 }} />
          {info && <button className="btn" disabled={busy} onClick={renew}>{busy ? <span className="spinner" /> : null}Renew now</button>}
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
