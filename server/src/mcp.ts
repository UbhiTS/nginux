import { listEvents, scopedAllows, securityExposure, securityOverview, listUsers } from "./auth.ts";
import { getTopology, listHosts } from "./repo.ts";
import { listCerts } from "./certs.ts";
import { listBans } from "./bans.ts";
import { summary as metricsSummary } from "./metrics.ts";
import { PRESETS } from "./presets.ts";
import { getSettings, redactSettings } from "./db.ts";
import { callTool, canCallTool, toolCatalogFor, type Principal } from "./tools.ts";
import type { Scope } from "./tokens.ts";
import { VERSION } from "./version.ts";

const PROTOCOL_VERSION = "2024-11-05";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

// Read-only resource views. Each carries the feature-scope a caller needs AND an
// optional adminOnly flag - the SAME gating (scope + adminOnly) as the equivalent
// read tool, enforced via canCallTool, so a resource can't be an RBAC bypass.
interface ResourceDef {
  uri: string;
  name: string;
  description: string;
  scope: Scope;
  adminOnly?: boolean;
  read: (p: Principal) => unknown;
}

function visibleHosts(p: Principal) {
  const hosts = listHosts();
  return p.kind === "user" && p.user.role === "scoped"
    ? hosts.filter((h) => scopedAllows(p.user, h))
    : hosts;
}

const RESOURCES: ResourceDef[] = [
  { uri: "hosts://list", name: "Host list", description: "All proxy hosts + state", scope: "read", read: (p) => visibleHosts(p) },
  { uri: "topology://current", name: "Network topology", description: "Servers, services and gateway", scope: "read", read: (p) => { const s = getSettings(); return getTopology({ publicIp: s.publicIp, gatewayIp: s.gatewayIp }, visibleHosts(p)); } },
  { uri: "presets://list", name: "App presets", description: "Built-in app presets", scope: "read", read: () => Object.values(PRESETS) },
  { uri: "settings://current", name: "Settings", description: "Instance settings (secrets redacted)", scope: "read", read: () => redactSettings(getSettings()) },
  { uri: "certificates://list", name: "Certificates", description: "All certificates + status", scope: "report", read: () => listCerts() },
  { uri: "config://current", name: "Config snapshot", description: "Hosts + certificates", scope: "report", read: (p) => ({ hosts: visibleHosts(p), certificates: listCerts() }) },
  { uri: "audit://recent", name: "Audit log", description: "Recent audit events", scope: "report", read: () => listEvents({ limit: 50 }) },
  { uri: "metrics://overview", name: "Security overview", description: "Posture score + counts", scope: "report", read: () => ({ overview: securityOverview(), exposure: securityExposure() }) },
  { uri: "metrics://traffic", name: "Traffic metrics", description: "Requests, bandwidth, top talkers", scope: "report", read: () => metricsSummary() },
  { uri: "bans://list", name: "IP bans", description: "Active IP bans", scope: "report", read: () => listBans() },
  { uri: "users://list", name: "Users", description: "Accounts (no secrets) - admin only", scope: "report", adminOnly: true, read: () => listUsers() },
];

const PROMPTS = [
  { name: "expose_service", description: "Expose a new internal service safely." },
  { name: "harden_host", description: "Review and tighten a host's security." },
  { name: "incident_response", description: "Investigate and respond to a security incident." },
  { name: "weekly_security_review", description: "Summarize the week's security posture." },
];

const ok = (id: JsonRpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0" as const, id, result });
const err = (id: JsonRpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0" as const, id, error: { code, message } });

/** Handle one MCP JSON-RPC message. Returns null for notifications (no reply). */
export async function handleMcp(principal: Principal, msg: JsonRpcRequest): Promise<object | null> {
  const { id, method, params = {} } = msg;

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "nginux", version: VERSION },
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notifications get no response

    case "ping":
      return ok(id, {});

    case "tools/list":
      // Only advertise tools this caller can actually invoke (scope + adminOnly).
      return ok(id, {
        tools: toolCatalogFor(principal).map((t) => ({
          name: t.name,
          description: `${t.description} [risk: ${t.tier}${t.adminOnly ? ", admin" : ""}]`,
          inputSchema: t.inputSchema,
        })),
      });

    case "tools/call": {
      const name = String(params.name);
      const args = (params.arguments as Record<string, unknown>) ?? {};
      const r = await callTool(principal, name, args);
      if (r.status === "error") {
        return ok(id, { content: [{ type: "text", text: r.message ?? "error" }], isError: true });
      }
      if (r.status === "pending_approval") {
        return ok(id, {
          content: [{ type: "text", text: `${r.message}\n(approvalId: ${r.approvalId})` }],
          isError: false,
          _meta: { status: "pending_approval", approvalId: r.approvalId, tier: r.tier },
        });
      }
      return ok(id, { content: [{ type: "text", text: JSON.stringify(r.result, null, 2) }], isError: false });
    }

    case "resources/list":
      // Only list resources the caller may actually read (scope + adminOnly),
      // so an admin-only resource isn't even advertised to a non-admin.
      return ok(id, {
        resources: RESOURCES.filter((r) => canCallTool(principal, r)).map((r) => ({
          uri: r.uri, name: r.name, description: r.description, mimeType: "application/json",
        })),
      });

    case "resources/read": {
      const uri = String(params.uri);
      const res = RESOURCES.find((r) => r.uri === uri);
      if (!res) return err(id, -32602, `Unknown resource: ${uri}`);
      // Enforce scope AND adminOnly (mirrors the equivalent read tool) - without
      // the adminOnly check a report-scoped editor could read users://list.
      if (!canCallTool(principal, res)) return err(id, -32603, `This caller may not read ${uri}.`);
      return ok(id, { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(res.read(principal), null, 2) }] });
    }

    case "prompts/list":
      return ok(id, { prompts: PROMPTS });

    default:
      return err(id, -32601, `Method not found: ${method}`);
  }
}
