import { useEffect, useRef, useState } from "react";
import {
  api,
  type ApiToken,
  type Approval,
  type ToolDef,
  type Webhook,
} from "../api.ts";
import type { Settings } from "../types.ts";
import { Icon } from "../icons.tsx";
import { Field } from "../components/Field.tsx";
import { Switch } from "../components/Switch.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { useAsyncData } from "../hooks.ts";
import { copyText } from "../format.ts";

type Tab = "overview" | "mcp" | "safety" | "events";

const tier = (t: ToolDef["tier"] | Approval["tier"]) =>
  t === "read" ? { cls: "n", label: "Read-only" }
  : t === "low" ? { cls: "g", label: "Low" }
  : t === "medium" ? { cls: "y", label: "Medium" }
  : { cls: "r", label: "High" };

const ALL_SCOPES = ["read", "report", "control", "security"];

// Raw webhook delivery status -> a human label + pill colour. A bare "ok"/"error"/
// null told the user nothing; map them to plain words (and turn a test ping into a
// sentence) so the column reads like English.
function deliveryLabel(s: string | null): string {
  if (s == null) return "Not tested";
  if (s === "ok") return "Delivered";
  if (s === "error") return "Failed";
  if (s === "test:ok" || s === "Test: ok") return "Test delivery succeeded";
  if (s === "test:error") return "Test delivery failed";
  return s;
}
function deliveryPill(s: string | null): "g" | "r" | "n" {
  if (s === "ok" || s === "test:ok" || s === "Test: ok") return "g";
  if (s === "error" || s === "test:error") return "r";
  return "n";
}

function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="card card-pad">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton skeleton-row" />
      ))}
    </div>
  );
}

function ErrorNote({ message, onRetry }: { message: string | null; onRetry?: () => void }) {
  return (
    <div className="card">
      <div className="state-note error">
        <Icon.alert />
        <div>Couldn't load this data{message ? `: ${message}` : "."}</div>
        {onRetry && (
          <button type="button" className="btn btn-sm" onClick={onRetry}>Retry</button>
        )}
      </div>
    </div>
  );
}

