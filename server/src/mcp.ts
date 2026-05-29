import { listEvents, securityOverview } from "./auth.ts";
import { listHosts } from "./repo.ts";
import { listCerts } from "./certs.ts";
import { callTool, toolCatalog, type Principal } from "./tools.ts";

const PROTOCOL_VERSION = "2024-11-05";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const RESOURCES = [
  { uri: "hosts://list", name: "Host list", description: "All proxy hosts + state", mimeType: "application/json" },
  { uri: "config://current", name: "Live config snapshot", description: "Current managed config", mimeType: "application/json" },
  { uri: "audit://recent", name: "Audit log", description: "Recent audit events", mimeType: "application/json" },
  { uri: "metrics://overview", name: "Security overview", description: "Posture score + counts", mimeType: "application/json" },
];

const PROMPTS = [
  { name: "expose_service", description: "Expose a new internal service safely." },
  { name: "harden_host", description: "Review and tighten a host's security." },
  { name: "incident_response", description: "Investigate and respond to a security incident." },
  { name: "weekly_security_review", description: "Summarize the week's security posture." },
];

function readResource(uri: string): unknown {
  switch (uri) {
    case "hosts://list": return listHosts();
    case "config://current": return { hosts: listHosts(), certificates: listCerts() };
    case "audit://recent": return listEvents({ limit: 50 });
    case "metrics://overview": return securityOverview();
    default: return null;
  }
}

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
        serverInfo: { name: "nginux", version: "0.1.0" },
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notifications get no response

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, {
        tools: toolCatalog().map((t) => ({
          name: t.name,
          description: `${t.description} [risk: ${t.tier}]`,
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
      return ok(id, { resources: RESOURCES });

    case "resources/read": {
      const uri = String(params.uri);
      const data = readResource(uri);
      if (data === null) return err(id, -32602, `Unknown resource: ${uri}`);
      return ok(id, { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }] });
    }

    case "prompts/list":
      return ok(id, { prompts: PROMPTS });

    default:
      return err(id, -32601, `Method not found: ${method}`);
  }
}
