import { useEffect, useRef, useState } from "react";
import type { Route } from "../App.tsx";
import { api, type Certificate } from "../api.ts";
import type { ApplyResult, Preset, ProxyHost, Settings } from "../types.ts";
import { Icon } from "../icons.tsx";
import { ServiceIcon, iconUrlForSlug } from "../components/ServiceIcon.tsx";
import { Field } from "../components/Field.tsx";
import { Switch } from "../components/Switch.tsx";

type CertChoice = "existing" | "dns-01" | "http-01" | "selfsigned";
const MAX_CERT_ATTEMPTS = 3;

/** A delay that resolves after `ms`, ticks a countdown, and rejects (AbortError)
 *  if the signal fires - lets the user cancel a backoff wait. */
function cancellableWait(ms: number, signal: AbortSignal, onTick: (secs: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("aborted", "AbortError"));
    let remaining = Math.ceil(ms / 1000);
    onTick(remaining);
    const iv = setInterval(() => { remaining -= 1; onTick(Math.max(0, remaining)); }, 1000);
    const finish = (fn: () => void) => { clearInterval(iv); clearTimeout(to); signal.removeEventListener("abort", onAbort); fn(); };
    const to = setTimeout(() => finish(resolve), ms);
    const onAbort = () => finish(() => reject(new DOMException("aborted", "AbortError")));
    signal.addEventListener("abort", onAbort);
  });
}

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
  const [q, setQ] = useState(""); // app search on the picker step
  const [forward, setForward] = useState("http://192.168.1.50:32400");
  const [test, setTest] = useState<{ reachable: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [sub, setSub] = useState("");
  const [subTouched, setSubTouched] = useState(false); // stop auto-suggesting once the user types
  const [subError, setSubError] = useState<string | null>(null); // subdomain-in-use validation
  const [hosts, setHosts] = useState<ProxyHost[]>([]); // existing services, to catch a duplicate address
  const [createdHost, setCreatedHost] = useState<ProxyHost | null>(null); // the host just created (for the success actions)
  const subRef = useRef<HTMLInputElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null); // the app-catalog radiogroup (for roving focus)
  const [ssl, setSsl] = useState(true);
  const [advCert, setAdvCert] = useState(false);
  const [certMethod, setCertMethod] = useState<CertChoice>("dns-01");
  const [certs, setCerts] = useState<Certificate[]>([]);
  const [creating, setCreating] = useState(false);
  const [apply, setApply] = useState<ApplyResult | null>(null);
  const [certResult, setCertResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [certPhase, setCertPhase] = useState<"setup" | "issuing" | "backoff">("setup");
  const [certAttempt, setCertAttempt] = useState(0);
  const [retryIn, setRetryIn] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const base = settings?.baseDomain ?? "example.com";
  const hasDnsProvider = (settings?.dnsProvider ?? "none") !== "none";

  // Suggest the subdomain from the chosen app (e.g. Plex -> "plex", Immich ->
  // "immich"), and keep it in sync as they switch apps - until they type their own.
  const suggestSub = (p: Preset | null) => (p && p.id !== "custom" ? p.id.toLowerCase().replace(/[^a-z0-9-]/g, "") : "");
  useEffect(() => { if (!subTouched) setSub(suggestSub(preset)); }, [preset, subTouched]);

  useEffect(() => {
    api.presets().then((p) => {
      setPresets(p);
      setPreset(p.find((x) => x.id === "plex") ?? p[0]);
    });
    api.certificates().then(setCerts).catch(() => {});
    // Existing services - so we can reject a duplicate address on step 3 before
    // the server has to (and recover gracefully if it still 409s at create time).
    api.listHosts().then(setHosts).catch(() => {});
  }, []);

  // When a subdomain conflict bounces us back to step 3 (client- or server-side),
  // move focus to the field the user has to fix. Runs after the step-3 inputs mount.
  useEffect(() => {
    if (step === 3 && subError) subRef.current?.focus();
  }, [step, subError]);

  // Prefill the internal address with the selected app's usual scheme + port,
  // keeping whatever host the user has already typed (so picking Home Assistant
  // shows :8123, Proxmox shows https://…:8006, etc.).
  useEffect(() => {
    if (!preset) return;
    setForward((prev) => {
      const p = parseForward(prev);
      const host = p?.host ?? "192.168.1.50";
      return `${preset.forwardScheme ?? "http"}://${host}:${preset.defaultPort}`;
    });
  }, [preset]);

  const parsed = parseForward(forward);
  const domain = `${sub}.${base}`;
  const existingCert = sub ? certs.find((c) => c.domain === domain) ?? null : null;

  // Step 3 -> 4: block a subdomain that's already taken by another service and keep
  // the user on the address step (instead of erroring later on a step with no field).
  const goToSecure = () => {
    if (hosts.some((h) => h.domain === domain)) {
      setSubError(`${domain} is already in use - pick another subdomain.`);
      return;
    }
    setSubError(null);
    setStep(4);
  };

  // Smart default so the wizard always succeeds without scary failures:
  //  - reuse a cert that already exists for this exact domain, else
  //  - request a trusted Let's Encrypt cert ONLY if a DNS provider is connected
  //    (dns-01 can actually work), else
  //  - start on an instant self-signed cert (upgrade later from Certificates).
  // The user can still override under "Advanced".
  useEffect(() => {
    setCertMethod(existingCert ? "existing" : hasDnsProvider ? "dns-01" : "selfsigned");
  }, [domain, existingCert, hasDnsProvider]);

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

  // Issue a trusted cert with bounded attempts + exponential backoff. Transient
  // failures (timeout/dns) retry; a rate limit or unreachable host stops early.
  // The whole sequence is cancellable - the service is already live on self-signed.
  const issueWithRetry = async (host: string, method: "http-01" | "dns-01", signal: AbortSignal) => {
    for (let attempt = 1; attempt <= MAX_CERT_ATTEMPTS; attempt++) {
      setCertAttempt(attempt);
      setCertPhase("issuing");
      try {
        await api.issueCert(host, method, signal);
        setCertResult({ ok: true, message: "Trusted Let's Encrypt certificate installed." });
        return;
      } catch (e) {
        if (signal.aborted || (e as { name?: string })?.name === "AbortError") {
          setCertResult({ ok: false, message: "Cancelled - the service is live on a temporary self-signed certificate. Request a trusted one anytime from Certificates." });
          return;
        }
        const kind = (e as { kind?: string })?.kind ?? "other";
        const message = e instanceof Error ? e.message : "Certificate request failed.";
        // A timeout or unreachable host means a prerequisite is missing (port 80
        // closed, DNS not pointed/propagated) - a quick retry won't fix that, so
        // we stop and let them fix it and retry from Certificates. Only genuinely
        // transient failures retry.
        const retryable = kind === "dns" || kind === "other";
        if (!retryable || attempt === MAX_CERT_ATTEMPTS) {
          setCertResult({ ok: false, message });
          return;
        }
        setCertPhase("backoff");
        try {
          await cancellableWait(2000 * 2 ** (attempt - 1), signal, setRetryIn);
        } catch {
          setCertResult({ ok: false, message: "Cancelled - left on the self-signed certificate. Retry anytime from Certificates." });
          return;
        }
      }
    }
  };

  const create = async () => {
    if (!preset || !parsed) return;
    setApply(null);
    setCertResult(null);
    setCertAttempt(0);
    setCertPhase("setup");
    setCreatedHost(null);
    setStep(5);
    setCreating(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await api.createHost({
        name: preset.label.split(" ")[0] === "Custom" ? sub || "Service" : preset.label.split(" / ")[0],
        iconUrl: iconUrlForSlug(preset.icon),
        domain,
        forwardScheme: parsed.scheme,
        forwardHost: parsed.host,
        forwardPort: parsed.port,
        preset: preset.id,
        websockets: preset.websockets,
        http2: preset.http2,
        ssl,
        // Access controls (login / 2FA / country lock) are added afterwards from
        // the service's Protection settings - they can lock you out, so they're
        // a deliberate post-launch step, not part of "get it online".
        requireLogin: false,
        require2fa: false,
        countryLock: false,
        serverGroup: parsed.host,
        serverIp: parsed.host,
        enabled: true,
      });
      setApply(res.apply);
      setCreatedHost(res.host);
      setHosts((prev) => [...prev, res.host]); // keep the in-use list current for "Expose another"
      // Issue a trusted cert only when a Let's Encrypt method is chosen. "existing"
      // reuses the cert already on disk; "selfsigned" uses the bootstrap cert - both
      // need no issuance. A Let's Encrypt failure doesn't undo the service (it's live
      // on the self-signed bootstrap cert), so we surface it as a soft warning.
      if (ssl && (certMethod === "http-01" || certMethod === "dns-01")) {
        await issueWithRetry(domain, certMethod, ctrl.signal);
      }
      await reload();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to create service.";
      // A subdomain collision (server 409 "already in use") is a step-3 problem, not a
      // step-4 one - bounce back to the address field (an effect focuses it) so the
      // error lands where the fix is, instead of showing a domain error on a step with
      // no domain field.
      if (/in use|already exist|conflict|409|duplicate|taken/i.test(message)) {
        setApply(null);
        setSubError(`${domain} is already in use - pick another subdomain.`);
        setStep(3);
      } else {
        // The create failed for another reason (e.g. nginx rejected the config and the
        // host was rolled back). Drop back to the form so we don't show a green "Done",
        // and surface the reason there so they can adjust and retry.
        setApply({ ok: false, nginxAvailable: true, message });
        setStep(4);
      }
    } finally {
      setCreating(false);
      abortRef.current = null;
    }
  };

  // Reset back to a fresh run for "Expose another" on the success screen.
  const resetWizard = () => {
    setApply(null);
    setCertResult(null);
    setCertAttempt(0);
    setCertPhase("setup");
    setCreatedHost(null);
    setTest(null);
    setSubError(null);
    setSub("");
    setSubTouched(false);
    setPreset(presets.find((p) => p.id === "plex") ?? presets[0] ?? null);
    setStep(1);
  };

  // Stepper navigation: let the user click back to a completed step, but never skip
  // ahead past unfilled steps, and freeze it while creating / on the done screen.
  const goToStep = (n: number) => {
    if (creating || step === 5) return;
    if (n < step) { setSubError(null); setStep(n); }
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
          <Stepper step={step} goTo={goToStep} />

          {step === 1 && (() => {
            const term = q.trim().toLowerCase();
            // Custom is pinned at the top as a distinct "start blank" row, so keep it
            // out of the app grid/search to avoid showing it twice.
            const customP = presets.find((p) => p.id === "custom");
            const apps = presets.filter((p) => p.id !== "custom");
            const matches = apps.filter((p) => `${p.label} ${p.id} ${p.category} ${p.notes}`.toLowerCase().includes(term));
            const cats = [...new Set(apps.map((p) => p.category))]; // preset order is already category-grouped
            // Roving tabindex: exactly one tile in the radiogroup is Tab-reachable - the
            // selected app if it's visible, else the first tile - and arrow keys move
            // between them, so users don't Tab through ~90 items.
            const visible = term ? matches : apps;
            const activeId = preset && visible.some((p) => p.id === preset.id) ? preset.id : visible[0]?.id;
            const onTileKey = (e: React.KeyboardEvent<HTMLButtonElement>, p: Preset) => {
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPreset(p); return; }
              const nav = ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"];
              if (!nav.includes(e.key)) return;
              e.preventDefault();
              const radios = Array.from(gridRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? []);
              if (!radios.length) return;
              const cur = radios.indexOf(e.currentTarget);
              let next = cur < 0 ? 0 : cur;
              if (e.key === "ArrowRight" || e.key === "ArrowDown") next = Math.min(radios.length - 1, cur + 1);
              else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = Math.max(0, cur - 1);
              else if (e.key === "Home") next = 0;
              else if (e.key === "End") next = radios.length - 1;
              const el = radios[next];
              if (!el) return;
              el.focus();
              const np = presets.find((x) => x.id === el.getAttribute("data-preset-id"));
              if (np) setPreset(np);
            };
            const card = (p: Preset) => {
              const selected = preset?.id === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-preset-id={p.id}
                  tabIndex={p.id === activeId ? 0 : -1}
                  className={`preset${selected ? " selected" : ""}`}
                  style={{ font: "inherit", color: "inherit", width: "100%" }}
                  onClick={() => setPreset(p)}
                  onKeyDown={(e) => onTileKey(e, p)}
                >
                  <div className="emoji"><ServiceIcon iconUrl={iconUrlForSlug(p.icon)} size={28} /></div>
                  <div className="pname">{p.label}</div>
                </button>
              );
            };
            return (
              <div className="card wcard">
                <h2>What do you want to expose?</h2>
                <p className="wsub">Pick the app you're running - we'll apply the right settings. Not listed? Choose <b>Custom</b>.</p>
                <div className="search" style={{ maxWidth: "none", marginBottom: 14 }}>
                  <Icon.search />
                  <input placeholder="Search apps - Plex, Immich, Home Assistant…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
                </div>
                {customP && (
                  <div
                    className={`preset-pick${preset?.id === "custom" ? " selected" : ""}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => setPreset(customP)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPreset(customP); } }}
                  >
                    <div className="pp-emoji"><ServiceIcon iconUrl={iconUrlForSlug(customP.icon)} size={26} /></div>
                    <div className="pp-text">
                      <div className="pp-name">Custom / Generic</div>
                      <div className="pp-sub">Not in the list? Start from a blank service with sensible defaults.</div>
                    </div>
                    <Icon.arrowRight className="pp-arrow" />
                  </div>
                )}
                <div className="preset-scroll" ref={gridRef} role="radiogroup" aria-label="Choose an app to expose">
                  {term
                    ? matches.length
                      ? <div className="preset-grid">{matches.map(card)}</div>
                      : <div className="muted" style={{ fontSize: 13, padding: "10px 2px" }}>No match for “{q}”. Pick <b>Custom / Generic</b> and set it up manually.</div>
                    : cats.map((cat) => (
                        <div key={cat}>
                          <div className="preset-cat">{cat}</div>
                          <div className="preset-grid">{apps.filter((p) => p.category === cat).map(card)}</div>
                        </div>
                      ))}
                </div>
                {preset && (preset.id === "custom" || !term || matches.some((m) => m.id === preset.id)) && (
                  <div className="info-line" style={{ marginTop: 14, alignItems: "flex-start" }}>
                    <Icon.info />
                    <span>
                      <b>{preset.label}</b>
                      {preset.desc && <span style={{ display: "block", marginTop: 3 }}>{preset.desc}</span>}
                      {preset.notes && <span style={{ display: "block", color: "var(--text-dim)", marginTop: 3 }}>{preset.notes}</span>}
                    </span>
                  </div>
                )}
                <div className="wnav">
                  <span />
                  <button className="btn btn-primary" disabled={!preset} onClick={() => setStep(2)}>
                    Continue <Icon.arrowRight />
                  </button>
                </div>
              </div>
            );
          })()}

          {step === 2 && (
            <div className="card wcard">
              <h2>Where does it live?</h2>
              <p className="wsub">Tell us the internal address of your {preset?.label} on your network.</p>
              <Field label="Your internal service" hint="This stays on your network - only NginUX talks to it directly.">
                <input
                  className="input"
                  value={forward}
                  onChange={(e) => {
                    setForward(e.target.value);
                    // The previous result vouched for the OLD address - drop it so a stale
                    // green "reachable" banner can't keep endorsing an untested address.
                    setTest(null);
                  }}
                  placeholder="e.g. http://192.168.1.50:32400"
                />
              </Field>
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
                <label htmlFor="wizard-subdomain">Subdomain</label>
                <div className="input-group">
                  <input
                    id="wizard-subdomain"
                    ref={subRef}
                    className="input"
                    style={{ maxWidth: 200 }}
                    value={sub}
                    onChange={(e) => { setSub(e.target.value.replace(/[^a-z0-9-]/gi, "").toLowerCase()); setSubTouched(true); setSubError(null); }}
                    placeholder={suggestSub(preset) || "subdomain"}
                    aria-describedby="wizard-subdomain-hint"
                    aria-invalid={subError ? true : undefined}
                    autoFocus
                  />
                  <input className="input" style={{ maxWidth: 200, color: "var(--text-dim)" }} value={`.${base}`} disabled aria-hidden="true" tabIndex={-1} />
                </div>
                {subError && (
                  <div className="test-result bad" style={{ marginTop: 10 }}>
                    <Icon.x />
                    <div>{subError}</div>
                  </div>
                )}
                <div className="hint" id="wizard-subdomain-hint">
                  Full address: <b style={{ color: "var(--text)" }}>https://{sub || "…"}.{base}</b>
                </div>
              </div>
              <div className="wnav">
                <button className="btn btn-ghost" onClick={() => setStep(2)}>
                  <Icon.arrowLeft /> Back
                </button>
                <button className="btn btn-primary" disabled={!sub} onClick={goToSecure}>
                  Continue <Icon.arrowRight />
                </button>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="card wcard">
              <h2>Secure it</h2>
              <p className="wsub">We serve it over HTTPS and handle the certificate for you.</p>
              <Toggle on={ssl} set={setSsl} title="HTTPS encryption" desc="Free certificate, renewed automatically." icon={<Icon.lock />} />
              {ssl && (
                <>
                  <div className="info-line" style={{ marginTop: 14 }}>
                    <Icon.info />
                    {certMethod === "existing"
                      ? `Reuses the certificate already issued for ${domain}.`
                      : certMethod === "dns-01"
                      ? "We'll request a free, trusted Let's Encrypt certificate over DNS - no open ports needed."
                      : certMethod === "http-01"
                      ? `We'll request a trusted Let's Encrypt certificate over HTTP - needs port 80 reachable and public DNS for ${domain}.`
                      : "We'll start on an instant self-signed certificate (browsers show a warning). Connect a DNS provider in Settings for a trusted one automatically - or upgrade anytime from Certificates."}
                  </div>
                  <div className={`adv-toggle${advCert ? " open" : ""}`} style={{ marginTop: 10 }} onClick={() => setAdvCert((o) => !o)}>
                    <Icon.chevron className="chev" />
                    Advanced - choose certificate method
                  </div>
                  {advCert && (
                    <div style={{ marginTop: 10 }}>
                      <Field label="Certificate method">
                        <select className="input" value={certMethod} onChange={(e) => setCertMethod(e.target.value as CertChoice)}>
                          {existingCert && (
                            <option value="existing">Use existing - {existingCert.domain} ({existingCert.method === "selfsigned" ? "self-signed" : existingCert.issuer || "Let's Encrypt"})</option>
                          )}
                          {hasDnsProvider && <option value="dns-01">Let's Encrypt (DNS) - trusted, no open ports needed</option>}
                          <option value="http-01">Let's Encrypt (HTTP) - trusted, needs port 80 + public DNS</option>
                          <option value="selfsigned">Self-signed - instant, not trusted</option>
                        </select>
                      </Field>
                    </div>
                  )}
                </>
              )}
              <div className="info-line" style={{ marginTop: 16 }}>
                <Icon.lock />
                Login, 2FA and country restrictions live on the service's page - add them once it's running. The dashboard flags anything left unprotected.
              </div>
              {apply && !apply.ok && (
                <div className="test-result bad" style={{ marginTop: 14 }}>
                  <Icon.x />
                  <div>{apply.message}</div>
                </div>
              )}
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
                  <p className="wsub" style={{ marginBottom: certPhase === "setup" ? undefined : 14 }}>
                    {certPhase === "issuing"
                      ? `Requesting a trusted certificate from Let's Encrypt… (attempt ${certAttempt} of ${MAX_CERT_ATTEMPTS}). Give it up to ~45s, or cancel and keep the self-signed cert.`
                      : certPhase === "backoff"
                      ? `Let's Encrypt didn't answer - retrying in ${retryIn}s…`
                      : "Creating the service and applying the configuration."}
                  </p>
                  {(certPhase === "issuing" || certPhase === "backoff") && (
                    <button className="btn btn-ghost btn-sm" onClick={() => abortRef.current?.abort()}>
                      Cancel &amp; keep self-signed
                    </button>
                  )}
                </div>
              ) : (
                <div className="done-hero">
                  <div className="done-check" style={{ background: apply?.ok ? "var(--green-soft)" : "var(--red-soft)" }}>
                    {apply?.ok ? <Icon.check /> : <Icon.x />}
                  </div>
                  <h2>{apply?.ok ? "You did it! 🎉" : "Something needs attention"}</h2>
                  <p className="wsub" style={{ marginBottom: 0 }}>{apply?.message}</p>
                  {apply?.ok && certResult && (
                    <div className={`test-result ${certResult.ok ? "ok" : "bad"}`} style={{ justifyContent: "center", marginTop: 14, textAlign: "left" }}>
                      {certResult.ok ? <Icon.check /> : <Icon.alert />}
                      <div>
                        {certResult.ok
                          ? certResult.message
                          : `Live on a temporary self-signed certificate - couldn't get a trusted one yet: ${certResult.message} Retry from Certificates once the prerequisites are met.`}
                      </div>
                    </div>
                  )}
                  {apply?.ok && (
                    <a
                      className="url-box"
                      href={`https://${domain}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      style={{ color: "var(--text)", textDecoration: "none" }}
                    >
                      🔒 https://{sub}.{base}
                    </a>
                  )}
                  <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 8, flexWrap: "wrap" }}>
                    {apply?.ok && createdHost && (
                      <button className="btn btn-primary" onClick={() => navigate({ name: "host", hostId: createdHost.id })}>
                        <Icon.lock /> Set up protection
                      </button>
                    )}
                    <button className={apply?.ok ? "btn" : "btn btn-primary"} onClick={() => navigate({ name: "dashboard" })}>
                      Go to dashboard
                    </button>
                    {apply?.ok && (
                      <button className="btn btn-ghost" onClick={resetWizard}>
                        Expose another
                      </button>
                    )}
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

function Stepper({ step, goTo }: { step: number; goTo: (n: number) => void }) {
  const inlineFlex = { display: "flex", alignItems: "center", gap: 9 } as const;
  return (
    <div className="stepper">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const cls = n < step ? "done" : n === step ? "active" : "";
        const done = n < step;
        const body = (
          <>
            <div className="step-num">{done ? "✓" : n}</div>
            <div className="step-label">{label}</div>
          </>
        );
        return (
          <div
            key={label}
            className={`step ${cls}`}
            style={{ flex: i < STEPS.length - 1 ? 1 : 0 }}
            aria-current={n === step ? "step" : undefined}
          >
            {done ? (
              // Completed steps are clickable to jump back; future steps are not, so
              // the user can't skip ahead past a step they haven't filled in.
              <button
                type="button"
                onClick={() => goTo(n)}
                aria-label={`Back to step ${n}: ${label}`}
                style={{ ...inlineFlex, background: "none", border: "none", padding: 0, margin: 0, font: "inherit", color: "inherit", cursor: "pointer" }}
              >
                {body}
              </button>
            ) : (
              <div style={inlineFlex}>{body}</div>
            )}
            {i < STEPS.length - 1 && <div className={`step-line ${done ? "done" : ""}`} />}
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
      <Switch checked={on} onChange={set} label={title} />
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
