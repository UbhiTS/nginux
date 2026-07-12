import type { FastifyInstance } from "fastify";
import type { RouteCtx } from "./context.ts";
import { applyUpdate, checkForUpdate, simulateStaleBuild, updateStatus } from "../update.ts";

// Self-update (admin only; agents have no tool for this on purpose).
export function registerUpdateRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  const { requireAdmin } = ctx;

  app.get("/api/update/status", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return updateStatus();
  });

  app.post("/api/update/check", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    // Dev-only escape hatch: ?simulate=1 marks the current build stale so the
    // update flow can be exercised without a real newer release.
    const simulate = (req.query as { simulate?: string }).simulate === "1";
    if (simulate && process.env.NODE_ENV !== "production") return simulateStaleBuild();
    return checkForUpdate();
  });

  app.post("/api/update/apply", async (req, reply) => {
    const admin = requireAdmin(req, reply);
    if (!admin) return;
    const result = await applyUpdate(admin.username);
    return reply.code(result.ok ? 200 : 422).send(result);
  });
}