export function AgentsApi({ tab: tabProp, setTab }: { tab?: string; setTab: (t: string) => void }) {
  // Active tab lives in the URL (#/agents/<tab>) so refresh / deep links keep it.
  const tab: Tab = (["overview", "mcp", "safety", "events"] as Tab[]).includes(tabProp as Tab) ? (tabProp as Tab) : "overview";

  // Overview + safety share one bundle (stats, approvals, activity, policy) so the
  // pending-approvals badge and both tabs stay in sync off a single load.
  const bundle = useAsyncData(async () => {
    const [ov, approvals, events, settings] = await Promise.all([
      api.agentsOverview(),
      api.approvals(),
      api.audit("agent", 30),
      api.settings(),
    ]);
    return { ov, approvals, events, settings };
  }, []);
  const data = bundle.data;
  const approvals: Approval[] = data?.approvals ?? [];
  const pending = approvals.filter((a) => a.status === "pending");
  const origin = location.origin;

  const decide = async (id: string, ok: boolean) => {
    if (ok) await api.approve(id);
    else await api.deny(id);
    bundle.reload();
  };

  return (
    <>
      <div className="topbar">
        <h1>Agents &amp; API</h1>
        <span className="pill g"><span className="dot g" />MCP server running</span>
      </div>
      <div className="content">
        <div className="sectabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "overview"} className={`sectab${tab === "overview" ? " active" : ""}`} onClick={() => setTab("overview")}>Overview</button>
          <button type="button" role="tab" aria-selected={tab === "mcp"} className={`sectab${tab === "mcp" ? " active" : ""}`} onClick={() => setTab("mcp")}>MCP server</button>
          <button type="button" role="tab" aria-selected={tab === "safety"} className={`sectab${tab === "safety" ? " active" : ""}`} onClick={() => setTab("safety")}>
            Permissions &amp; safety {pending.length > 0 && <span className="badge">{pending.length}</span>}
          </button>
          <button type="button" role="tab" aria-selected={tab === "events"} className={`sectab${tab === "events" ? " active" : ""}`} onClick={() => setTab("events")}>Events &amp; webhooks</button>
        </div>

        {tab === "overview" && (
          bundle.status === "loading" ? <ListSkeleton rows={4} />
          : bundle.status === "error" ? <ErrorNote message={bundle.error} onRetry={bundle.reload} />
          : data && (
            <>
              <div className="card" style={{ marginBottom: 18, background: "linear-gradient(100deg, var(--accent-soft), transparent)" }}>
                <div className="card-pad" style={{ display: "flex", gap: 16, alignItems: "center" }}>
                  <div style={{ width: 46, height: 46, borderRadius: 12, background: "var(--accent)", display: "grid", placeItems: "center", flexShrink: 0 }}>
                    <Icon.bot />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 16 }}>NginUX speaks MCP natively</div>
                    <div className="muted" style={{ fontSize: 13, marginTop: 3 }}>
                      Point any agent at the endpoint below - it can manage your proxy with scopes, approvals, and a full audit trail.
                    </div>
                  </div>
                  <span className="mono" style={{ fontSize: 12 }}>{origin}/api/mcp</span>
                </div>
              </div>

              <div className="stats">
                <Stat label="Connected agents" value={data.ov.agents} />
                <Stat label="Tools exposed" value={data.ov.tools} />
                <Stat label="Pending approvals" value={data.ov.pendingApprovals} color={data.ov.pendingApprovals ? "var(--yellow)" : undefined} />
                <Stat label="Webhooks" value={data.ov.webhooks} />
              </div>

              {pending.length > 0 && <ApprovalsCard pending={pending} decide={decide} />}

              <div className="card" style={{ marginTop: 18 }}>
                <div className="card-head">Recent agent activity</div>
                <div className="atable">
                  {data.events.slice(0, 8).map((e) => (
                    <div key={e.id} className="arow" style={{ gridTemplateColumns: "150px 1fr 130px" }}>
                      <div className="muted mono">{fmt(e.ts)}</div>
                      <div><b>{e.actor}</b> · {e.summary}</div>
                      <span className="pill n" style={{ justifySelf: "center" }}>{e.type.replace("agent.", "")}</span>
                    </div>
                  ))}
                  {data.events.length === 0 && (
                    <div className="state-note"><Icon.bot /><div>No agent activity yet.</div></div>
                  )}
                </div>
              </div>
            </>
          )
        )}

        {tab === "mcp" && <McpTab origin={origin} />}

        {tab === "safety" && (
          bundle.status === "loading" ? <ListSkeleton rows={3} />
          : bundle.status === "error" ? <ErrorNote message={bundle.error} onRetry={bundle.reload} />
          : data && (
            <SafetyTab
              pending={pending}
              decide={decide}
              settings={data.settings}
              onPolicy={async (v) => { await api.saveSettings({ agentAutoApprove: v }); bundle.reload(); }}
            />
          )
        )}

        {tab === "events" && <EventsTab origin={origin} />}
      </div>
    </>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value" style={{ color }}>{value}</div>
    </div>
  );
}

