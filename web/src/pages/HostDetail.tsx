import { useEffect, useState } from "react";
import type { Route } from "../App.tsx";
import { api, type Certificate, type Uptime } from "../api.ts";
import type { Preset, ProxyHost } from "../types.ts";
import { Icon } from "../icons.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { CertDetailModal } from "../components/CertDetailModal.tsx";

const banner = {
  online: { cls: "", icon: <Icon.check />, title: "Working. Everything looks healthy." },
  degraded: { cls: "warn", icon: <Icon.alert />, title: "Online, but needs attention." },
  down: { cls: "bad", icon: <Icon.x />, title: "NginUX can't reach this service right now." },
  unknown: { cls: "", icon: <Icon.info />, title: "Status unknown." },
};

export function HostDetail({
  hostId,
  navigate,
  reload,
}: {
  hostId: string;
  navigate: (r: Route) => void;
  reload: () => Promise<void>;
}) {
  const [host, setHost] = useState<ProxyHost | null>(null);
  const [config, setConfig] = useState<string>("");
  const [advOpen, setAdvOpen] = useState(false);
  const [uptime, setUptime] = useState<Uptime | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ProxyHost | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [saveErr, setSaveErr] = useState("");
  const [certs, setCerts] = useState<Certificate[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetOpen, setPresetOpen] = useState(false);
  const [certDetail, setCertDetail] = useState(false);
  const [hasDnsProvider, setHasDnsProvider] = useState(false);

  const refetch = () => {
    api.getHost(hostId).then(setHost).catch(() => setHost(null));
    api.hostConfig(hostId).then(setConfig).catch(() => setConfig(""));
    api.uptime(hostId).then(setUptime).catch(() => setUptime(null));
    api.certificates().then(setCerts).catch(() => {});
  };
  // Switching services must reset transient view state — otherwise clicking a
  // different service in the sidebar while editing would leave the edit form
  // (and advanced panels) open on top of the new service.
  useEffect(() => {
    setEditing(false);
    setDraft(null);
    setSaveErr("");
    setAdvOpen(false);
    setPresetOpen(false);
    setConfirmDel(false);
    refetch();
  }, [hostId]);
  useEffect(() => { api.presets().then(setPresets).catch(() => {}); }, []);
  useEffect(() => { api.settings().then((s) => setHasDnsProvider(s.dnsProvider !== "none")).catch(() => {}); }, []);

  const startEdit = () => { setDraft(host); setSaveErr(""); setEditing(true); };
  const saveEdit = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveErr("");
    try {
      await api.updateHost(hostId, draft);
      await reload();
      refetch();
      setEditing(false);
    } catch (e) {
      // The change was rejected and reverted server-side; keep the form open and
      // show why so they can fix it.
      setSaveErr(e instanceof Error ? e.message : "Couldn't save — the change was reverted.");
    } finally {
      setSaving(false);
    }
  };

  if (!host) {
    return (
      <>
        <div className="topbar">
          <h1>Service</h1>
        </div>
        <div className="content">
          <div className="placeholder">
            <span className="spinner" /> Loading…
          </div>
        </div>
      </>
    );
  }

  const b = banner[host.health];
  // The certificate this host actually serves (its chosen certDomain, or its
  // own), from the cert store — but only when HTTPS is on. With HTTPS off the
  // service is plain HTTP, so any cert still sitting in the store isn't in use.
  const cert = host.ssl ? (certs.find((c) => c.domain === (host.certDomain || host.domain)) ?? null) : null;
  const certDays = cert?.daysRemaining ?? null;
  const certStatusCls = cert ? (cert.status === "valid" ? "g" : cert.status === "expiring" || cert.status === "expired" || cert.status === "error" ? "r" : "n") : "n";

  const remove = async () => {
    setDeleting(true);
    try {
      await api.deleteHost(host.id);
      await reload();
      navigate({ name: "services" });
    } finally {
      setDeleting(false);
    }
  };

  // Pause/serve this service. Disabling drops its nginx server block so the
  // public site stops responding; the config (and this page) stays intact.
  const toggleEnabled = async () => {
    setToggling(true);
    try {
      await api.updateHost(host.id, { enabled: !host.enabled });
      await reload();
      refetch();
    } finally {
      setToggling(false);
    }
  };

  return (
    <>
      <div className="topbar">
        <button className="btn btn-ghost btn-sm" aria-label="Back to dashboard" onClick={() => navigate({ name: "dashboard" })}>
          <Icon.arrowLeft />
        </button>
        <h1>
          {host.emoji} {host.name}
        </h1>
        {host.enabled ? (
          <span className={`pill ${host.health === "down" ? "r" : host.health === "degraded" ? "y" : "g"}`}>
            <span className={`dot ${host.health === "down" ? "r" : host.health === "degraded" ? "y" : "g"}`} />
            {host.health === "down" ? "Can't reach" : "Online"}
          </span>
        ) : (
          <span className="pill n">
            <span className="dot n" />
            Paused
          </span>
        )}
        <div style={{ flex: 1 }} />
        {host.enabled && (
          <a className="btn btn-ghost" href={`https://${host.domain}`} target="_blank" rel="noreferrer">
            <Icon.external />
            Visit
          </a>
        )}
        <button className="btn" onClick={toggleEnabled} disabled={toggling}>
          {toggling ? <span className="spinner" /> : null}
          {host.enabled ? "Disable" : "Enable"}
        </button>
        <button className="btn" onClick={editing ? () => setEditing(false) : startEdit}>
          {editing ? "Cancel" : "Edit"}
        </button>
        <button className="btn btn-danger" onClick={() => setConfirmDel(true)}>
          Delete
        </button>
      </div>

      {confirmDel && (
        <ConfirmDialog
          danger
          title={`Remove ${host.emoji} ${host.name}?`}
          message={<>This takes <b>{host.domain}</b> offline and deletes its proxy configuration. You can expose it again later.</>}
          confirmLabel="Remove service"
          busy={deleting}
          onConfirm={remove}
          onCancel={() => setConfirmDel(false)}
        />
      )}

      {certDetail && cert && (
        <CertDetailModal cert={cert} onClose={() => setCertDetail(false)} onChanged={refetch} />
      )}

      <div className="content">
        <div className={`summary-banner ${host.enabled ? b.cls : "warn"}`}>
          <div className="big-check">{host.enabled ? b.icon : <Icon.alert />}</div>
          <div>
            <div className="st">{host.enabled ? b.title : "Paused — this service isn't being served."}</div>
            <div className="sd">
              {host.enabled ? (
                <>
                  {!host.ssl ? "Served over HTTP — not encrypted" : certDays !== null ? `Certificate valid for ${certDays} days` : "No certificate yet"} ·{" "}
                  {host.require2fa
                    ? "Protected by login + 2FA"
                    : host.requireLogin
                      ? "Protected by login"
                      : "No NginUX login required"}
                </>
              ) : (
                <>Its nginx config is removed while paused. Click <b>Enable</b> to serve it again.</>
              )}
            </div>
          </div>
        </div>

        {editing && draft ? (
          <EditForm draft={draft} setDraft={setDraft} onSave={saveEdit} onCancel={() => setEditing(false)} saving={saving} error={saveErr} certs={certs} hasDnsProvider={hasDnsProvider} onCertsChanged={() => api.certificates().then(setCerts).catch(() => {})} />
        ) : (
        <div className="detail-grid">
          <div>
            <div className="card" style={{ marginBottom: 18 }}>
              <div className="card-head">
                Routing
                <button
                  className={`pill n preset-chip${presetOpen ? " open" : ""}`}
                  title="What this preset applies"
                  onClick={() => setPresetOpen((o) => !o)}
                >
                  {host.preset} preset
                  <Icon.chevron className="chev" />
                </button>
              </div>
              {presetOpen && (
                <div className="adv-body">
                  {(() => {
                    const pd = presets.find((p) => p.id === host.preset) ?? null;
                    return (
                      <>
                        <div className="kv"><span className="k">What this preset sets up</span><span className="v" style={{ textAlign: "right", maxWidth: 360 }}>{pd?.notes ?? "Custom configuration."}</span></div>
                        <div style={{ marginTop: 10 }}>
                          <div className="muted" style={{ fontSize: 12, marginBottom: 5 }}>Extra nginx directives applied to this host:</div>
                          {pd && pd.extraDirectives.length
                            ? <div className="code">{pd.extraDirectives.join("\n")}</div>
                            : <div className="muted" style={{ fontSize: 12.5 }}>None — only the WebSockets / HTTP/2 settings shown below.</div>}
                        </div>
                      </>
                    );
                  })()}
                </div>
              )}
              <div className="card-pad">
                <div className="kv">
                  <span className="k">Public address</span>
                  <span className="v mono">
                    {host.ssl ? "https" : "http"}://{host.domain}
                  </span>
                </div>
                <div className="kv">
                  <span className="k">Your internal service</span>
                  <span className="v mono">
                    {host.forwardHost}:{host.forwardPort}
                  </span>
                </div>
                <div className="kv">
                  <span className="k">WebSockets</span>
                  <span className="v" style={{ color: host.websockets ? "var(--green)" : undefined }}>
                    {host.websockets ? "On" : "Off"}
                  </span>
                </div>
                <div className="kv">
                  <span className="k">HTTP/2</span>
                  <span className="v" style={{ color: host.http2 ? "var(--green)" : undefined }}>
                    {host.http2 ? "On" : "Off"}
                  </span>
                </div>
              </div>
              <div className={`adv-toggle${advOpen ? " open" : ""}`} onClick={() => setAdvOpen((o) => !o)}>
                <Icon.chevron className="chev" />
                Advanced — view generated Nginx config
              </div>
              {advOpen && (
                <div className="adv-body">
                  <div className="code">{config}</div>
                  <div className="info-line" style={{ marginTop: 12 }}>
                    <Icon.info />
                    This is generated for you — edit only if you know what you're doing.
                  </div>
                </div>
              )}
            </div>

            {uptime && (
              <div className="card">
                <div className="card-head">
                  Uptime · last checks
                  <span className={`pill ${uptime.uptimePct >= 99 ? "g" : uptime.uptimePct >= 90 ? "y" : "r"}`}>
                    {uptime.uptimePct}%
                  </span>
                </div>
                <div className="card-pad">
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 44 }}>
                    {uptime.bars.map((b, i) => (
                      <span key={i} title={b === 1 ? "up" : b === 0 ? "down" : "partial"} style={{ flex: 1, height: `${20 + b * 80}%`, background: b === 1 ? "var(--green)" : b === 0 ? "var(--red)" : "var(--yellow)", borderRadius: 2, opacity: 0.85 }} />
                    ))}
                    {uptime.bars.length === 0 && <span className="muted" style={{ fontSize: 12 }}>Collecting checks…</span>}
                  </div>
                  <div className="kv" style={{ marginTop: 10 }}><span className="k">Avg response</span><span className="v">{uptime.avgMs} ms</span></div>
                  <div className="kv"><span className="k">Last check</span><span className="v muted">{uptime.lastCheck ? new Date(uptime.lastCheck).toLocaleTimeString() : "—"}</span></div>
                  <div className="kv" style={{ border: "none" }}><span className="k">Downtime incidents</span><span className="v">{uptime.incidents.length}</span></div>
                  {uptime.incidents.filter((i) => !i.endedAt).length > 0 && (
                    <div className="info-line" style={{ marginTop: 8, color: "var(--red)" }}><Icon.alert />Currently down since {new Date(uptime.incidents.find((i) => !i.endedAt)!.startedAt).toLocaleString()}</div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div>
            <div className="card" style={{ marginBottom: 18 }}>
              <div className="card-head">
                Certificate
                {cert && (
                  <button className="pill n preset-chip" title="View certificate details" onClick={() => setCertDetail(true)}>
                    View details <Icon.chevron className="chev" />
                  </button>
                )}
              </div>
              <div className="card-pad">
                {!host.ssl ? (
                  <div className="kv" style={{ border: "none" }}>
                    <span className="k">Status</span>
                    <span className="v muted">Not in use — served over HTTP</span>
                  </div>
                ) : (
                  <>
                    <div className="kv">
                      <span className="k">Status</span>
                      <span className={`pill ${certStatusCls}`}>{cert ? cert.status : "none"}</span>
                    </div>
                    <div className="kv">
                      <span className="k">Expires in</span>
                      <span className="v">{certDays !== null ? `${certDays} days` : "—"}</span>
                    </div>
                    <div className="kv">
                      <span className="k">Issuer</span>
                      <span className="v">{cert ? cert.issuer || "—" : "—"}</span>
                    </div>
                    {host.certDomain && (
                      <div className="kv">
                        <span className="k">Using cert</span>
                        <span className="v mono">{host.certDomain}</span>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
            <div className="card">
              <div className="card-head">Protection</div>
              <div className="card-pad">
                <Check ok={host.ssl} label="HTTPS encryption" />
                <Check ok={host.requireLogin} label="Login required" />
                <Check ok={host.require2fa} label="2FA enforced" />
                <Check ok={host.countryLock} label="Country lock (GeoIP)" />
                <Check ok={host.securityHeaders} label="Security headers" />
                <Check ok={host.rateLimit} label="Rate limiting" />
                <Check ok={host.blockExploits} label="Exploit/bot blocking" />
                {host.maintenanceMode && <div className="check-line warn"><Icon.alert />Maintenance mode ON</div>}
                <Check ok={host.mtls} label="Client cert (mTLS)" />
                {host.rateLimitKbps > 0 && <div className="check-line"><Icon.bolt />Speed limit: {host.rateLimitKbps} KB/s per connection</div>}
                {host.maxConns > 0 && <div className="check-line"><Icon.bolt />Max {host.maxConns} connections per IP</div>}
              </div>
            </div>
            {host.mtls && <ClientCerts hostId={host.id} />}
          </div>
        </div>
        )}
      </div>
    </>
  );
}

function ClientCerts({ hostId }: { hostId: string }) {
  const [certs, setCerts] = useState<import("../api.ts").ClientCert[]>([]);
  const [name, setName] = useState("");
  const [issued, setIssued] = useState<{ cert: string; key: string } | null>(null);

  const load = () => { api.clientCerts(hostId).then(setCerts).catch(() => {}); };
  useEffect(load, [hostId]);

  const issue = async () => {
    if (!name.trim()) return;
    const r = await api.issueClientCert(hostId, name.trim());
    setIssued({ cert: r.cert, key: r.key });
    setName("");
    load();
  };
  const download = (text: string, fname: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/x-pem-file" }));
    a.download = fname;
    a.click();
  };

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <div className="card-head">Client certificates</div>
      <div className="card-pad">
        <div style={{ display: "flex", gap: 8 }}>
          <input className="input" placeholder="cert name (e.g. laptop)" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn btn-primary btn-sm" onClick={issue}>Issue</button>
        </div>
        {issued && (
          <div className="test-result ok" style={{ display: "block", marginTop: 12 }}>
            <div style={{ marginBottom: 6 }}>Issued — download now (key shown once):</div>
            <button className="btn btn-sm" style={{ marginRight: 8 }} onClick={() => download(issued.cert, "client.crt")}>client.crt</button>
            <button className="btn btn-sm" onClick={() => download(issued.key, "client.key")}>client.key</button>
          </div>
        )}
        <div style={{ marginTop: 12 }}>
          {certs.map((c) => (
            <div key={c.id} className="kv" style={{ opacity: c.revokedAt ? 0.55 : 1 }}>
              <span className="k">{c.name} <span className="muted mono" style={{ fontSize: 10 }}>{c.fingerprint.slice(0, 17)}…</span></span>
              <span className="v">
                {c.revokedAt
                  ? <span className="pill r">revoked</span>
                  : <button className="btn btn-ghost btn-sm" onClick={async () => { await api.revokeClientCert(hostId, c.id); load(); }}>Revoke</button>}
              </span>
            </div>
          ))}
          {certs.length === 0 && <div className="muted" style={{ fontSize: 12.5 }}>No client certs issued yet.</div>}
        </div>
      </div>
    </div>
  );
}

// A cert covers a domain if it names it exactly, lists it in SANs, or is a
// single-level wildcard matching it (e.g. *.example.com → app.example.com).
function certCovers(c: Certificate, domain: string): boolean {
  const names = [c.domain, ...(c.sans ?? [])];
  return names.some(
    (n) =>
      n === domain ||
      (n.startsWith("*.") &&
        domain.endsWith(n.slice(1)) &&
        domain.split(".").length === n.split(".").length),
  );
}

function EditForm({ draft, setDraft, onSave, onCancel, saving, error, certs, hasDnsProvider, onCertsChanged }: {
  draft: ProxyHost;
  setDraft: (d: ProxyHost) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error?: string;
  certs: Certificate[];
  hasDnsProvider: boolean;
  onCertsChanged: () => void;
}) {
  const set = (patch: Partial<ProxyHost>) => setDraft({ ...draft, ...patch });

  // Certificate applies to L7 hosts (HTTP / gRPC). A single dropdown drives the
  // whole thing: no cert (plain HTTP), an existing covering cert, create a new
  // one, or import — so there's one control, not three.
  const certApplies = draft.protocol === "http" || draft.protocol === "grpc";
  // The cert for this service's own domain (if one exists), plus any OTHER cert
  // that actually covers this domain (wildcard / SAN). A cert that doesn't cover
  // the domain would serve a mismatched cert (browser "insecure" warning), so
  // those are deliberately not offered.
  const ownCert = certs.find((c) => c.domain === draft.domain) ?? null;
  const otherCerts = certs.filter((c) => c.domain !== draft.domain && certCovers(c, draft.domain));
  const [certBusy, setCertBusy] = useState("");
  const [certMsg, setCertMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [impCert, setImpCert] = useState("");
  const [impKey, setImpKey] = useState("");
  type CertMethod = "dns-01" | "http-01" | "selfsigned";
  // Unified dropdown value: "none" | "use:self" | "use:<domain>" | "new:<method>" | "import".
  const [certChoice, setCertChoice] = useState<string>(
    !draft.ssl ? "none" : draft.certDomain ? `use:${draft.certDomain}` : "use:self",
  );

  const onCertChoice = (value: string) => {
    setCertChoice(value);
    setCertMsg(null);
    if (value === "none") set({ ssl: false });
    else if (value === "use:self") set({ ssl: true, certDomain: "" });
    else if (value.startsWith("use:")) set({ ssl: true, certDomain: value.slice(4) });
    else set({ ssl: true }); // new:* / import — HTTPS on; the action runs below
  };

  const issue = async (method: CertMethod) => {
    setCertBusy("create");
    setCertMsg(null);
    try {
      await api.issueCert(draft.domain, method);
      set({ ssl: true, certDomain: "" }); // serve the freshly-issued per-domain cert
      setCertChoice("use:self");
      setCertMsg({ ok: true, text: method === "selfsigned" ? "Self-signed certificate created." : `Let's Encrypt certificate issued for ${draft.domain}.` });
      onCertsChanged();
    } catch (e) {
      setCertMsg({ ok: false, text: e instanceof Error ? e.message : "Couldn't create the certificate." });
    } finally {
      setCertBusy("");
    }
  };

  const doImport = async () => {
    if (!impCert.trim() || !impKey.trim()) return;
    setCertBusy("import");
    setCertMsg(null);
    try {
      const r = await api.importCerts([{ path: "cert.pem", content: impCert }, { path: "key.pem", content: impKey }]);
      const dom = r.imported?.[0]?.domain;
      if (dom) {
        // Auto-select the imported cert only if it actually covers this domain.
        const covers = dom === draft.domain
          || (dom.startsWith("*.") && draft.domain.endsWith(dom.slice(1)) && draft.domain.split(".").length === dom.split(".").length);
        if (covers) {
          const cd = dom === draft.domain ? "" : dom;
          set({ ssl: true, certDomain: cd });
          setCertChoice(cd ? `use:${cd}` : "use:self");
        }
        setCertMsg({ ok: true, text: covers ? `Imported and selected ${dom}.` : `Imported ${dom} — it doesn't cover ${draft.domain}, so it wasn't selected.` });
        setImpCert(""); setImpKey("");
        onCertsChanged();
      } else {
        setCertMsg({ ok: false, text: r.skipped?.[0]?.reason ? `Couldn't import — ${r.skipped[0].reason}.` : "Couldn't import that certificate." });
      }
    } catch (e) {
      setCertMsg({ ok: false, text: e instanceof Error ? e.message : "Import failed." });
    } finally {
      setCertBusy("");
    }
  };

  const certHint =
    certChoice === "none" ? "Served over plain HTTP — no encryption. Anyone on the network path can read the traffic."
      : certChoice === "new:dns-01" ? `A free, trusted Let's Encrypt certificate over DNS — no open ports needed${hasDnsProvider ? "" : " (a DNS provider must be connected in Settings — none yet)"}.`
        : certChoice === "new:http-01" ? `A free, trusted Let's Encrypt certificate over HTTP — needs port 80 reachable from the internet and public DNS for ${draft.domain}.`
          : certChoice === "new:selfsigned" ? "An instant self-signed certificate — works immediately, but browsers show a warning. Fine for LAN-only or testing."
            : certChoice === "import" ? "Paste the full-chain certificate and its private key for this domain."
              : certChoice === "use:self" && !ownCert ? `No certificate for ${draft.domain} yet — it'll use the temporary self-signed cert until you create one.`
                : "Serves the selected certificate over HTTPS (and redirects HTTP).";
  const Toggle = ({ k, label, desc }: { k: keyof ProxyHost; label: string; desc: string }) => (
    <div className="switch-row">
      <div className="sw-text"><div className="t">{label}</div><div className="d">{desc}</div></div>
      <button className={`switch${draft[k] ? " on" : ""}`} onClick={() => set({ [k]: !draft[k] } as Partial<ProxyHost>)} />
    </div>
  );
  return (
    <div className="card wcard" style={{ maxWidth: 720 }}>
      <h2 style={{ fontSize: 18, marginBottom: 18 }}>Edit {draft.name}</h2>
      <div className="field"><label>Name</label><input className="input" value={draft.name} onChange={(e) => set({ name: e.target.value })} /></div>
      <div className="field"><label>Public domain / label</label><input className="input" value={draft.domain} onChange={(e) => set({ domain: e.target.value })} /></div>
      <div className="field">
        <label>Protocol</label>
        <div className="input-group">
          <select className="input" value={draft.protocol} onChange={(e) => set({ protocol: e.target.value as ProxyHost["protocol"] })}>
            <option value="http">HTTP / HTTPS (L7)</option>
            <option value="grpc">gRPC</option>
            <option value="tcp">TCP stream (L4)</option>
            <option value="udp">UDP stream (L4)</option>
            <option value="sni">SNI / TLS passthrough</option>
          </select>
          {(draft.protocol === "tcp" || draft.protocol === "udp" || draft.protocol === "sni") && (
            <input className="input" style={{ maxWidth: 160 }} type="number" placeholder={draft.protocol === "sni" ? "443" : "listen port"} value={draft.listenPort || ""} onChange={(e) => set({ listenPort: Number(e.target.value) })} />
          )}
        </div>
        {(draft.protocol === "tcp" || draft.protocol === "udp") && <div className="hint">nginx listens on this port and forwards to the internal target.</div>}
        {draft.protocol === "sni" && <div className="hint">Routes TLS by SNI ({draft.domain}) without terminating — forwards encrypted to the target.</div>}
      </div>
      <div className="field">
        <label>Internal service</label>
        <div className="input-group">
          <select className="input" style={{ maxWidth: 110 }} value={draft.forwardScheme} onChange={(e) => set({ forwardScheme: e.target.value as ProxyHost["forwardScheme"] })}>
            <option value="http">http</option><option value="https">https</option>
          </select>
          <input className="input" value={draft.forwardHost} onChange={(e) => set({ forwardHost: e.target.value })} />
          <input className="input" style={{ maxWidth: 110 }} type="number" value={draft.forwardPort} onChange={(e) => set({ forwardPort: Number(e.target.value) })} />
        </div>
      </div>

      <div className="section-title" style={{ marginTop: 8 }}>Behaviour</div>
      <Toggle k="websockets" label="WebSockets" desc="Support upgrade connections." />
      <Toggle k="maintenanceMode" label="Maintenance mode" desc="Serve a 'be right back' page instead of proxying." />

      {certApplies && (
        <>
          <div className="section-title" style={{ marginTop: 8 }}>Certificate</div>
          <div className="field">
            <label>How {draft.domain} is served</label>
            <select className="input" value={certChoice} onChange={(e) => onCertChoice(e.target.value)} disabled={!!certBusy}>
              <option value="none">No certificate — serve over HTTP only (no HTTPS)</option>
              <optgroup label="Use a certificate (HTTPS)">
                <option value="use:self">
                  {ownCert
                    ? `${draft.domain} · ${ownCert.issuer || ownCert.method}${ownCert.daysRemaining != null ? ` · ${ownCert.daysRemaining}d left` : ""}`
                    : `${draft.domain} — this service's domain`}
                </option>
                {otherCerts.map((c) => (
                  <option key={c.domain} value={`use:${c.domain}`}>
                    {c.domain}{c.wildcard ? " · wildcard" : ""} · {c.issuer || c.method}{c.daysRemaining != null ? ` · ${c.daysRemaining}d left` : ""}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Create a new certificate">
                {hasDnsProvider && <option value="new:dns-01">Let's Encrypt (DNS) — trusted, no open ports needed</option>}
                <option value="new:http-01">Let's Encrypt (HTTP) — trusted, needs port 80 + public DNS</option>
                <option value="new:selfsigned">Self-signed — instant, not browser-trusted</option>
              </optgroup>
              <option value="import">Import your own certificate…</option>
            </select>
            <div className="hint">{certHint}</div>
          </div>

          {certChoice.startsWith("new:") && (
            <div className="field">
              <button type="button" className="btn btn-primary btn-sm" disabled={certBusy === "create"} onClick={() => issue(certChoice.slice(4) as CertMethod)}>
                {certBusy === "create" ? <span className="spinner" /> : null}Create certificate for {draft.domain}
              </button>
            </div>
          )}

          {certChoice === "import" && (
            <div className="field">
              <textarea className="input mono" rows={3} placeholder="-----BEGIN CERTIFICATE----- (full chain)" value={impCert} onChange={(e) => setImpCert(e.target.value)} />
              <textarea className="input mono" rows={3} style={{ marginTop: 6 }} placeholder="-----BEGIN PRIVATE KEY-----" value={impKey} onChange={(e) => setImpKey(e.target.value)} />
              <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 6 }} disabled={certBusy === "import"} onClick={doImport}>{certBusy === "import" ? <span className="spinner" /> : null}Import certificate</button>
            </div>
          )}

          {certMsg && (
            <div className={`test-result ${certMsg.ok ? "ok" : "bad"}`} style={{ marginTop: 4 }}>
              {certMsg.ok ? <Icon.check /> : <Icon.x />}
              <div>{certMsg.text}</div>
            </div>
          )}
        </>
      )}

      <div className="section-title" style={{ marginTop: 8 }}>Access</div>
      <Toggle k="requireLogin" label="Require login" desc="Gate behind NginUX auth." />
      <Toggle k="require2fa" label="Require 2FA" desc="Demand a second factor." />
      <Toggle k="countryLock" label="Country lock (GeoIP)" desc="Restrict access by country once a GeoIP database is connected (open until then)." />
      <Toggle k="mtls" label="Require client certificate (mTLS)" desc="Only clients with a cert from this host's managed CA may connect." />

      <div className="section-title" style={{ marginTop: 8 }}>Protections</div>
      <Toggle k="securityHeaders" label="Security headers" desc="X-Frame-Options, X-Content-Type-Options, Referrer-Policy." />
      <Toggle k="hsts" label="HSTS" desc="Strict-Transport-Security (enable once HTTPS works)." />
      <Toggle k="rateLimit" label="Rate limiting" desc="Cap requests per IP." />
      <Toggle k="blockExploits" label="Block exploits & bad bots" desc="Deny .env/.git/wp-admin and scanner user-agents." />

      <div className="field" style={{ marginTop: 12 }}><label>Deny IPs / CIDRs (one per line or comma-separated)</label><textarea className="input" rows={2} value={draft.ipDeny} onChange={(e) => set({ ipDeny: e.target.value })} /></div>
      <div className="field"><label>Allow only these IPs / CIDRs (empty = all)</label><textarea className="input" rows={2} value={draft.ipAllow} onChange={(e) => set({ ipAllow: e.target.value })} /></div>
      <div className="field"><label>Custom response headers ("Name: value" per line)</label><textarea className="input" rows={2} value={draft.customHeaders} onChange={(e) => set({ customHeaders: e.target.value })} /></div>
      <div className="field"><label>Custom nginx directives (advanced)</label><textarea className="input mono" rows={3} value={draft.customNginx} onChange={(e) => set({ customNginx: e.target.value })} placeholder="proxy_read_timeout 120s;" /></div>
      <div className="field"><label>Per-path routing ("/path host:port" per line)</label><textarea className="input mono" rows={2} value={draft.pathRules} onChange={(e) => set({ pathRules: e.target.value })} placeholder={"/grafana 192.168.1.70:3000\n/portainer 192.168.1.71:9000"} /></div>

      <div className="section-title" style={{ marginTop: 8 }}>Limits & quotas</div>
      <div className="field"><label>Download speed limit per connection (KB/s, 0 = unlimited)</label><input className="input" style={{ maxWidth: 200 }} type="number" min={0} value={draft.rateLimitKbps || ""} onChange={(e) => set({ rateLimitKbps: Number(e.target.value) })} placeholder="0" /></div>
      <div className="field"><label>Max concurrent connections per client IP (0 = unlimited)</label><input className="input" style={{ maxWidth: 200 }} type="number" min={0} value={draft.maxConns || ""} onChange={(e) => set({ maxConns: Number(e.target.value) })} placeholder="0" /></div>

      <div className="section-title" style={{ marginTop: 8 }}>Load balancing</div>
      <div className="field"><label>Extra upstream targets ("host:port" per line — primary is {draft.forwardHost}:{draft.forwardPort})</label><textarea className="input mono" rows={2} value={draft.upstreams} onChange={(e) => set({ upstreams: e.target.value })} placeholder="192.168.1.51:32400" /></div>
      <div className="field" style={{ marginBottom: 0 }}>
        <label>Method</label>
        <select className="input" style={{ maxWidth: 200 }} value={draft.lbMethod} onChange={(e) => set({ lbMethod: e.target.value as ProxyHost["lbMethod"] })}>
          <option value="round_robin">Round-robin</option>
          <option value="least_conn">Least connections</option>
          <option value="ip_hash">IP hash (sticky)</option>
        </select>
      </div>

      {error && (
        <div className="test-result bad" style={{ marginTop: 12 }}>
          <Icon.x />
          <div>{error}</div>
        </div>
      )}
      <div className="wnav">
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" onClick={onSave} disabled={saving}>{saving ? <span className="spinner" /> : null}Save changes</button>
      </div>
    </div>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className={`check-line ${ok ? "ok" : "bad"}`}>
      {ok ? <Icon.check /> : <Icon.x />}
      {label}
    </div>
  );
}
