import { randomUUID } from "node:crypto";
import { db, getSettings } from "./db.ts";
import { logEvent, securityExposure, securityOverview, type User } from "./auth.ts";
import { createHost, deleteHost, getHost, listHosts, updateHost } from "./repo.ts";
import { ensureCert, getCert, issue, listCerts } from "./certs.ts";
import { applyConfig } from "./nginx.ts";
import type { AgentPrincipal, Scope } from "./tokens.ts";
import { isHeaderName, isHost, isHostPort, isHostname, isIpOrCidr, isLocationPath } from "./validate.ts";
import type { NewProxyHost, ProxyHost } from "./types.ts";

// Agents reach updateHost/createHost WITHOUT the REST zod schema, so validate
// here too. Fields an agent may never set via tools (raw-config / managed).
const FORBIDDEN_TOOL_FIELDS = new Set(["id", "domain", "customNginx", "health", "certExpiresAt", "createdAt", "updatedAt"]);
const splitList = (s: string) => String(s).split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
const splitLines = (s: string) => String(s).split("\n").map((x) => x.trim()).filter(Boolean);

/** Strip forbidden fields and validate injection-prone ones; throws on bad input. */
function sanitizeHostPatch(raw: Record<string, unknown>): Partial<ProxyHost> {
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (FORBIDDEN_TOOL_FIELDS.has(k)) continue;
    patch[k] = v;
  }
  if (typeof patch.forwardHost === "string" && !isHost(patch.forwardHost)) throw new Error("Invalid forwardHost.");
  if (typeof patch.serverIp === "string" && patch.serverIp && !isHost(patch.serverIp)) throw new Error("Invalid serverIp.");
  for (const f of ["ipAllow", "ipDeny"]) {
    if (typeof patch[f] === "string" && !splitList(patch[f] as string).every(isIpOrCidr)) throw new Error(`Invalid ${f} entry.`);
  }
  if (typeof patch.upstreams === "string" && !splitLines(patch.upstreams as string).every(isHostPort)) throw new Error("Invalid upstreams entry.");
  if (typeof patch.customHeaders === "string" && !splitLines(patch.customHeaders as string).every((l) => { const i = l.indexOf(":"); return i > 0 && isHeaderName(l.slice(0, i).trim()) && !/[\n\r]/.test(l.slice(i + 1)); })) throw new Error("Invalid customHeaders.");
  if (typeof patch.pathRules === "string" && !splitLines(patch.pathRules as string).every((l) => { const [p, t, ...rest] = l.split(/\s+/); return rest.length === 0 && isLocationPath(p) && isHostPort(t); })) throw new Error("Invalid pathRules.");
  return patch as Partial<ProxyHost>;
}

export type Tier = "read" | "low" | "medium" | "high";
export type Principal = AgentPrincipal | { kind: "user"; name: string; scopes: Scope[]; user: User };

export interface Tool {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  tier: Tier;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
  summarize: (args: Record<string, unknown>) => string;
}

const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  required,
});