function ApprovalsCard({ pending, decide }: { pending: Approval[]; decide: (id: string, ok: boolean) => Promise<void> }) {
  // One decision at a time: `busyId` disables the pair mid-flight and, together with
  // the early return, guards decide() against a double-click re-entry that would
  // approve/deny twice. Failures surface instead of vanishing silently.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const act = async (id: string, ok: boolean) => {
    if (busyId) return;
    setBusyId(id);
    setErr(null);
    try {
      await decide(id, ok);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not record that decision.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="card">
      <div className="card-head">Pending approvals <span className="pill y">{pending.length}</span></div>
      {err && (
        <div role="alert" className="info-line" style={{ color: "var(--red)", padding: "0 var(--sp-4) var(--sp-2)" }}>
          <Icon.alert /> {err}
        </div>
      )}
      {pending.map((a) => (
        <div key={a.id} className="arow" style={{ gridTemplateColumns: "84px 1fr auto", gap: 14 }}>
          <span className={`pill ${tier(a.tier).cls}`} style={{ justifySelf: "center" }}>{tier(a.tier).label}</span>
          <div><b>{a.agent}</b> wants to <span className="mono">{a.summary}</span></div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-sm btn-danger" disabled={busyId !== null} onClick={() => act(a.id, false)}>
              {busyId === a.id ? <span className="spinner" /> : null}Deny
            </button>
            <button type="button" className="btn btn-sm btn-primary" disabled={busyId !== null} onClick={() => act(a.id, true)}>
              {busyId === a.id ? <span className="spinner" /> : null}Approve
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function McpTab({ origin }: { origin: string }) {
  const toolsAsync = useAsyncData(() => api.tools(), []);
  const tokensAsync = useAsyncData(() => api.tokens(), []);
  const tools = toolsAsync.data ?? [];
  const tokens = tokensAsync.data ?? [];

  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["read"]);
  const [trust, setTrust] = useState("untrusted");
  const [created, setCreated] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoke, setRevoke] = useState<ApiToken | null>(null);
  const [revBusy, setRevBusy] = useState(false);

  const create = async () => {
    if (!name || creating) return;
    setCreating(true);
    setCreateErr(null);
    try {
      const r = await api.createToken(name, scopes, trust);
      setCreated(r.token);
      setCopied(false);
      setName("");
      tokensAsync.reload();
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : "Could not create the token.");
    } finally {
      setCreating(false);
    }
  };

  const copyCreated = async () => {
    if (created && (await copyText(created))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  // Once minted, drop the real token straight into the config so it's copy-pasteable;
  // fall back to the masked placeholder before any token exists.
  const configBearer = created ?? "ngx_••••";

  return (
    <>
      <div className="section-title">Endpoints</div>
      <div className="card card-pad" style={{ marginBottom: 18 }}>
        <Endpoint tag="HTTP" url={`${origin}/api/mcp`} note="streamable JSON-RPC" />
        <Endpoint tag="SSE" url={`${origin}/api/events/sse`} note="event stream" />
        <div className="info-line" style={{ marginTop: 6 }}>
          <Icon.lock /> Every endpoint needs a Bearer API token - agents never use 2FA.
        </div>
      </div>

      <div className="section-title">Drop-in config</div>
      <div className="code" style={{ marginBottom: 18 }}>{`{
  "mcpServers": {
    "nginux": {
      "url": "${origin}/api/mcp",
      "headers": { "Authorization": "Bearer ${configBearer}" }
    }
  }
}`}</div>

      <div className="section-title">API tokens</div>
      <div className="card card-pad" style={{ marginBottom: 12 }}>
        <form onSubmit={(e) => { e.preventDefault(); create(); }} style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ maxWidth: 200 }}>
            <Field label="Token name">
              <input className="input" placeholder="e.g. claude-desktop" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          <fieldset style={{ border: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
            <legend className="overline" style={{ padding: 0 }}>Scopes</legend>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              {ALL_SCOPES.map((s) => (
                <label key={s} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12.5 }}>
                  <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes((p) => e.target.checked ? [...p, s] : p.filter((x) => x !== s))} />
                  {s}
                </label>
              ))}
            </div>
          </fieldset>
          <div style={{ maxWidth: 130 }}>
            <Field label="Trust">
              <select className="input" value={trust} onChange={(e) => setTrust(e.target.value)}>
                <option value="untrusted">untrusted</option>
                <option value="trusted">trusted</option>
              </select>
            </Field>
          </div>
          <button type="submit" className="btn btn-primary btn-sm" disabled={creating || !name}>
            {creating ? <span className="spinner" /> : null}Create token
          </button>
        </form>
        {createErr && (
          <div role="alert" className="info-line" style={{ marginTop: 10, color: "var(--red)" }}>
            <Icon.alert /> {createErr}
          </div>
        )}
        {created && (
          <div className="test-result ok" style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10 }}>
            <Icon.check />
            <div style={{ flex: 1 }}>Copy this token now - it won't be shown again: <span className="mono" style={{ wordBreak: "break-all" }}>{created}</span></div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={copyCreated}>{copied ? "Copied" : "Copy"}</button>
          </div>
        )}
      </div>

      {tokensAsync.status === "loading" ? <ListSkeleton rows={2} />
        : tokensAsync.status === "error" ? <ErrorNote message={tokensAsync.error} onRetry={tokensAsync.reload} />
        : (
          <div className="card atable" style={{ marginBottom: 18 }}>
            <div className="ahead" style={{ gridTemplateColumns: "1.3fr 1.4fr 0.8fr 0.9fr 90px" }}>
              <div>Token</div><div>Scopes</div><div style={{ textAlign: "center" }}>2FA</div><div style={{ textAlign: "center" }}>Trust</div><div />
            </div>
            {tokens.map((t) => (
              <div key={t.id} className="arow" style={{ gridTemplateColumns: "1.3fr 1.4fr 0.8fr 0.9fr 90px" }}>
                <div><b>{t.name}</b><div className="muted mono" style={{ fontSize: 11 }}>ngx_••••{t.prefix}</div></div>
                <div>{t.scopes.map((s) => <span key={s} className="pill n" style={{ marginRight: 4 }}>{s}</span>)}</div>
                <div style={{ textAlign: "center" }}><span className="pill n">not required</span></div>
                <div style={{ textAlign: "center" }}><span className={`pill ${t.trust === "trusted" ? "g" : "n"}`}>{t.trust}</span></div>
                <button type="button" className="btn btn-ghost btn-sm" style={{ justifySelf: "end" }} onClick={() => setRevoke(t)}>Revoke</button>
              </div>
            ))}
            {tokens.length === 0 && (
              <div className="state-note"><Icon.lock /><div>No API tokens yet. Create one above to connect an agent.</div></div>
            )}
          </div>
        )}

      <div className="section-title">Tool catalog</div>
      <div style={{ display: "flex", gap: 16, margin: "-4px 0 12px", fontSize: 11.5, color: "var(--text-dim)", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, color: "var(--text-faint)", textTransform: "uppercase", fontSize: 10.5 }}>Risk →</span>
        <span><span className="pill n">Read-only</span> always allowed</span>
        <span><span className="pill g">Low</span> auto-approves</span>
        <span><span className="pill y">Medium</span> trusted auto</span>
        <span><span className="pill r">High</span> always asks</span>
      </div>
      {toolsAsync.status === "loading" ? <ListSkeleton rows={3} />
        : toolsAsync.status === "error" ? <ErrorNote message={toolsAsync.error} onRetry={toolsAsync.reload} />
        : (
          <div className="card">
            {tools.map((t) => (
              <div key={t.name} className="arow" style={{ gridTemplateColumns: "1.4fr 2fr 90px" }}>
                <div className="mono">{t.name}</div>
                <div className="muted">{t.description}</div>
                <span className={`pill ${tier(t.tier).cls}`} style={{ justifySelf: "center" }}>{tier(t.tier).label}</span>
              </div>
            ))}
            {tools.length === 0 && (
              <div className="state-note"><Icon.bot /><div>No tools are exposed.</div></div>
            )}
          </div>
        )}

      {revoke && (
        <ConfirmDialog
          danger
          title={`Revoke ${revoke.name}?`}
          message={<>Any agent using <b>{revoke.name}</b> loses access immediately and can't reconnect with it. This can't be undone.</>}
          confirmLabel="Revoke token"
          busy={revBusy}
          onConfirm={async () => {
            setRevBusy(true);
            try {
              await api.revokeToken(revoke.id);
              setRevoke(null);
              tokensAsync.reload();
            } finally {
              setRevBusy(false);
            }
          }}
          onCancel={() => setRevoke(null)}
        />
      )}
    </>
  );
}

