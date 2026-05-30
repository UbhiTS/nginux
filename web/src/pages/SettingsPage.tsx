import { useEffect, useState } from "react";
import { api, type Channel, type ConfigVersion } from "../api.ts";
import type { Settings } from "../types.ts";
import { Icon } from "../icons.tsx";

export function SettingsPage({
  reload,
}: {
  reload: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.settings().then(setSettings);
  }, []);

  const update = (patch: Partial<Settings>) =>
    setSettings((s) => (s ? { ...s, ...patch } : s));

  const save = async () => {
    if (!settings) return;
    await api.saveSettings(settings);
    await reload();
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (!settings) {
    return (
      <>
        <div className="topbar"><h1>Settings</h1></div>
        <div className="content"><div className="placeholder"><span className="spinner" /> Loading…</div></div>
      </>
    );
  }

  return (
    <>
      <div className="topbar">
        <h1>Settings</h1>
        <div style={{ flex: 1 }} />
        <button className="btn btn-primary" onClick={save}>
          {saved ? "Saved ✓" : "Save changes"}
        </button>
      </div>
      <div className="content">
        <div className="set-section">
          <div className="section-title">Instance</div>
          <div className="card card-pad" style={{ marginBottom: 20 }}>
            <div className="field" style={{ marginBottom: 14 }}>
              <label>Instance name</label>
              <input className="input" value={settings.instanceName} onChange={(e) => update({ instanceName: e.target.value })} />
            </div>
            <div className="field" style={{ marginBottom: 14 }}>
              <label>Base domain</label>
              <input className="input" value={settings.baseDomain} onChange={(e) => update({ baseDomain: e.target.value })} />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>NginUX address</label>
              <input className="input" value={settings.publicUrl} onChange={(e) => update({ publicUrl: e.target.value })} />
            </div>
          </div>

          <div className="section-title">Network &amp; SSL</div>
          <div className="card card-pad">
            <div className="field" style={{ marginBottom: 14 }}>
              <label>Let's Encrypt email (renewal notices)</label>
              <input className="input" value={settings.letsEncryptEmail} onChange={(e) => update({ letsEncryptEmail: e.target.value })} placeholder="you@example.com" />
            </div>
            <div className="kv"><span className="k">Public IP (gateway)</span>
              <input className="input" style={{ maxWidth: 200 }} value={settings.publicIp} onChange={(e) => update({ publicIp: e.target.value })} />
            </div>
            <div className="kv"><span className="k">LAN IP (gateway)</span>
              <input className="input" style={{ maxWidth: 200 }} value={settings.gatewayIp} onChange={(e) => update({ gatewayIp: e.target.value })} />
            </div>
            <div className="kv" style={{ border: "none" }}><span className="k">Home country (GeoIP)</span>
              <input className="input" style={{ maxWidth: 200 }} value={settings.homeCountry} onChange={(e) => update({ homeCountry: e.target.value })} />
            </div>
          </div>

          <div className="section-title" style={{ marginTop: 20 }}>DNS provider</div>
          <div className="card card-pad">
            <div className="kv"><span className="k">Provider</span>
              <select
                className="input"
                style={{ maxWidth: 200 }}
                value={settings.dnsProvider}
                onChange={(e) => update({ dnsProvider: e.target.value as Settings["dnsProvider"] })}
              >
                <option value="none">None (manual)</option>
                <option value="godaddy">GoDaddy</option>
                <option value="cloudflare">Cloudflare</option>
              </select>
            </div>
            {settings.dnsProvider === "godaddy" && (
              <>
                <div className="field" style={{ margin: "14px 0" }}>
                  <label>GoDaddy API key</label>
                  <input className="input" value={settings.godaddyApiKey} onChange={(e) => update({ godaddyApiKey: e.target.value })} placeholder="key" />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>GoDaddy API secret</label>
                  <input className="input" type="password" value={settings.godaddySecret} onChange={(e) => update({ godaddySecret: e.target.value })} placeholder="secret" />
                </div>
              </>
            )}
            {settings.dnsProvider === "cloudflare" && (
              <div className="field" style={{ margin: "14px 0 0" }}>
                <label>Cloudflare API token</label>
                <input className="input" type="password" value={settings.cloudflareApiToken} onChange={(e) => update({ cloudflareApiToken: e.target.value })} placeholder="token (Zone:DNS:Edit)" />
              </div>
            )}
            <div className="switch-row" style={{ marginTop: 14, marginBottom: 0 }}>
              <div className="sw-text">
                <div className="t">Use Let's Encrypt staging</div>
                <div className="d">Avoid rate limits while testing — certificates won't be browser-trusted.</div>
              </div>
              <button className={`switch${settings.acmeStaging ? " on" : ""}`} onClick={() => update({ acmeStaging: !settings.acmeStaging })} />
            </div>
          </div>

          <Notifications />
          <BackupsGitOps settings={settings} update={update} />
        </div>
      </div>
    </>
  );
}