export const TOOLS: Record<string, Tool> = {
  list_services: {
    name: "list_services", title: "List services", scope: "read", tier: "read",
    description: "All proxy hosts with status, routes and protection.",
    inputSchema: obj({}), summarize: () => "list services",
    handler: () => listHosts(),
  },
  get_service: {
    name: "get_service", title: "Get a service", scope: "read", tier: "read",
    description: "Full detail for one host by id.",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    summarize: (a) => `get service ${a.id}`,
    handler: (a) => getHost(String(a.id)),
  },
  get_security_audit: {
    name: "get_security_audit", title: "Security audit", scope: "read", tier: "read",
    description: "What's exposed and the overall security posture/score.",
    inputSchema: obj({}), summarize: () => "security audit",
    handler: () => ({ overview: securityOverview(), exposure: securityExposure() }),
  },
  list_certificates: {
    name: "list_certificates", title: "List certificates", scope: "read", tier: "read",
    description: "All certificates with expiry, issuer and status.",
    inputSchema: obj({}), summarize: () => "list certificates",
    handler: () => listCerts(),
  },
  get_health: {
    name: "get_health", title: "Health check", scope: "read", tier: "read",
    description: "NginUX control-plane health.",
    inputSchema: obj({}), summarize: () => "health",
    handler: () => ({ status: "ok", time: new Date().toISOString() }),
  },
  issue_cert: {
    name: "issue_cert", title: "Issue/renew certificate", scope: "control", tier: "low",
    description: "Issue or renew a certificate (selfsigned | http-01 | dns-01).",
    inputSchema: obj({ domain: { type: "string" }, method: { type: "string", enum: ["selfsigned", "http-01", "dns-01"] } }, ["domain"]),
    summarize: (a) => `issue ${a.method ?? "selfsigned"} cert for ${a.domain}`,
    handler: async (a) => { const c = await issue(String(a.domain), (a.method as "selfsigned") ?? "selfsigned"); await applyConfig(); return c; },
  },
  renew_cert: {
    name: "renew_cert", title: "Renew certificate", scope: "control", tier: "low",
    description: "Renew an existing certificate using its current method.",
    inputSchema: obj({ domain: { type: "string" } }, ["domain"]),
    summarize: (a) => `renew cert for ${a.domain}`,
    handler: async (a) => { const cur = getCert(String(a.domain)); const c = await issue(String(a.domain), cur?.method ?? "selfsigned"); await applyConfig(); return c; },
  },
  create_service: {
    name: "create_service", title: "Expose a service", scope: "control", tier: "medium",
    description: "Create a proxy host (DNS-ready) and serve it over HTTPS.",
    inputSchema: obj({
      name: { type: "string" }, domain: { type: "string" }, forwardHost: { type: "string" },
      forwardPort: { type: "number" }, preset: { type: "string" }, requireLogin: { type: "boolean" },
    }, ["name", "domain", "forwardHost", "forwardPort"]),
    summarize: (a) => `expose ${a.name} at ${a.domain}`,
    handler: async (a) => {
      const domain = String(a.domain);
      const forwardHost = String(a.forwardHost);
      if (!isHostname(domain)) throw new Error("Invalid domain.");
      if (!isHost(forwardHost)) throw new Error("Invalid forwardHost.");
      const port = Number(a.forwardPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid forwardPort.");
      const host = createHost({
        name: String(a.name), emoji: "⚙️", domain,
        forwardScheme: "http", forwardHost, forwardPort: port,
        preset: String(a.preset ?? "custom"), websockets: false, http2: true, ssl: true,
        requireLogin: a.requireLogin !== false, require2fa: false, countryLock: false,
        serverGroup: forwardHost, serverIp: forwardHost, enabled: true,
      } as NewProxyHost);
      await ensureCert(host.domain);
      await applyConfig();
      return host;
    },
  },
  update_service: {
    name: "update_service", title: "Update a service", scope: "control", tier: "medium",
    description: "Edit a host's routing or options.",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    summarize: (a) => `update service ${a.id}`,
    handler: async (a) => { const { id, ...patch } = a; const h = updateHost(String(id), sanitizeHostPatch(patch)); await applyConfig(); return h; },
  },
  disable_login: {
    name: "disable_login", title: "Disable login on a host", scope: "security", tier: "high",
    description: "Remove the NginUX login gate — makes the host publicly reachable.",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    summarize: (a) => `disable login on service ${a.id}`,
    handler: async (a) => { const h = updateHost(String(a.id), { requireLogin: false, require2fa: false }); await applyConfig(); return h; },
  },
  delete_service: {
    name: "delete_service", title: "Delete a service", scope: "control", tier: "high",
    description: "Remove a host entirely (takes it offline).",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    summarize: (a) => `delete service ${a.id}`,
    handler: async (a) => { const ok = deleteHost(String(a.id)); await applyConfig(); return { ok }; },
  },
};

export function toolCatalog() {
  return Object.values(TOOLS).map((t) => ({
    name: t.name, title: t.title, description: t.description, scope: t.scope, tier: t.tier, inputSchema: t.inputSchema,
  }));
}

// ---------- approvals ----------
export interface Approval {
  id: string;
  ts: string;
  agent: string;
  tool: string;
  args: Record<string, unknown>;
  tier: Tier;
  summary: string;
  status: "pending" | "executed" | "denied";
  result: unknown;
  decidedBy: string | null;
  decidedAt: string | null;
}

type Row = Record<string, unknown>;
function toApproval(r: Row): Approval {
  return {
    id: String(r.id), ts: String(r.ts), agent: String(r.agent), tool: String(r.tool),
    args: JSON.parse(String(r.args)), tier: r.tier as Tier, summary: String(r.summary),
    status: r.status as Approval["status"], result: r.result ? JSON.parse(String(r.result)) : null,
    decidedBy: r.decidedBy ? String(r.decidedBy) : null, decidedAt: r.decidedAt ? String(r.decidedAt) : null,
  };
}

export function listApprovals(status?: string): Approval[] {
  const rows = status
    ? (db.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY ts DESC").all(status) as Row[])
    : (db.prepare("SELECT * FROM approvals ORDER BY ts DESC LIMIT 100").all() as Row[]);
  return rows.map(toApproval);
}

// ---------- dispatch ----------
export interface ToolResult {
  status: "ok" | "pending_approval" | "error";
  tool: string;
  tier?: Tier;
  result?: unknown;
  approvalId?: string;
  message?: string;
}

function needsApproval(tier: Tier, principal: Principal): boolean {
  if (tier === "read") return false;
  if (principal.kind === "user") return false; // a human in the UI is the approver
  if (tier === "high") return true; // never auto-approve destructive
  const policy = getSettings().agentAutoApprove;
  if (!policy) return true;
  if (principal.trust !== "trusted") return true; // only trusted agents auto-run
  return false; // low/medium for a trusted agent auto-runs
}

export async function callTool(principal: Principal, name: string, rawArgs: Record<string, unknown>): Promise<ToolResult> {
  const tool = TOOLS[name];
  if (!tool) return { status: "error", tool: name, message: `Unknown tool: ${name}` };
  if (!principal.scopes.includes(tool.scope)) {
    return { status: "error", tool: name, message: `This token lacks the "${tool.scope}" scope needed for ${name}.` };
  }
  const args = rawArgs ?? {};

  if (needsApproval(tool.tier, principal)) {
    const id = randomUUID();
    const summary = tool.summarize(args);
    db.prepare(
      "INSERT INTO approvals (id, ts, agent, tool, args, tier, summary, status) VALUES (?,?,?,?,?,?,?, 'pending')",
    ).run(id, new Date().toISOString(), principal.name, name, JSON.stringify(args), tool.tier, summary);
    logEvent({ type: "agent.approval_requested", severity: "notice", actor: principal.name, summary: `Wants to ${summary}`, ip: "", meta: { tool: name, tier: tool.tier, approvalId: id } });
    return { status: "pending_approval", tool: name, tier: tool.tier, approvalId: id, message: `Queued for human approval: ${summary}` };
  }

  try {
    const result = await tool.handler(args);
    logEvent({ type: "agent.tool_called", severity: "info", actor: principal.name, summary: tool.summarize(args), ip: "", meta: { tool: name, tier: tool.tier } });
    return { status: "ok", tool: name, tier: tool.tier, result };
  } catch (err) {
    return { status: "error", tool: name, message: err instanceof Error ? err.message : "Tool failed." };
  }
}

export async function decideApproval(id: string, approve: boolean, decidedBy: string): Promise<Approval | null> {
  const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Row | undefined;
  if (!row) return null;
  const ap = toApproval(row);
  if (ap.status !== "pending") return ap;

  if (!approve) {
    db.prepare("UPDATE approvals SET status='denied', decidedBy=?, decidedAt=? WHERE id=?").run(decidedBy, new Date().toISOString(), id);
    logEvent({ type: "agent.approval_denied", severity: "notice", actor: decidedBy, summary: `Denied: ${ap.summary}`, ip: "", meta: { tool: ap.tool } });
    return toApproval(db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Row);
  }

  const tool = TOOLS[ap.tool];
  let result: unknown = null;
  try {
    result = tool ? await tool.handler(ap.args) : { error: "tool no longer exists" };
  } catch (err) {
    result = { error: err instanceof Error ? err.message : "execution failed" };
  }
  db.prepare("UPDATE approvals SET status='executed', result=?, decidedBy=?, decidedAt=? WHERE id=?").run(
    JSON.stringify(result), decidedBy, new Date().toISOString(), id,
  );
  logEvent({ type: "agent.approved", severity: "notice", actor: decidedBy, summary: `Approved: ${ap.summary}`, ip: "", meta: { tool: ap.tool } });
  return toApproval(db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Row);
}