function SafetyTab({ pending, decide, settings, onPolicy }: { pending: Approval[]; decide: (id: string, ok: boolean) => Promise<void>; settings: Settings; onPolicy: (v: boolean) => void }) {
  return (
    <>
      {pending.length > 0 ? <ApprovalsCard pending={pending} decide={decide} /> : (
        <div className="card"><div className="state-note"><Icon.check /><div>No actions are waiting for approval.</div></div></div>
      )}
      <div className="section-title" style={{ marginTop: 22 }}>Auto-approval policy</div>
      <div className="switch-row">
        <div className="sw-icon"><Icon.shield /></div>
        <div className="sw-text">
          <div className="t" id="agent-autoapprove-label">Let trusted agents act without waiting</div>
          <div className="d">Low &amp; medium-risk tools auto-run for trusted agents. High-risk always needs a human. Read-only is always allowed.</div>
        </div>
        <Switch checked={!!settings.agentAutoApprove} onChange={onPolicy} labelledBy="agent-autoapprove-label" />
      </div>
      <div className="card card-pad">
        <div className="kv"><span className="k pol"><span className="pill n">Read-only</span> view config, status, metrics</span><span className="v muted">always allowed</span></div>
        <div className="kv"><span className="k pol"><span className="pill g">Low</span> reversible (ban, renew, reload)</span><span className="v muted">trusted → auto</span></div>
        <div className="kv"><span className="k pol"><span className="pill y">Medium</span> exposing (create/update host, DNS)</span><span className="v muted">trusted → auto</span></div>
        <div className="kv" style={{ border: "none" }}><span className="k pol"><span className="pill r">High</span> destructive (delete, disable login)</span><span className="v muted">always asks a human</span></div>
      </div>
    </>
  );
}

