import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteCtx } from "./context.ts";
import { createToken, listTokens, revokeToken } from "../tokens.ts";
import { logEvent } from "../auth.ts";

// Agent API tokens (admin only).
export function registerTokenRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  const { requireAdmin, currentUser, clientIp } = ctx;

  app.get("/api/tokens", async (req, reply) => requireAdmin(req, reply) ? listTokens() : undefined);
  app.post("/api/tokens", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = z
      .object({
        name: z.string().min(1).max(64),
        scopes: z.array(z.enum(["read", "report", "control", "security"])).min(1),
        trust: z.enum(["untrusted", "trusted"]).default("untrusted"),
      })
      .parse(req.body);
    const { token, record } = createToken(body);
    logEvent({ type: "agent.token_created", severity: "notice", actor: currentUser(req)?.username ?? "admin", summary: `Created API token "${body.name}"`, ip: clientIp(req), meta: { scopes: body.scopes } });
    return reply.code(201).send({ token, record }); // raw token shown once
  });
  app.delete("/api/tokens/:id", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    revokeToken(id);
    logEvent({ type: "token.revoked", severity: "notice", actor: currentUser(req)?.username ?? "admin", summary: `Revoked API token ${id}`, ip: clientIp(req), meta: { id } });
    return { ok: true };
  });
}