function BackupsGitOps({ settings, update }: { settings: Settings; update: (p: Partial<Settings>) => void }) {
  const [versions, setVersions] = useState<ConfigVersion[]>([]);
  const [commits, setCommits] = useState<{ hash: string; date: string; message: string }[]>([]);
  const [msg, setMsg] = useState("");
  const [importConf, setImportConf] = useState("");
  const [importMsg, setImportMsg] = useState("");

  const doImport = async () => {
    if (!importConf.trim()) return;
    const r = await api.importConfig(importConf);
    setImportMsg(`Imported ${r.imported.length} (${r.imported.join(", ") || "none"}), skipped ${r.skipped.length}.`);
    setImportConf("");
  };

  const load = () => {
    api.configVersions().then(setVersions).catch(() => {});
    api.gitLog().then(setCommits).catch(() => {});
  };
  useEffect(load, []);

  const restore = async (id: string) => {
    if (!confirm("Restore this configuration version? Current state is snapshotted first.")) return;
    const r = await api.restoreVersion(id);
    setMsg(`Restored ${r.restored} services.`);
    setTimeout(() => setMsg(""), 4000);
    load();
  };

  const exportConfig = async () => {
    const data = await api.exportConfig();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `nginux-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };

  return (
    <>
      <div className="section-title" style={{ marginTop: 20, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        Backups &amp; GitOps
        <span style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-sm" onClick={exportConfig}>Export config</button>
          <button className="btn btn-sm" onClick={async () => { await api.snapshotConfig("Manual snapshot"); load(); }}>Snapshot now</button>
        </span>
      </div>

      <div className="switch-row">
        <div className="sw-icon"><Icon.logs /></div>
        <div className="sw-text">
          <div className="t">GitOps — commit config to git on every change</div>
          <div className="d">Keeps a version-controlled, reviewable history of the generated config in a local repo.</div>
        </div>
        <button className={`switch${settings.gitOpsEnabled ? " on" : ""}`} onClick={() => update({ gitOpsEnabled: !settings.gitOpsEnabled })} />
      </div>

      <div className="card atable" style={{ marginBottom: 12 }}>
        <div className="ahead" style={{ gridTemplateColumns: "1.6fr 1fr 0.7fr auto" }}>
          <div>Restore point</div><div>When</div><div>Services</div><div />
        </div>
        {versions.slice(0, 8).map((v) => (
          <div key={v.id} className="arow" style={{ gridTemplateColumns: "1.6fr 1fr 0.7fr auto" }}>
            <div>{v.label} <span className="muted" style={{ fontSize: 11 }}>· {v.actor}</span></div>
            <div className="muted">{new Date(v.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
            <div className="muted">{v.hostCount}</div>
            <button className="btn btn-ghost btn-sm" onClick={() => restore(v.id)}>Restore</button>
          </div>
        ))}
        {versions.length === 0 && <div className="placeholder"><p>No restore points yet — they're captured automatically before each change.</p></div>}
      </div>
      {msg && <div className="info-line" style={{ marginBottom: 12 }}><Icon.check />{msg}</div>}

      {commits.length > 0 && (
        <div className="card card-pad" style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 650, marginBottom: 8, fontSize: 13 }}>Recent GitOps commits</div>
          {commits.slice(0, 6).map((c) => (
            <div key={c.hash} className="kv"><span className="k mono">{c.hash}</span><span className="v muted" style={{ fontWeight: 400 }}>{c.message}</span></div>
          ))}
        </div>
      )}

      <div className="card card-pad">
        <div style={{ fontWeight: 650, marginBottom: 6, fontSize: 13 }}>Import an existing nginx.conf</div>
        <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>Paste a config — NginUX parses each proxy <span className="mono">server</span> block into a managed host (duplicates skipped).</div>
        <textarea className="input mono" rows={4} value={importConf} onChange={(e) => setImportConf(e.target.value)} placeholder={"server {\n  server_name app.example.com;\n  location / { proxy_pass http://192.168.1.10:8080; }\n}"} />
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
          <button className="btn btn-primary btn-sm" onClick={doImport}>Import</button>
          {importMsg && <span className="info-line"><Icon.check />{importMsg}</span>}
        </div>
      </div>
    </>
  );
}

const CHANNEL_FIELDS: Record<string, { key: string; label: string; secret?: boolean }[]> = {
  ntfy: [{ key: "server", label: "Server (default https://ntfy.sh)" }, { key: "topic", label: "Topic" }],
  gotify: [{ key: "server", label: "Server URL" }, { key: "token", label: "App token", secret: true }],
  pushover: [{ key: "token", label: "API token", secret: true }, { key: "user", label: "User key", secret: true }],
  discord: [{ key: "url", label: "Webhook URL", secret: true }],
  slack: [{ key: "url", label: "Webhook URL", secret: true }],
  telegram: [{ key: "token", label: "Bot token", secret: true }, { key: "chatId", label: "Chat ID" }],
  webhook: [{ key: "url", label: "Endpoint URL", secret: true }],
  email: [{ key: "host", label: "SMTP host" }, { key: "port", label: "Port" }, { key: "user", label: "Username", secret: true }, { key: "pass", label: "Password", secret: true }, { key: "from", label: "From" }, { key: "to", label: "To" }],
};

function Notifications() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [type, setType] = useState("ntfy");
  const [name, setName] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");

  const load = () => { api.channels().then(setChannels).catch(() => {}); };
  useEffect(load, []);

  const add = async () => {
    if (!name) return;
    await api.createChannel(type, name, config);
    setName(""); setConfig({});
    load();
  };
  const test = async (id: string) => {
    const r = await api.testChannel(id);
    setMsg(`Test: ${r.status}`);
    setTimeout(() => setMsg(""), 4000);
    load();
  };

  return (
    <>
      <div className="section-title" style={{ marginTop: 20 }}>Notifications &amp; alerts</div>
      <div className="card card-pad" style={{ marginBottom: 12 }}>
        <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
          Get alerted on cert expiry, a service going down, brute-force attempts, and agent approval requests.
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <select className="input" style={{ maxWidth: 150 }} value={type} onChange={(e) => { setType(e.target.value); setConfig({}); }}>
            {Object.keys(CHANNEL_FIELDS).map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input className="input" style={{ maxWidth: 160 }} placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
          {CHANNEL_FIELDS[type].map((f) => (
            <input
              key={f.key}
              className="input"
              style={{ maxWidth: 220 }}
              type={f.secret ? "password" : "text"}
              placeholder={f.label}
              value={config[f.key] ?? ""}
              onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))}
            />
          ))}
          <button className="btn btn-primary btn-sm" onClick={add}>Add channel</button>
        </div>
        {msg && <div className="info-line" style={{ marginTop: 10 }}><Icon.info />{msg}</div>}
      </div>
      <div className="card atable">
        {channels.map((c) => (
          <div key={c.id} className="arow" style={{ gridTemplateColumns: "auto 1fr auto auto auto", gap: 12 }}>
            <span className="pill n">{c.type}</span>
            <div><b>{c.name}</b> <span className="muted" style={{ fontSize: 11 }}>{c.lastStatus ?? "untested"}</span></div>
            <button className={`switch${c.enabled ? " on" : ""}`} onClick={async () => { await api.setChannelEnabled(c.id, !c.enabled); load(); }} />
            <button className="btn btn-ghost btn-sm" onClick={() => test(c.id)}>Test</button>
            <button className="btn btn-ghost btn-sm" onClick={async () => { await api.deleteChannel(c.id); load(); }}>Delete</button>
          </div>
        ))}
        {channels.length === 0 && <div className="placeholder"><p>No notification channels yet.</p></div>}
      </div>
    </>
  );
}