function EventsTab({ origin }: { origin: string }) {
  const [live, setLive] = useState<{ type: string; ts: string }[]>([]);
  const webhooksAsync = useAsyncData(() => api.webhooks(), []);
  const webhooks = webhooksAsync.data ?? [];
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [del, setDel] = useState<Webhook | null>(null);
  const [delBusy, setDelBusy] = useState(false);
  const seen = useRef(0);

  useEffect(() => {
    const es = new EventSource("/api/events/sse", { withCredentials: true });
    const onAny = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        setLive((p) => [{ type: data.type, ts: data.ts }, ...p].slice(0, 12));
      } catch { /* ignore */ }
    };
    // events arrive with custom `event:` names; listen broadly
    es.onmessage = onAny;
    ["agent.tool_called", "agent.approval_requested", "agent.approved", "login.success", "host.created", "cert.issued"].forEach((t) => es.addEventListener(t, onAny as EventListener));
    es.onerror = () => { seen.current++; };
    return () => es.close();
  }, []);

  const addWebhook = async () => {
    if (!url || adding) return;
    setAdding(true);
    setAddErr(null);
    try {
      await api.createWebhook(url, ["*"]);
      setUrl("");
      webhooksAsync.reload();
    } catch (e) {
      setAddErr(e instanceof Error ? e.message : "Could not add the webhook.");
    } finally {
      setAdding(false);
    }
  };

  return (
    <>
      <div className="section-title">Stream endpoints</div>
      <div className="card card-pad" style={{ marginBottom: 18 }}>
        <Endpoint tag="SSE" url={`${origin}/api/events/sse`} note="" />
        <div className="info-line" style={{ marginTop: 6 }}><Icon.lock /> Same Bearer token as MCP; events are filtered to the token's scopes.</div>
      </div>

      <div className="section-title">Live events</div>
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="atable">
          {live.length === 0 && <div className="placeholder"><p><span className="spinner" /> Listening… trigger an action (e.g. switch theme or call a tool) to see events.</p></div>}
          {live.map((e, i) => (
            <div key={i} className="arow" style={{ gridTemplateColumns: "160px 1fr" }}>
              <div className="muted mono">{fmt(e.ts)}</div>
              <div className="mono">{e.type}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="section-title">Outbound webhooks</div>
      <div className="card card-pad" style={{ marginBottom: 12 }}>
        <form onSubmit={(e) => { e.preventDefault(); addWebhook(); }} style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <Field label="Endpoint URL">
              <input className="input" placeholder="https://your-endpoint/webhook  or  syslog://siem.local:514" value={url} onChange={(e) => setUrl(e.target.value)} />
            </Field>
          </div>
          <button type="submit" className="btn btn-primary btn-sm" disabled={adding || !url}>
            {adding ? <span className="spinner" /> : null}Add
          </button>
        </form>
        {addErr && (
          <div role="alert" className="info-line" style={{ marginTop: 8, color: "var(--red)" }}>
            <Icon.alert /> {addErr}
          </div>
        )}
        <div className="info-line" style={{ marginTop: 8 }}><Icon.info /> HTTP deliveries are signed with an HMAC <span className="mono">X-NginUX-Signature</span> header. Use a <span className="mono">syslog://host:port</span> (or <span className="mono">syslog+tcp://</span>) URL to stream events to a SIEM.</div>
      </div>

      {webhooksAsync.status === "loading" ? <ListSkeleton rows={2} />
        : webhooksAsync.status === "error" ? <ErrorNote message={webhooksAsync.error} onRetry={webhooksAsync.reload} />
        : (
          <div className="card atable">
            {webhooks.map((w) => (
              <div key={w.id} className="arow" style={{ gridTemplateColumns: "1.6fr 1fr 1.1fr 70px" }}>
                <div className="mono">{w.url}</div>
                <div className="muted">{w.events.join(", ")}</div>
                <div style={{ textAlign: "center" }}><span className={`pill ${deliveryPill(w.lastStatus)}`}>{deliveryLabel(w.lastStatus)}</span></div>
                <button type="button" className="btn btn-ghost btn-sm" style={{ justifySelf: "end" }} onClick={() => setDel(w)}>Delete</button>
              </div>
            ))}
            {webhooks.length === 0 && (
              <div className="state-note"><Icon.globe /><div>No webhooks yet. Add one above to stream events out.</div></div>
            )}
          </div>
        )}

      {del && (
        <ConfirmDialog
          danger
          title="Delete webhook?"
          message={<>Events will stop being delivered to <span className="mono">{del.url}</span>. This can't be undone.</>}
          confirmLabel="Delete webhook"
          busy={delBusy}
          onConfirm={async () => {
            setDelBusy(true);
            try {
              await api.deleteWebhook(del.id);
              setDel(null);
              webhooksAsync.reload();
            } finally {
              setDelBusy(false);
            }
          }}
          onCancel={() => setDel(null)}
        />
      )}
    </>
  );
}

function Endpoint({ tag, url, note }: { tag: string; url: string; note: string }) {
  return (
    <div className="endpoint">
      <span className="tag">{tag}</span>
      <span className="url">{url}</span>
      {note && <span className="pill n">{note}</span>}
    </div>
  );
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
