import { useEffect, useState } from "react";
import type { Route } from "../App.tsx";
import { api, type Certificate, type Uptime } from "../api.ts";
import type { ProxyHost } from "../types.ts";
import { Icon } from "../icons.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";

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

  const refetch = () => {
    api.getHost(hostId).then(setHost).catch(() => setHost(null));
    api.hostConfig(hostId).then(setConfig).catch(() => setConfig(""));
    api.uptime(hostId).then(setUptime).catch(() => setUptime(null));
    api.certificates().then(setCerts).catch(() => {});
  };
  useEffect(refetch, [hostId]);

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
  // The real certificate for this domain (from the cert store), not the host's
  // stale certExpiresAt field.
  const cert = certs.find((c) => c.domain === host.domain) ?? null;
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
        <button className="btn btn-ghost btn-sm" onClick={() => navigate({ name: "dashboard" })}>
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

      <div className="content">
        <div className={`summary-banner ${host.enabled ? b.cls : "warn"}`}>
          <div className="big-check">{host.enabled ? b.icon : <Icon.alert />}</div>
          <div>
            <div className="st">{host.enabled ? b.title : "Paused — this service isn't being served."}</div>
            <div className="sd">
              {host.enabled ? (
                <>
                  {certDays !== null ? `Certificate valid for ${certDays} days` : "No certificate yet"} ·{" "}
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
          <EditForm draft={draft} setDraft={setDraft} onSave={saveEdit} onCancel={() => setEditing(false)} saving={saving} error={saveErr} />
        ) : (
        <div className="detail-grid">
          <div>
            <div className="card" style={{ marginBottom: 18 }}>
              <div className="card-head">
                Routing
                <span className="pill n">{host.preset} preset</span>
              </div>
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
              <div className="card-head">Certificate</div>
              <div className="card-pad">
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
            <div key={c.id} className="kv">
              <span className="k">{c.name} <span className="muted mono" style={{ fontSize: 10 }}>{c.fingerprint.slice(0, 17)}…</span></span>
              <span className="v"><button className="btn btn-ghost btn-sm" onClick={async () => { await api.revokeClientCert(hostId, c.id); load(); }}>Revoke</button></span>
            </div>
          ))}
          {certs.length === 0 && <div className="muted" style={{ fontSize: 12.5 }}>No client certs issued yet.</div>}
        </div>
      </div>
    </div>
  );
}

function EditForm({ draft, setDraft, onSave, onCancel, saving, error }: {
  draft: ProxyHost;
  setDraft: (d: ProxyHost) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error?: string;
}) {
  const set = (patch: Partial<ProxyHost>) => setDraft({ ...draft, ...patch });
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
      <Toggle k="ssl" label="HTTPS" desc="Serve over TLS and redirect HTTP." />
      <Toggle k="websockets" label="WebSockets" desc="Support upgrade connections." />
      <Toggle k="maintenanceMode" label="Maintenance mode" desc="Serve a 'be right back' page instead of proxying." />

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
