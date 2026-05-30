import { useEffect, useRef, useState } from "react";
import {
  api,
  type AgentsOverview,
  type ApiToken,
  type Approval,
  type AuditEvent,
  type ToolDef,
  type Webhook,
} from "../api.ts";
import type { Settings } from "../types.ts";
import { Icon } from "../icons.tsx";

type Tab = "overview" | "mcp" | "safety" | "events";

const tier = (t: ToolDef["tier"] | Approval["tier"]) =>
  t === "read" ? { cls: "n", label: "Read-only" }
  : t === "low" ? { cls: "g", label: "Low" }
  : t === "medium" ? { cls: "y", label: "Medium" }
  : { cls: "r", label: "High" };

const ALL_SCOPES = ["read", "report", "control", "security"];

export function AgentsApi() {
  const [tab, setTab] = useState<Tab>("overview");
  const [ov, setOv] = useState<AgentsOverview | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [tools, setTools] = useState<ToolDef[]>([]);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);

  const load = () => {
    api.agentsOverview().then(setOv).catch(() => {});
    api.approvals().then(setApprovals).catch(() => {});
    api.tools().then(setTools).catch(() => {});
    api.tokens().then(setTokens).catch(() => {});
    api.audit("agent", 30).then(setEvents).catch(() => {});
    api.settings().then(setSettings).catch(() => {});
  };
  useEffect(load, []);

  const decide = async (id: string, ok: boolean) => {
    if (ok) await api.approve(id);
    else await api.deny(id);
    load();
  };

  const pending = approvals.filter((a) => a.status === "pending");
  const origin = location.origin;

  return (
    <>
      <div className="topbar">
        <h1>Agents &amp; API</h1>
        <span className="pill g"><span className="dot g" />MCP server running</span>
      </div>
      <div className="content">
        <div className="sectabs">
          <div className={`sectab${tab === "overview" ? " active" : ""}`} onClick={() => setTab("overview")}>Overview</div>
          <div className={`sectab${tab === "mcp" ? " active" : ""}`} onClick={() => setTab("mcp")}>MCP server</div>
          <div className={`sectab${tab === "safety" ? " active" : ""}`} onClick={() => setTab("safety")}>
            Permissions &amp; safety {pending.length > 0 && <span className="badge">{pending.length}</span>}
          </div>
          <div className={`sectab${tab === "events" ? " active" : ""}`} onClick={() => setTab("events")}>Events &amp; webhooks</div>
        </div>

        {tab === "overview" && ov && (
          <>
            <div className="card" style={{ marginBottom: 18, background: "linear-gradient(100deg, var(--accent-soft), transparent)" }}>
              <div className="card-pad" style={{ display: "flex", gap: 16, alignItems: "center" }}>
                <div style={{ width: 46, height: 46, borderRadius: 12, background: "var(--accent)", display: "grid", placeItems: "center", flexShrink: 0 }}>
                  <Icon.bot />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>NginUX speaks MCP natively</div>
                  <div className="muted" style={{ fontSize: 13, marginTop: 3 }}>
                    Point any agent at the endpoint below — it can manage your proxy with scopes, approvals, and a full audit trail.
                  </div>
                </div>
                <span className="mono" style={{ fontSize: 12 }}>{origin}/api/mcp</span>
              </div>
            </div>

            <div className="stats">
              <Stat label="Connected agents" value={ov.agents} />
              <Stat label="Tools exposed" value={ov.tools} />
              <Stat label="Pending approvals" value={ov.pendingApprovals} color={ov.pendingApprovals ? "var(--yellow)" : undefined} />
              <Stat label="Webhooks" value={ov.webhooks} />
            </div>

            {pending.length > 0 && (
              <ApprovalsCard pending={pending} decide={decide} />
            )}

            <div className="card" style={{ marginTop: 18 }}>
              <div className="card-head">Recent agent activity</div>
              <div className="atable">
                {events.slice(0, 8).map((e) => (
                  <div key={e.id} className="arow" style={{ gridTemplateColumns: "150px 1fr 130px" }}>
                    <div className="muted mono">{fmt(e.ts)}</div>
                    <div><b>{e.actor}</b> · {e.summary}</div>
                    <span className="pill n" style={{ justifySelf: "center" }}>{e.type.replace("agent.", "")}</span>
                  </div>
                ))}
                {events.length === 0 && <div className="placeholder"><p>No agent activity yet.</p></div>}
              </div>
            </div>
          </>
        )}

        {tab === "mcp" && (
          <McpTab tools={tools} tokens={tokens} reload={load} origin={origin} />
        )}

        {tab === "safety" && settings && (
          <SafetyTab pending={pending} decide={decide} settings={settings} onPolicy={async (v) => { await api.saveSettings({ agentAutoApprove: v }); setSettings({ ...settings, agentAutoApprove: v }); }} />
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

function ApprovalsCard({ pending, decide }: { pending: Approval[]; decide: (id: string, ok: boolean) => void }) {
  return (
    <div className="card">
      <div className="card-head">Pending approvals <span className="pill y">{pending.length}</span></div>
      {pending.map((a) => (
        <div key={a.id} className="arow" style={{ gridTemplateColumns: "84px 1fr auto", gap: 14 }}>
          <span className={`pill ${tier(a.tier).cls}`} style={{ justifySelf: "center" }}>{tier(a.tier).label}</span>
          <div><b>{a.agent}</b> wants to <span className="mono">{a.summary}</span></div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-sm btn-danger" onClick={() => decide(a.id, false)}>Deny</button>
            <button className="btn btn-sm btn-primary" onClick={() => decide(a.id, true)}>Approve</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function McpTab({ tools, tokens, reload, origin }: { tools: ToolDef[]; tokens: ApiToken[]; reload: () => void; origin: string }) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["read"]);
  const [trust, setTrust] = useState("untrusted");
  const [created, setCreated] = useState<string | null>(null);

  const create = async () => {
    if (!name) return;
    const r = await api.createToken(name, scopes, trust);
    setCreated(r.token);
    setName("");
    reload();
  };

  return (
    <>
      <div className="section-title">Endpoints</div>
      <div className="card card-pad" style={{ marginBottom: 18 }}>
        <Endpoint tag="HTTP" url={`${origin}/api/mcp`} note="streamable JSON-RPC" />
        <Endpoint tag="SSE" url={`${origin}/api/events/sse`} note="event stream" />
        <div className="info-line" style={{ marginTop: 6 }}>
          <Icon.lock /> Every endpoint needs a Bearer API token — agents never use 2FA.
        </div>
      </div>

      <div className="section-title">Drop-in config</div>
      <div className="code" style={{ marginBottom: 18 }}>{`{
  "mcpServers": {
    "nginux": {
      "url": "${origin}/api/mcp",
      "headers": { "Authorization": "Bearer ngx_••••" }
    }
  }
}`}</div>

      <div className="section-title">API tokens</div>
      <div className="card card-pad" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input className="input" style={{ maxWidth: 200 }} placeholder="token name" value={name} onChange={(e) => setName(e.target.value)} />
          {ALL_SCOPES.map((s) => (
            <label key={s} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12.5 }}>
              <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes((p) => e.target.checked ? [...p, s] : p.filter((x) => x !== s))} />
              {s}
            </label>
          ))}
          <select className="input" style={{ maxWidth: 130 }} value={trust} onChange={(e) => setTrust(e.target.value)}>
            <option value="untrusted">untrusted</option>
            <option value="trusted">trusted</option>
          </select>
          <button className="btn btn-primary btn-sm" onClick={create}>Create token</button>
        </div>
        {created && (
          <div className="test-result ok" style={{ marginTop: 12 }}>
            <Icon.check />
            <div>Copy this token now — it won't be shown again: <span className="mono" style={{ wordBreak: "break-all" }}>{created}</span></div>
          </div>
        )}
      </div>
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
            <button className="btn btn-ghost btn-sm" style={{ justifySelf: "end" }} onClick={async () => { await api.revokeToken(t.id); reload(); }}>Revoke</button>
          </div>
        ))}
      </div>

      <div className="section-title">Tool catalog</div>
      <div style={{ display: "flex", gap: 16, margin: "-4px 0 12px", fontSize: 11.5, color: "var(--text-dim)", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, color: "var(--text-faint)", textTransform: "uppercase", fontSize: 10.5 }}>Risk →</span>
        <span><span className="pill n">Read-only</span> always allowed</span>
        <span><span className="pill g">Low</span> auto-approves</span>
        <span><span className="pill y">Medium</span> trusted auto</span>
        <span><span className="pill r">High</span> always asks</span>
      </div>
      <div className="card">
        {tools.map((t) => (
          <div key={t.name} className="arow" style={{ gridTemplateColumns: "1.4fr 2fr 90px" }}>
            <div className="mono">{t.name}</div>
            <div className="muted">{t.description}</div>
            <span className={`pill ${tier(t.tier).cls}`} style={{ justifySelf: "center" }}>{tier(t.tier).label}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function SafetyTab({ pending, decide, settings, onPolicy }: { pending: Approval[]; decide: (id: string, ok: boolean) => void; settings: Settings; onPolicy: (v: boolean) => void }) {
  return (
    <>
      {pending.length > 0 ? <ApprovalsCard pending={pending} decide={decide} /> : (
        <div className="card"><div className="placeholder"><p>No actions are waiting for approval.</p></div></div>
      )}
      <div className="section-title" style={{ marginTop: 22 }}>Auto-approval policy</div>
      <div className="switch-row">
        <div className="sw-icon"><Icon.shield /></div>
        <div className="sw-text">
          <div className="t">Let trusted agents act without waiting</div>
          <div className="d">Low &amp; medium-risk tools auto-run for trusted agents. High-risk always needs a human. Read-only is always allowed.</div>
        </div>
        <button className={`switch${settings.agentAutoApprove ? " on" : ""}`} onClick={() => onPolicy(!settings.agentAutoApprove)} />
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
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [url, setUrl] = useState("");
  const seen = useRef(0);

  useEffect(() => {
    api.webhooks().then(setWebhooks).catch(() => {});
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
    if (!url) return;
    await api.createWebhook(url, ["*"]);
    setUrl("");
    api.webhooks().then(setWebhooks);
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
        <div style={{ display: "flex", gap: 10 }}>
          <input className="input" placeholder="https://your-endpoint/webhook" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button className="btn btn-primary btn-sm" onClick={addWebhook}>Add</button>
        </div>
        <div className="info-line" style={{ marginTop: 8 }}><Icon.info /> Deliveries are signed with an HMAC <span className="mono">X-NginUX-Signature</span> header.</div>
      </div>
      <div className="card atable">
        {webhooks.map((w) => (
          <div key={w.id} className="arow" style={{ gridTemplateColumns: "1.6fr 1fr 1.1fr 70px" }}>
            <div className="mono">{w.url}</div>
            <div className="muted">{w.events.join(", ")}</div>
            <div style={{ textAlign: "center" }}><span className="pill n">{w.lastStatus ?? "no deliveries"}</span></div>
            <button className="btn btn-ghost btn-sm" style={{ justifySelf: "end" }} onClick={async () => { await api.deleteWebhook(w.id); api.webhooks().then(setWebhooks); }}>Delete</button>
          </div>
        ))}
        {webhooks.length === 0 && <div className="placeholder"><p>No webhooks yet.</p></div>}
      </div>
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
