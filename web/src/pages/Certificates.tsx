import { useEffect, useRef, useState } from "react";
import { api, type CertDetails, type Certificate, type CertImportResult } from "../api.ts";
import { Icon } from "../icons.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";

const statusPill: Record<Certificate["status"], string> = {
  valid: "g",
  expiring: "y",
  expired: "r",
  pending: "n",
  error: "r",
  none: "n",
};

const methodLabel: Record<Certificate["method"], string> = {
  selfsigned: "Self-signed",
  "http-01": "Let's Encrypt",
  "dns-01": "Let's Encrypt",
};

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "-";

const GRID = "1.4fr 0.8fr 0.9fr 1.1fr 80px 150px";

export function Certificates() {
  const [certs, setCerts] = useState<Certificate[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [issueFor, setIssueFor] = useState<string | null>(null);
  const [method, setMethod] = useState<"http-01" | "dns-01">("http-01");
  const [hasDnsProvider, setHasDnsProvider] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [detail, setDetail] = useState<Certificate | null>(null);
  const [info, setInfo] = useState<CertDetails | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [delFor, setDelFor] = useState<Certificate | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<CertImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement | null>(null);

  const load = () => {
    api.certificates().then(setCerts).catch(() => {});
  };
  useEffect(load, []);
  // DNS-01 is only usable with a provider connected, so don't offer it otherwise.
  useEffect(() => {
    api.settings().then((s) => setHasDnsProvider(s.dnsProvider !== "none")).catch(() => {});
  }, []);

  const onImportFiles = async (list: FileList | null) => {
    if (!list) return;
    const pems = [...list].filter((f) => f.name.toLowerCase().endsWith(".pem"));
    if (!pems.length) { setError("No .pem files selected. Pick a certificate (fullchain.pem) and its key (privkey.pem)."); return; }
    if (pems.length > 200) { setError("Too many files - point at a single domain folder or a certs/ root."); return; }
    setImporting(true);
    setError("");
    setImportResult(null);
    try {
      const files = await Promise.all(pems.map(async (f) => ({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, content: await f.text() })));
      const res = await api.importCerts(files);
      setImportResult(res);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
      if (folderRef.current) folderRef.current.value = "";
    }
  };

  const openDetails = (c: Certificate) => {
    setDetail(c);
    setInfo(null);
    setInfoLoading(true);
    api.certDetails(c.domain).then(setInfo).catch(() => setInfo(null)).finally(() => setInfoLoading(false));
  };

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
    const domain = issueFor;
    setIssuing(true);
    setError("");
    try {
      await api.issueCert(domain, method);
      setIssueFor(null);
      await load();
    } catch (e) {
      // A slow ACME attempt can outlast a proxy's read timeout, so the HTTP call
      // returns a 504 (or a non-JSON body) with no real message - but the server
      // records the actual reason on the cert. Pull the fresh list and surface that.
      let detail = e instanceof Error ? e.message : "";
      try {
        const fresh = await api.certificates();
        setCerts(fresh);
        const c = fresh.find((x) => x.domain === domain);
        if (c?.lastError) detail = c.lastError;
      } catch { /* keep whatever message we already have */ }
      setError(`${domain}: ${detail || "couldn't get a certificate - it may still be processing; check back in a minute."}`);
      setIssueFor(null);
    } finally {
      setIssuing(false);
    }
  };

  const doDelete = async () => {
    if (!delFor) return;
    setDeleting(true);
    setError("");
    try {
      await api.deleteCert(delFor.domain);
      if (detail?.domain === delFor.domain) setDetail(null);
      setDelFor(null);
      await load();
    } catch (e) {
      setError(`${delFor.domain}: ${e instanceof Error ? e.message : "delete failed"}`);
      setDelFor(null);
    } finally {
      setDeleting(false);
    }
  };

  const toggleAutoRenew = async (c: Certificate) => {
    const next = !c.autoRenew;
    setCerts((cs) => cs.map((x) => (x.domain === c.domain ? { ...x, autoRenew: next } : x)));
    setDetail((d) => (d && d.domain === c.domain ? { ...d, autoRenew: next } : d));
    try {
      await api.setCertAutoRenew(c.domain, next);
    } catch {
      load();
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
          <button className="btn" onClick={() => { setImportResult(null); setImportOpen(true); }}>Import…</button>
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
          <div className="ahead" style={{ gridTemplateColumns: GRID }}>
            <div>Domain</div>
            <div style={{ textAlign: "center" }}>Status</div>
            <div>Type</div>
            <div>Expires</div>
            <div style={{ textAlign: "center" }}>Auto-renew</div>
            <div />
          </div>
          {certs.map((c) => (
            <div key={c.domain} className="arow arow-click" style={{ gridTemplateColumns: GRID }} onClick={() => openDetails(c)}>
              <div className="cert-domain">
                {c.domain}
                {c.lastError && <div className="muted" style={{ fontSize: 11, color: "var(--red)" }}>{c.lastError}</div>}
              </div>
              <div style={{ textAlign: "center" }}><span className={`pill ${statusPill[c.status]}`}>{c.status}</span></div>
              <div className="muted">
                {methodLabel[c.method]}
                {c.method !== "selfsigned" && (/staging/i.test(c.issuer)
                  ? <span className="pill y" style={{ marginLeft: 6 }}>staging</span>
                  : /let'?s encrypt/i.test(c.issuer)
                    ? <span className="pill g" style={{ marginLeft: 6 }}>production</span>
                    : null)}
                {c.wildcard && <span className="pill b" style={{ marginLeft: 6 }}>wildcard</span>}
              </div>
              <div>
                <div>{fmtDate(c.notAfter)}</div>
                {c.daysRemaining !== null && (
                  <div className="muted" style={{ fontSize: 11, color: c.daysRemaining < 30 ? "var(--yellow)" : undefined }}>
                    {c.daysRemaining < 0 ? "expired" : `${c.daysRemaining} days left`}
                  </div>
                )}
              </div>
              <div style={{ textAlign: "center", color: c.autoRenew ? "var(--green)" : "var(--text-faint)" }}>
                {c.autoRenew ? "✓" : "-"}
              </div>
              <div className="cert-actions" onClick={(e) => e.stopPropagation()}>
                {c.method === "selfsigned" ? (
                  <button className="btn btn-primary btn-sm" onClick={() => { setMethod("http-01"); setIssueFor(c.domain); }}>
                    Get trusted cert
                  </button>
                ) : (
                  <button className="btn btn-ghost btn-sm" disabled={busy === c.domain} onClick={() => renew(c.domain)}>
                    {busy === c.domain ? <span className="spinner" /> : "Renew now"}
                  </button>
                )}
                <button className="icon-btn danger" title="Delete certificate" onClick={() => setDelFor(c)}>
                  <Icon.trash />
                </button>
              </div>
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
          Click a row to see the full certificate. New HTTPS hosts get a self-signed certificate instantly (browsers show a warning) - use "Get trusted cert" to upgrade to a free Let's Encrypt certificate.
        </div>
      </div>

      {detail && (
        <div className="modal-backdrop" onClick={() => setDetail(null)}>
          <div className="card card-pad modal-card" style={{ width: 540, maxWidth: "100%" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 2 }}>
              <Icon.cert className="acct-ic" />
              <div style={{ fontWeight: 650, fontSize: 15, wordBreak: "break-all" }}>{detail.domain}</div>
              <span className={`pill ${statusPill[detail.status]}`} style={{ marginLeft: "auto" }}>{detail.status}</span>
            </div>
            <p className="muted" style={{ fontSize: 12.5, marginBottom: 14 }}>
              {methodLabel[detail.method]}{detail.method !== "selfsigned" ? ` · ${detail.method === "http-01" ? "HTTP validation" : "DNS validation"}` : ""}
              {/staging/i.test(detail.issuer) && <span className="pill y" style={{ marginLeft: 8 }}>staging - not browser-trusted</span>}
            </p>

            {infoLoading ? (
              <div className="placeholder"><span className="spinner" /> Reading certificate…</div>
            ) : info ? (
              <>
                <div className="kv"><span className="k">Issued to</span><span className="v">{info.subject}</span></div>
                <div className="kv"><span className="k">Issued by</span><span className="v">{info.issuer}{info.selfSigned ? " (self-signed)" : ""}</span></div>
                <div className="kv"><span className="k">Valid from</span><span className="v">{fmtDate(info.notBefore)}</span></div>
                <div className="kv"><span className="k">Valid until</span><span className="v">{fmtDate(info.notAfter)}{detail.daysRemaining !== null ? ` · ${detail.daysRemaining < 0 ? "expired" : `${detail.daysRemaining} days left`}` : ""}</span></div>
                <div className="kv"><span className="k">Covers</span><span className="v" style={{ wordBreak: "break-all" }}>{info.sans.length ? info.sans.join(", ") : detail.domain}</span></div>
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
              <button className={`switch${detail.autoRenew ? " on" : ""}`} onClick={() => toggleAutoRenew(detail)} />
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 18, alignItems: "center" }}>
              <button className="btn btn-danger btn-sm" onClick={() => setDelFor(detail)}><Icon.trash /> Delete</button>
              <div style={{ flex: 1 }} />
              {detail.method === "selfsigned" ? (
                <button className="btn btn-primary" onClick={() => { setMethod("http-01"); setIssueFor(detail.domain); setDetail(null); }}>Get trusted cert</button>
              ) : (
                <button className="btn" disabled={busy === detail.domain} onClick={() => renew(detail.domain)}>{busy === detail.domain ? <span className="spinner" /> : "Renew now"}</button>
              )}
              <button className="btn btn-ghost" onClick={() => setDetail(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {issueFor && (
        <div className="modal-backdrop" onClick={() => !issuing && setIssueFor(null)}>
          <div className="card card-pad modal-card" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 650, marginBottom: 4 }}>Get a trusted certificate</div>
            <p className="muted" style={{ fontSize: 13, marginBottom: 16 }}>
              A free Let's Encrypt certificate for <b>{issueFor}</b>. Pick how Let's Encrypt should verify you own the domain.
            </p>

            <label className={`radio-card${method === "http-01" ? " sel" : ""}`} onClick={() => setMethod("http-01")}>
              <div className="rc-top"><input type="radio" checked={method === "http-01"} readOnly /> HTTP validation</div>
              <div className="rc-desc">Simplest. Requires port <b>80</b> on this server to be reachable from the internet (forward TCP 80 → the NginUX host on your router), and public DNS for {issueFor} pointing at your home IP.</div>
            </label>

            {hasDnsProvider ? (
              <label className={`radio-card${method === "dns-01" ? " sel" : ""}`} onClick={() => setMethod("dns-01")}>
                <div className="rc-top"><input type="radio" checked={method === "dns-01"} readOnly /> DNS validation</div>
                <div className="rc-desc">No open ports needed - works even for LAN-only domains. NginUX adds the verification record through your connected DNS provider.</div>
              </label>
            ) : (
              <div className="info-line" style={{ marginTop: 10 }}>
                <Icon.info />
                DNS validation (no open ports, works for LAN-only domains) needs a DNS provider connected in <b>Settings</b> first.
              </div>
            )}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 18 }}>
              <button className="btn btn-ghost" onClick={() => setIssueFor(null)} disabled={issuing}>Cancel</button>
              <button className="btn btn-primary" onClick={issueTrusted} disabled={issuing}>
                {issuing ? <span className="spinner" /> : null}Request certificate
              </button>
            </div>
          </div>
        </div>
      )}

      {delFor && (
        <ConfirmDialog
          danger
          title={`Delete certificate for ${delFor.domain}?`}
          message={<>This removes the stored certificate and key. Any service on <b>{delFor.domain}</b> falls back to the temporary self-signed certificate until you issue a new one.</>}
          confirmLabel="Delete certificate"
          busy={deleting}
          onConfirm={doDelete}
          onCancel={() => setDelFor(null)}
        />
      )}

      {importOpen && (
        <div className="modal-backdrop" onClick={() => !importing && setImportOpen(false)}>
          <div className="card card-pad modal-card" style={{ width: 500, maxWidth: "100%" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 650, marginBottom: 4 }}>Import certificates</div>
            <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
              Bring in existing certs (e.g. from Nginx Proxy Manager or certbot). NginUX reads the domain from each
              certificate and matches its key automatically - pick a single domain's folder, or a folder of many.
            </p>

            <input ref={fileRef} type="file" hidden multiple accept=".pem" onChange={(e) => onImportFiles(e.target.files)} />
            <input ref={(el) => { folderRef.current = el; if (el) el.setAttribute("webkitdirectory", ""); }} type="file" hidden multiple onChange={(e) => onImportFiles(e.target.files)} />

            {importing ? (
              <div className="placeholder"><span className="spinner" /> Importing…</div>
            ) : importResult ? (
              <div>
                {importResult.imported.length > 0 && (
                  <div className="test-result ok" style={{ display: "block", marginBottom: importResult.skipped.length ? 12 : 0 }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>Imported {importResult.imported.length} certificate{importResult.imported.length > 1 ? "s" : ""}:</div>
                    {importResult.imported.map((i) => <div key={i.domain} style={{ fontSize: 12.5 }}>✓ {i.domain}{i.staging ? " (staging)" : ""}</div>)}
                  </div>
                )}
                {importResult.skipped.length > 0 && (
                  <div className="test-result bad" style={{ display: "block" }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>Skipped {importResult.skipped.length}:</div>
                    {importResult.skipped.map((s, i) => <div key={i} style={{ fontSize: 12.5 }}>✕ {s.name} - {s.reason}</div>)}
                  </div>
                )}
                {importResult.imported.length === 0 && importResult.skipped.length === 0 && (
                  <div className="muted" style={{ fontSize: 13 }}>Nothing to import.</div>
                )}
              </div>
            ) : (
              <div style={{ display: "flex", gap: 10 }}>
                <button className="btn" onClick={() => fileRef.current?.click()}>Choose files…</button>
                <button className="btn" onClick={() => folderRef.current?.click()}>Choose folder…</button>
              </div>
            )}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 18 }}>
              {importResult && <button className="btn btn-ghost" onClick={() => setImportResult(null)} disabled={importing}>Import more</button>}
              <button className="btn btn-primary" onClick={() => setImportOpen(false)} disabled={importing}>Done</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
