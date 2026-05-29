import { useEffect, useState } from "react";
import type { Route } from "../App.tsx";
import { api } from "../api.ts";
import type { ApplyResult, Preset, Settings } from "../types.ts";
import { Icon } from "../icons.tsx";

const STEPS = ["What", "Where", "Address", "Secure", "Done"];

export function Wizard({
  settings,
  navigate,
  reload,
}: {
  settings: Settings | null;
  navigate: (r: Route) => void;
  reload: () => Promise<void>;
}) {
  const [step, setStep] = useState(1);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [preset, setPreset] = useState<Preset | null>(null);
  const [forward, setForward] = useState("http://192.168.1.50:32400");
  const [test, setTest] = useState<{ reachable: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [sub, setSub] = useState("");
  const [ssl, setSsl] = useState(true);
  const [login, setLogin] = useState(true);
  const [twofa, setTwofa] = useState(true);
  const [country, setCountry] = useState(true);
  const [creating, setCreating] = useState(false);
  const [apply, setApply] = useState<ApplyResult | null>(null);

  const base = settings?.baseDomain ?? "example.com";
  const country2 = settings?.homeCountry ?? "your country";

  useEffect(() => {
    api.presets().then((p) => {
      setPresets(p);
      setPreset(p.find((x) => x.id === "plex") ?? p[0]);
    });
  }, []);

  const parsed = parseForward(forward);

  const runTest = async () => {
    if (!parsed) return;
    setTesting(true);
    setTest(null);
    try {
      const r = await api.testConnection(parsed.host, parsed.port);
      setTest(r);
    } catch {
      setTest({ reachable: false, message: "Couldn't run the test." });
    } finally {
      setTesting(false);
    }
  };

  const create = async () => {
    if (!preset || !parsed) return;
    setStep(5);
    setCreating(true);
    try {
      const res = await api.createHost({
        name: preset.label.split(" ")[0] === "Custom" ? sub || "Service" : preset.label.split(" / ")[0],
        emoji: preset.emoji,
        domain: `${sub}.${base}`,
        forwardScheme: parsed.scheme,
        forwardHost: parsed.host,
        forwardPort: parsed.port,
        preset: preset.id,
        websockets: preset.websockets,
        http2: preset.http2,
        ssl,
        requireLogin: login,
        require2fa: twofa,
        countryLock: country,
        serverGroup: parsed.host,
        serverIp: parsed.host,
        enabled: true,
      });
      setApply(res.apply);
      await reload();
    } catch (e) {
      setApply({ ok: false, nginxAvailable: false, message: e instanceof Error ? e.message : "Failed to create service." });
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <div className="topbar">
        <h1>Expose a service</h1>
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost" onClick={() => navigate({ name: "dashboard" })}>
          <Icon.x />
          Cancel
        </button>
      </div>
      <div className="content">
        <div className="wizard-wrap">
          <Stepper step={step} />

          {step === 1 && (
            <div className="card wcard">
              <h2>What do you want to expose?</h2>
              <p className="wsub">Pick the app you're running — we'll apply the right settings automatically.</p>
              <div className="preset-grid">
                {presets.map((p) => (
                  <div
                    key={p.id}
                    className={`preset${preset?.id === p.id ? " selected" : ""}`}
                    onClick={() => setPreset(p)}
                  >
                    <div className="emoji">{p.emoji}</div>
                    <div className="pname">{p.label}</div>
                  </div>
                ))}
              </div>
              {preset && (
                <div className="info-line" style={{ marginTop: 14 }}>
                  <Icon.info />
                  {preset.notes}
                </div>
              )}
              <div className="wnav">
                <span />
                <button className="btn btn-primary" disabled={!preset} onClick={() => setStep(2)}>
                  Continue <Icon.arrowRight />
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="card wcard">
              <h2>Where does it live?</h2>
              <p className="wsub">Tell us the internal address of your {preset?.label} on your network.</p>
              <div className="field">
                <label>Your internal service</label>
                <input
                  className="input"
                  value={forward}
                  onChange={(e) => setForward(e.target.value)}
                  placeholder="e.g. http://192.168.1.50:32400"
                />
                <div className="hint">This stays on your network — only NginUX talks to it directly.</div>
              </div>
              <button className="btn" onClick={runTest} disabled={!parsed || testing}>
                {testing ? <span className="spinner" /> : <Icon.bolt />}
                {testing ? "Testing…" : "Test connection"}
              </button>
              {test && (
                <div className={`test-result ${test.reachable ? "ok" : "bad"}`}>
                  {test.reachable ? <Icon.check /> : <Icon.x />}
                  <div>{test.message}</div>
                </div>
              )}
              <div className="wnav">
                <button className="btn btn-ghost" onClick={() => setStep(1)}>
                  <Icon.arrowLeft /> Back
                </button>
                <button className="btn btn-primary" disabled={!parsed} onClick={() => setStep(3)}>
                  Continue <Icon.arrowRight />
                </button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="card wcard">
              <h2>What address should it have?</h2>
              <p className="wsub">Choose the web address people will use to reach it.</p>
              <div className="field">
                <label>Subdomain</label>
                <div className="input-group">
                  <input
                    className="input"
                    style={{ maxWidth: 200 }}
                    value={sub}
                    onChange={(e) => setSub(e.target.value.replace(/[^a-z0-9-]/gi, "").toLowerCase())}
                    placeholder="plex"
                    autoFocus
                  />
                  <input className="input" style={{ maxWidth: 200, color: "var(--text-dim)" }} value={`.${base}`} disabled />
                </div>
                <div className="hint">
                  Full address: <b style={{ color: "var(--text)" }}>https://{sub || "…"}.{base}</b>
                </div>
              </div>
              <div className="wnav">
                <button className="btn btn-ghost" onClick={() => setStep(2)}>
                  <Icon.arrowLeft /> Back
                </button>
                <button className="btn btn-primary" disabled={!sub} onClick={() => setStep(4)}>
                  Continue <Icon.arrowRight />
                </button>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="card wcard">
              <h2>Secure it</h2>
              <p className="wsub">We'll get a free HTTPS certificate automatically. Add a login to control access.</p>
              <Toggle on={ssl} set={setSsl} title="HTTPS encryption" desc="Free certificate, renewed automatically." icon={<Icon.lock />} />
              <Toggle on={login} set={setLogin} title="Require login to access this app" desc="Visitors sign in through NginUX before reaching the app." icon={<Icon.users />} />
              <Toggle on={twofa} set={setTwofa} title="Require 2FA (two-factor)" desc="A one-time code on top of the password." icon={<Icon.lock />} />
              <Toggle on={country} set={setCountry} title={`Only allow my country (${country2})`} desc="Block visitors from elsewhere. Your own devices are always allowed." icon={<Icon.globe />} />
              <div className="wnav">
                <button className="btn btn-ghost" onClick={() => setStep(3)}>
                  <Icon.arrowLeft /> Back
                </button>
                <button className="btn btn-primary" onClick={create}>
                  Create service <Icon.arrowRight />
                </button>
              </div>
            </div>
          )}

          {step === 5 && (
            <div className="card wcard">
              {creating ? (
                <div className="done-hero">
                  <span className="spinner" style={{ width: 28, height: 28 }} />
                  <h2 style={{ marginTop: 16 }}>Setting up {sub}.{base}…</h2>
                  <p className="wsub">Creating DNS, requesting the certificate, and applying config.</p>
                </div>
              ) : (
                <div className="done-hero">
                  <div className="done-check" style={{ background: apply?.ok ? "var(--green-soft)" : "var(--red-soft)" }}>
                    {apply?.ok ? <Icon.check /> : <Icon.x />}
                  </div>
                  <h2>{apply?.ok ? "You did it! 🎉" : "Something needs attention"}</h2>
                  <p className="wsub" style={{ marginBottom: 0 }}>{apply?.message}</p>
                  <div className="url-box">
                    🔒 https://{sub}.{base}
                  </div>
                  <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 8 }}>
                    <button className="btn btn-primary" onClick={() => navigate({ name: "dashboard" })}>
                      Go to dashboard
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Stepper({ step }: { step: number }) {
  return (
    <div className="stepper">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const cls = n < step ? "done" : n === step ? "active" : "";
        return (
          <div key={label} className={`step ${cls}`} style={{ flex: i < STEPS.length - 1 ? 1 : 0 }}>
            <div className="step-num">{n < step ? "✓" : n}</div>
            <div className="step-label">{label}</div>
            {i < STEPS.length - 1 && <div className={`step-line ${n < step ? "done" : ""}`} />}
          </div>
        );
      })}
    </div>
  );
}

function Toggle({
  on,
  set,
  title,
  desc,
  icon,
}: {
  on: boolean;
  set: (v: boolean) => void;
  title: string;
  desc: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="switch-row">
      <div className="sw-icon">{icon}</div>
      <div className="sw-text">
        <div className="t">{title}</div>
        <div className="d">{desc}</div>
      </div>
      <button className={`switch${on ? " on" : ""}`} onClick={() => set(!on)} />
    </div>
  );
}

function parseForward(value: string): { scheme: "http" | "https"; host: string; port: number } | null {
  let v = value.trim();
  let scheme: "http" | "https" = "http";
  const m = v.match(/^(https?):\/\//i);
  if (m) {
    scheme = m[1].toLowerCase() as "http" | "https";
    v = v.slice(m[0].length);
  }
  v = v.replace(/\/.*$/, "");
  const [host, portStr] = v.split(":");
  if (!host) return null;
  const port = Number(portStr ?? (scheme === "https" ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { scheme, host, port };
}
