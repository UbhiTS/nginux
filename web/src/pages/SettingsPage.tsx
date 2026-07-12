import { useEffect, useState } from "react";
import { api, type Channel, type ConfigVersion, type GeoipStatus } from "../api.ts";
import type { Settings } from "../types.ts";
import { Icon } from "../icons.tsx";
import { COUNTRIES } from "../countries.ts";
import { BrandLogo } from "../components/BrandLogo.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";

/** 48 hex chars of CSPRNG output - used for the forward-auth shared secret. */
function randomSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** ISO codes (comma/space list) → clean uppercase 2-letter array. Mirrors the server. */
function parseCodes(raw: string): string[] {
  return (raw || "").split(/[,\s]+/).map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
}
const COUNTRY_NAME = new Map(COUNTRIES.map((c) => [c.code, c.name]));
const countryName = (code: string): string => COUNTRY_NAME.get(code) ?? code;

export function SettingsPage({
  reload,
}: {
  reload: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [detecting, setDetecting] = useState(false);

  // Auto-detect the public IP (and home country) via an outbound lookup, filling
  // the fields - the user can still override and must Save to persist.
  const detectIp = async () => {
    setDetecting(true);
    try {
      const r = await api.detectPublicIp();
      if (r.ip) update({ publicIp: r.ip, ...(r.country ? { homeCountry: r.country } : {}) });
    } catch { /* offline / blocked - leave fields as-is */ }
    finally { setDetecting(false); }
  };

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

  // Derive URL/cookie hints from the configured base domain, so they read e.g.
  // "nginux.ubhi.io" once it's set instead of a generic "yourdomain.com".
  const base = (settings.baseDomain || "").trim() || "yourdomain.com";

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
              <input className="input" value={settings.baseDomain} onChange={(e) => update({ baseDomain: e.target.value })} placeholder="yourdomain.com" />
            </div>
            <div className="switch-row" style={{ marginTop: 0, marginBottom: 14 }}>
              <div className="sw-text">
                <div className="t">Check for updates</div>
                <div className="d">Look for new NginUX releases on GitHub (every 6 hours; nothing about your instance is sent). An Update button appears in the sidebar when one is out.</div>
              </div>
              <button className={`switch${settings.updateCheckEnabled ? " on" : ""}`} onClick={() => update({ updateCheckEnabled: !settings.updateCheckEnabled })} />
            </div>
            <div className="switch-row" style={{ marginTop: 0, marginBottom: 14 }}>
              <div className="sw-text">
                <div className="t">Require 2FA for admins &amp; editors</div>
                <div className="d">Managers without two-factor are confined to a one-time enrollment screen on their next request until it's set up. Read-only and scoped users are unaffected.</div>
              </div>
              <button className={`switch${settings.require2faForManagers ? " on" : ""}`} onClick={() => update({ require2faForManagers: !settings.require2faForManagers })} />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>NginUX public URL</label>
              <input className="input" value={settings.ssoLoginUrl} onChange={(e) => update({ ssoLoginUrl: e.target.value })} placeholder={`https://nginux.${base}`} />
              <div className="hint">The public HTTPS address where you reach NginUX. Services with <b>Require login</b> also send unauthenticated visitors here to sign in, then back. Expose NginUX itself at this address (e.g. <span className="mono">nginux.{base} → 127.0.0.1:6767</span>) and leave that one <b>un-gated</b>.</div>
              {settings.ssoLoginUrl && (
                <div className="info-line" style={{ marginTop: 10, alignItems: "flex-start" }}>
                  <Icon.alert />
                  <span>The NginUX service at your public URL must <b>not</b> have "Require login" enabled - that would lock you out of the login page itself.</span>
                </div>
              )}
            </div>
          </div>

          <div className="section-title">Login gate (sign-in for protected services)</div>
          <div className="card card-pad">
            <div className="field">
              <label>Shared cookie domain</label>
              <input className="input" value={settings.ssoCookieDomain} onChange={(e) => update({ ssoCookieDomain: e.target.value })} placeholder={`.${base} (auto from the NginUX URL if blank)`} />
              <div className="hint">So one sign-in covers every subdomain. Leave blank to derive it from the NginUX public URL above.</div>
            </div>
            <div className="field">
              <label>Extra login realms (for services on a second base domain)</label>
              <RealmsEditor value={settings.ssoRealms} onChange={(v) => update({ ssoRealms: v })} />
              <div className="hint">Only needed if you gate services on a <b>different</b> base domain. Each realm gives that domain its own sign-in portal + cookie, so it doesn't loop back here. Leave empty for a single-domain setup.</div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Forward-auth secret</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input className="input" type="password" autoComplete="new-password" value={settings.ssoForwardSecret} onChange={(e) => update({ ssoForwardSecret: e.target.value })} placeholder="click Generate →" />
                <button type="button" className="btn" onClick={() => update({ ssoForwardSecret: randomSecret() })}>Generate</button>
              </div>
              <div className="hint">A long random value nginx sends with every login check, so it can't be called directly and bypassed. NginUX generates one automatically - you only need this to rotate it: click <b>Generate</b>, then <b>Save</b>, and the protected sites are rewritten for you.</div>
            </div>
          </div>

          <div className="section-title" style={{ marginTop: 20 }}>Network &amp; SSL</div>
          <div className="card card-pad">
            <div className="field" style={{ marginBottom: 14 }}>
              <label>Let's Encrypt email (renewal notices)</label>
              <input className="input" value={settings.letsEncryptEmail} onChange={(e) => update({ letsEncryptEmail: e.target.value })} placeholder="you@example.com" />
            </div>
            <div className="switch-row" style={{ marginTop: 0, marginBottom: 14 }}>
              <div className="sw-text">
                <div className="t">Use Let's Encrypt staging</div>
                <div className="d">Avoid rate limits while testing - certificates won't be browser-trusted.</div>
              </div>
              <button className={`switch${settings.acmeStaging ? " on" : ""}`} onClick={() => update({ acmeStaging: !settings.acmeStaging })} />
            </div>
            <div className="kv"><span className="k">Public IP (gateway)</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button className="btn btn-sm" onClick={detectIp} disabled={detecting} title="Detect this host's public IP (and home country) via an outbound lookup. You can still edit it.">
                  {detecting ? <span className="spinner" /> : <Icon.globe />}Detect
                </button>
                <input className="input" style={{ maxWidth: 200 }} value={settings.publicIp} onChange={(e) => update({ publicIp: e.target.value })} placeholder="auto-detect or enter manually" />
              </div>
            </div>
            <div className="kv"><span className="k">LAN IP (gateway)</span>
              <input className="input" style={{ maxWidth: 200 }} value={settings.gatewayIp} onChange={(e) => update({ gatewayIp: e.target.value })} />
            </div>
            <div className="kv" style={{ border: "none", alignItems: "flex-start", gap: 16 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span className="k">Home country (GeoIP)</span>
                <span style={{ fontSize: 12, color: "var(--text-faint)", maxWidth: 420 }}>
                  Where you normally are — always allowed under <strong>Country lock</strong>, and the anchor for the traffic map. Add travel countries below. Needs the GeoIP database; until then, country lock stays open to all.
                </span>
              </div>
              <select
                className="input"
                style={{ maxWidth: 240, flex: "none" }}
                value={(settings.homeCountry || "").toUpperCase()}
                onChange={(e) => update({ homeCountry: e.target.value })}
              >
                <option value="">None — don't filter by country</option>
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>{c.name} ({c.code})</option>
                ))}
              </select>
            </div>
            <div className="kv" style={{ border: "none", alignItems: "flex-start", gap: 16 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span className="k">Also allow these countries</span>
                <span style={{ fontSize: 12, color: "var(--text-faint)", maxWidth: 420 }}>
                  Extra countries allowed while <strong>Country lock</strong> is on — add wherever you're travelling so you don't lock yourself out. Home country and your LAN are always allowed on top of these.
                </span>
              </div>
              <div style={{ flex: 1, maxWidth: 340, display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
                {parseCodes(settings.allowedCountries).length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-end" }}>
                    {parseCodes(settings.allowedCountries).map((code) => (
                      <span key={code} className="pill n" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        {countryName(code)} ({code})
                        <button type="button" title={`Remove ${countryName(code)}`}
                          onClick={() => update({ allowedCountries: parseCodes(settings.allowedCountries).filter((c) => c !== code).join(",") })}
                          style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 0, fontSize: 15, lineHeight: 1 }}>×</button>
                      </span>
                    ))}
                  </div>
                )}
                <select className="input" style={{ maxWidth: 240, flex: "none" }} value=""
                  onChange={(e) => { const v = e.target.value; if (v) update({ allowedCountries: [...new Set([...parseCodes(settings.allowedCountries), v])].join(",") }); }}>
                  <option value="">＋ Add a country…</option>
                  {COUNTRIES.filter((c) => c.code !== (settings.homeCountry || "").toUpperCase() && !parseCodes(settings.allowedCountries).includes(c.code)).map((c) => (
                    <option key={c.code} value={c.code}>{c.name} ({c.code})</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <CountryLock settings={settings} update={update} onSave={save} />

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
                <div className="info-line" style={{ marginTop: 12, alignItems: "flex-start" }}>
                  <Icon.alert />
                  <span>
                    Heads-up: per GoDaddy's developer docs, their Domains API only works on accounts with
                    <b> 10 or more domains</b> (or a Discount Domain Club membership). With fewer, the API returns
                    <b> ACCESS_DENIED</b> and DNS-01 validation will fail - use <b>HTTP validation</b> or <b>Cloudflare</b> instead.
                  </span>
                </div>
              </>
            )}
            {settings.dnsProvider === "cloudflare" && (
              <div className="field" style={{ margin: "14px 0 0" }}>
                <label>Cloudflare API token</label>
                <input className="input" type="password" value={settings.cloudflareApiToken} onChange={(e) => update({ cloudflareApiToken: e.target.value })} placeholder="token (Zone:DNS:Edit)" />
              </div>
            )}
            {settings.dnsProvider === "none" && (
              <div className="muted" style={{ fontSize: 12.5 }}>Connect a provider to validate certificates over DNS (no open ports needed).</div>
            )}
          </div>

          <div className="section-title" style={{ marginTop: 20 }}>Log rotation</div>
          <div className="card card-pad">
            <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>Max log size (MB)</label>
                <input className="input" type="number" min={0} value={settings.logMaxMb} onChange={(e) => update({ logMaxMb: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                <div className="hint">Rotate an nginx log once it passes this size. <b>0</b> disables rotation.</div>
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>Rotated copies to keep</label>
                <input className="input" type="number" min={0} value={settings.logKeepFiles} onChange={(e) => update({ logKeepFiles: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                <div className="hint">Older copies beyond this are deleted. <b>0</b> just truncates.</div>
              </div>
            </div>
            <div className="info-line" style={{ marginTop: 12, alignItems: "flex-start" }}>
              <Icon.info />
              <span>
                {settings.logMaxMb > 0
                  ? <>Caps each on-disk log at about <b>{settings.logMaxMb * (settings.logKeepFiles + 1)} MB</b> (access, stream, error). The live traffic dashboards are in-memory, so rotation never affects them.</>
                  : <>Rotation is <b>off</b> - the nginx access/error logs will grow unbounded on the data volume.</>}
              </span>
            </div>
          </div>

          <Notifications />
          <BackupsGitOps settings={settings} update={update} />
          <About />
        </div>
      </div>
    </>
  );
}

const REPO_URL = "https://github.com/UbhiTS/nginux";
const AUTHOR_URL = "https://github.com/UbhiTS";

function About() {
  const [version, setVersion] = useState("");
  useEffect(() => { api.health().then((h) => setVersion(h.version)).catch(() => {}); }, []);
  return (
    <>
      <div className="section-title" style={{ marginTop: 20 }}>About</div>
      <div className="card card-pad">
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}>
          <BrandLogo size={40} className="brand-logo" />
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>
              NginUX {version && <span className="muted" style={{ fontWeight: 500, fontSize: 13 }}>v{version}</span>}
            </div>
            <div className="muted" style={{ fontSize: 13 }}>Secure ingress, simplified</div>
          </div>
        </div>
        <div className="kv">
          <span className="k">Built with ❤️ by</span>
          <span className="v"><a href={AUTHOR_URL} target="_blank" rel="noreferrer noopener">Tarunpreet Singh Ubhi</a></span>
        </div>
        <div className="kv">
          <span className="k">License</span>
          <span className="v">
            MIT - free to use, modify, and distribute; just keep the attribution.{" "}
            <a href={`${REPO_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer noopener">View license</a>
          </span>
        </div>
        <div className="kv" style={{ border: "none" }}>
          <span className="k">Source</span>
          <span className="v" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Icon.github className="about-gh" />
            <a href={REPO_URL} target="_blank" rel="noreferrer noopener">github.com/UbhiTS/nginux</a>
          </span>
        </div>
        <div className="hint" style={{ marginTop: 14 }}>
          © 2026 Tarunpreet Singh Ubhi · Built for self-hosters. If NginUX is useful to you, a ⭐ on GitHub means a lot.
        </div>
      </div>
    </>
  );
}

function CountryLock({ settings, update, onSave }: { settings: Settings; update: (p: Partial<Settings>) => void; onSave: () => Promise<void> }) {
  const [status, setStatus] = useState<GeoipStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const load = () => api.geoipStatus().then(setStatus).catch(() => {});
  useEffect(() => { load(); }, []);

  const download = async () => {
    setBusy(true); setErr(""); setMsg("");
    try {
      await onSave(); // persist the license key + country before downloading
      const r = await api.downloadGeoip();
      setStatus(r.status);
      setMsg(r.status.active ? `Database installed - country lock active for ${r.status.countries.join(", ")}.` : "Database installed. Set a home country above to start filtering.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Download failed.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true); setErr(""); setMsg("");
    try { await api.deleteGeoip(); await load(); } catch (e) { setErr(e instanceof Error ? e.message : "Remove failed."); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="section-title" style={{ marginTop: 20 }}>Country lock (GeoIP)</div>
      <div className="card card-pad">
        <p className="muted" style={{ fontSize: 12.5, marginTop: 0, marginBottom: 14 }}>
          Powers the "Only allow my country" toggle on services. Needs the free MaxMind GeoLite2 database - sign up at maxmind.com and create a license key (Account → Manage License Keys). Your own LAN is always allowed.
        </p>
        <div className="field" style={{ marginBottom: 14 }}>
          <label>MaxMind license key</label>
          <input className="input" type="password" value={settings.maxmindLicenseKey} onChange={(e) => update({ maxmindLicenseKey: e.target.value })} placeholder="license key" />
        </div>
        <div className="kv"><span className="k">Database</span>
          <span className="v">{status?.present
            ? <span className="pill g">Installed{status.sizeBytes ? ` · ${Math.round(status.sizeBytes / 1024)} KB` : ""}</span>
            : <span className="pill n">Not installed</span>}</span>
        </div>
        <div className="kv"><span className="k">Lock status</span>
          <span className="v">{status?.active ? `Active - allowing ${status.countries.join(", ")}` : status?.present ? "Installed (set a home country to enable)" : "Inactive - services stay open"}</span>
        </div>
        {status?.updatedAt && <div className="kv" style={{ border: "none" }}><span className="k">Last updated</span><span className="v muted">{new Date(status.updatedAt).toLocaleString()}</span></div>}
        {err && <div className="test-result bad" style={{ marginTop: 12, marginBottom: 0 }}><Icon.x /><div>{err}</div></div>}
        {msg && <div className="info-line" style={{ marginTop: 12 }}><Icon.check />{msg}</div>}
        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={download}>{busy ? <span className="spinner" /> : null}{status?.present ? "Update database" : "Download database"}</button>
          {status?.present && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={remove}>Remove</button>}
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
  const [importPreview, setImportPreview] = useState<{ toImport: { domain: string; forwardHost: string; forwardPort: number; ssl: boolean }[]; skipped: { domain: string; reason: string }[] } | null>(null);
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  const doPreview = async () => {
    if (!importConf.trim()) return;
    try { setImportPreview(await api.previewImportConfig(importConf)); setImportMsg(""); }
    catch { setImportMsg("Couldn't parse that config."); }
  };
  const doImport = async () => {
    if (!importConf.trim()) return;
    const r = await api.importConfig(importConf);
    setImportMsg(`Imported ${r.imported.length} (${r.imported.join(", ") || "none"}), skipped ${r.skipped.length}.`);
    setImportConf(""); setImportPreview(null);
  };

  const load = () => {
    api.configVersions().then(setVersions).catch(() => {});
    api.gitLog().then(setCommits).catch(() => {});
  };
  useEffect(load, []);

  const restore = async () => {
    if (!restoreId) return;
    setRestoring(true);
    try {
      const r = await api.restoreVersion(restoreId);
      setRestoreId(null);
      setMsg(`Restored ${r.restored} services.`);
      setTimeout(() => setMsg(""), 4000);
      load();
    } finally {
      setRestoring(false);
    }
  };

  const backup = async () => {
    const pass = prompt("Optional passphrase to ENCRYPT the backup (leave blank for a plain, secrets-masked file):") ?? "";
    if (pass && pass.length < 8) { setMsg("Passphrase must be at least 8 characters."); setTimeout(() => setMsg(""), 4000); return; }
    const r = await api.backupConfig(pass || undefined, !!pass);
    const payload = r.encrypted ? r.blob : r.bundle;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `nginux-backup-${new Date().toISOString().slice(0, 10)}${r.encrypted ? ".enc" : ""}.json`;
    a.click();
    setMsg(r.encrypted ? "Encrypted backup downloaded." : "Backup downloaded (secrets masked)."); setTimeout(() => setMsg(""), 4000);
  };

  const restoreBackup = async (file: File) => {
    setRestoring(true);
    try {
      const parsed = JSON.parse(await file.text());
      const encrypted = parsed && parsed.magic === "nginux-encrypted";
      const passphrase = encrypted ? (prompt("This backup is encrypted. Enter its passphrase:") ?? "") : undefined;
      if (!confirm("Restore this backup? It REPLACES all services, bans and channels, and merges settings.")) return;
      const r = await api.restoreConfig(encrypted ? { blob: parsed, passphrase } : { bundle: parsed });
      setMsg(`Restored ${r.hosts} services, ${r.bans} bans, ${r.channels} channels.`);
      setTimeout(() => setMsg(""), 6000);
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Couldn't restore that file."); setTimeout(() => setMsg(""), 6000);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <>
      <div className="section-title" style={{ marginTop: 20, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        Backups &amp; GitOps
        <span style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-sm" onClick={backup} title="Portable bundle: hosts + settings + bans + channels">Backup</button>
          <label className="btn btn-sm" style={{ cursor: "pointer", margin: 0 }}>
            Restore
            <input type="file" accept="application/json,.json" style={{ display: "none" }} disabled={restoring}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void restoreBackup(f); e.target.value = ""; }} />
          </label>
          <button className="btn btn-sm" onClick={async () => { await api.snapshotConfig("Manual snapshot"); load(); }}>Snapshot now</button>
        </span>
      </div>

      <div className="switch-row">
        <div className="sw-icon"><Icon.logs /></div>
        <div className="sw-text">
          <div className="t">GitOps - commit config to git on every change</div>
          <div className="d">Keeps a version-controlled, reviewable history of the generated config in a local repo.</div>
        </div>
        <button className={`switch${settings.gitOpsEnabled ? " on" : ""}`} onClick={() => update({ gitOpsEnabled: !settings.gitOpsEnabled })} />
      </div>

      <div className="card atable" style={{ marginBottom: 12 }}>
        <div className="ahead" style={{ gridTemplateColumns: "1.6fr 1fr 0.7fr 90px" }}>
          <div>Restore point</div><div>When</div><div style={{ textAlign: "center" }}>Services</div><div />
        </div>
        {versions.slice(0, 8).map((v) => (
          <div key={v.id} className="arow" style={{ gridTemplateColumns: "1.6fr 1fr 0.7fr 90px" }}>
            <div>{v.label} <span className="muted" style={{ fontSize: 11 }}>· {v.actor}</span></div>
            <div className="muted">{new Date(v.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
            <div className="muted" style={{ textAlign: "center" }}>{v.hostCount}</div>
            <button className="btn btn-ghost btn-sm" style={{ justifySelf: "end" }} onClick={() => setRestoreId(v.id)}>Restore</button>
          </div>
        ))}
        {versions.length === 0 && <div className="placeholder"><p>No restore points yet - they're captured automatically before each change.</p></div>}
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
        <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>Paste a config - NginUX parses each proxy <span className="mono">server</span> block into a managed host (duplicates skipped).</div>
        <textarea className="input mono" rows={4} value={importConf} onChange={(e) => { setImportConf(e.target.value); setImportPreview(null); }} placeholder={"server {\n  server_name app.example.com;\n  location / { proxy_pass http://192.168.1.10:8080; }\n}"} />
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
          <button className="btn btn-sm" onClick={doPreview}>Preview</button>
          {importPreview && importPreview.toImport.length > 0 && (
            <button className="btn btn-primary btn-sm" onClick={doImport}>Import {importPreview.toImport.length} service{importPreview.toImport.length === 1 ? "" : "s"}</button>
          )}
          {importMsg && <span className="info-line"><Icon.check />{importMsg}</span>}
        </div>
        {importPreview && (
          <div style={{ marginTop: 12, fontSize: 12.5 }}>
            {importPreview.toImport.length > 0 ? (
              <div>
                <div className="muted" style={{ marginBottom: 4 }}>Will import:</div>
                {importPreview.toImport.map((d) => (
                  <div key={d.domain} className="mono" style={{ padding: "2px 0" }}>
                    <Icon.check /> {d.domain} → {d.forwardHost}:{d.forwardPort}{d.ssl ? " (https)" : ""}
                  </div>
                ))}
              </div>
            ) : <div className="muted">Nothing new to import.</div>}
            {importPreview.skipped.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div className="muted" style={{ marginBottom: 4 }}>Skipped:</div>
                {importPreview.skipped.map((s, i) => (
                  <div key={i} className="mono" style={{ padding: "2px 0", color: "var(--text-dim)" }}>{s.domain} — {s.reason}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {restoreId && (
        <ConfirmDialog
          title="Restore this configuration?"
          message="Your services will be rolled back to this restore point. The current state is snapshotted first, so you can undo it."
          confirmLabel="Restore"
          busy={restoring}
          onConfirm={restore}
          onCancel={() => setRestoreId(null)}
        />
      )}
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

// Severity floor a channel alerts on: e.g. a pager channel set to "danger" ignores
// routine notices, while the default "info" forwards everything (as before).
const SEVERITY_OPTIONS = [
  { value: "info", label: "All (info+)" },
  { value: "notice", label: "Notice+" },
  { value: "warn", label: "Warnings+" },
  { value: "danger", label: "Danger only" },
];

function Notifications() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [type, setType] = useState("ntfy");
  const [name, setName] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [minSeverity, setMinSeverity] = useState("info");
  const [msg, setMsg] = useState("");

  const load = () => { api.channels().then(setChannels).catch(() => {}); };
  useEffect(load, []);

  const add = async () => {
    if (!name) return;
    await api.createChannel(type, name, config, minSeverity);
    setName(""); setConfig({}); setMinSeverity("info");
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
          <select className="input" style={{ maxWidth: 150 }} value={minSeverity} onChange={(e) => setMinSeverity(e.target.value)} title="Only alert this channel at or above this severity">
            {SEVERITY_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <button className="btn btn-primary btn-sm" onClick={add}>Add channel</button>
        </div>
        {msg && <div className="info-line" style={{ marginTop: 10 }}><Icon.info />{msg}</div>}
      </div>
      <div className="card atable">
        {channels.map((c) => (
          <div key={c.id} className="arow" style={{ gridTemplateColumns: "72px 1fr auto auto auto auto", gap: 12 }}>
            <span className="pill n" style={{ justifySelf: "center" }}>{c.type}</span>
            <div><b>{c.name}</b> <span className="muted" style={{ fontSize: 11 }}>{c.lastStatus ?? "untested"}</span></div>
            <select
              className="input"
              style={{ maxWidth: 130, height: 30, padding: "0 8px", fontSize: 12 }}
              value={c.minSeverity ?? "info"}
              title="Severity floor: this channel only alerts at or above this level"
              onChange={async (e) => { await api.setChannelRouting(c.id, { minSeverity: e.target.value }); load(); }}
            >
              {SEVERITY_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
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

interface Realm { baseDomain: string; loginUrl: string }
/** Edit the per-base-domain login realms (backlog 3.3). Serialises rows to the
 *  ssoRealms JSON string; tolerant of an existing invalid value (starts empty). */
function RealmsEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const parse = (raw: string): Realm[] => {
    try { const a = JSON.parse(raw || "[]"); return Array.isArray(a) ? a.filter((r) => r && typeof r.baseDomain === "string") : []; }
    catch { return []; }
  };
  const rows = parse(value);
  const commit = (next: Realm[]) => onChange(next.length ? JSON.stringify(next) : "");
  const setRow = (i: number, patch: Partial<Realm>) => commit(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div>
      {rows.map((r, i) => (
        <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
          <input className="input" style={{ maxWidth: 200 }} placeholder="base domain (example.com)" value={r.baseDomain} onChange={(e) => setRow(i, { baseDomain: e.target.value })} />
          <input className="input" placeholder="https://nginux.example.com" value={r.loginUrl} onChange={(e) => setRow(i, { loginUrl: e.target.value })} />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => commit(rows.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <button type="button" className="btn btn-sm" onClick={() => commit([...rows, { baseDomain: "", loginUrl: "" }])}>Add realm</button>
    </div>
  );
}
