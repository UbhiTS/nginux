import type { FastifyInstance } from "fastify";
import type { RouteCtx } from "./context.ts";
import { decideApproval, listApprovals, toolCatalog } from "../tools.ts";
import { listTokens } from "../tokens.ts";
import { listWebhooks } from "../events.ts";

// Agent tool catalog, approval queue, and the agents overview counters.
export function registerAgentRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  const { requireAdmin, currentUser } = ctx;

  // Admin-only, matching its sibling routes: the catalog exposes every tool's schema
  // + tier + adminOnly flag (incl. security tools), which readonly/scoped users must
  // not enumerate. (Security audit 2026-07-12.)
  app.get("/api/agents/tools", async (req, reply) => { if (!requireAdmin(req, reply)) return; return toolCatalog(); });
  app.get("/api/agents/approvals", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { status } = req.query as { status?: string };
    return listApprovals(status);
  });
  app.post("/api/agents/approvals/:id/approve", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const ap = await decideApproval(id, true, currentUser(req)?.username ?? "admin");
    if (!ap) return reply.code(404).send({ error: "Approval not found" });
    return ap;
  });
  app.post("/api/agents/approvals/:id/deny", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const ap = await decideApproval(id, false, currentUser(req)?.username ?? "admin");
    if (!ap) return reply.code(404).send({ error: "Approval not found" });
    return ap;
  });
  app.get("/api/agents/overview", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return {
      agents: listTokens().length,
      tools: toolCatalog().length,
      pendingApprovals: listApprovals("pending").length,
      webhooks: listWebhooks().length,
    };
  });
}
