import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteCtx } from "./context.ts";
import {
  createChannel, deleteChannel, listChannels, setChannelEnabled,
  setChannelRouting, testChannel, type ChannelType,
} from "../notify.ts";
import { assertSafeOutboundUrl, isDangerousHost } from "../validate.ts";
import { logEvent } from "../auth.ts";

// Notification channels (admin only) + per-channel severity routing.
export function registerChannelRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  const { requireAdmin, currentUser, clientIp } = ctx;

  app.get("/api/channels", async (req, reply) => requireAdmin(req, reply) ? listChannels() : undefined);
  app.post("/api/channels", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const parsed = z
      .object({
        type: z.enum(["ntfy", "gotify", "pushover", "discord", "slack", "telegram", "webhook", "email"]),
        name: z.string().min(1).max(64),
        config: z.record(z.string(), z.string().max(2048)).default({}),
        events: z.array(z.string().max(64)).max(50).default(["*"]),
        minSeverity: z.enum(["info", "notice", "warn", "danger"]).default("info"),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const body = parsed.data;
    // SSRF guard: any user-supplied destination URL must be a safe http(s) target.
    for (const key of ["url", "server"]) {
      const v = body.config[key];
      if (v) { try { assertSafeOutboundUrl(v); } catch (e) { return reply.code(400).send({ error: e instanceof Error ? e.message : "Invalid URL." }); } }
    }
    // The email channel connects to config.host:port directly (nodemailer), so it needs
    // the same link-local/metadata guard as the URL channels. (Security audit 2026-07-12.)
    if (body.type === "email" && body.config.host && isDangerousHost(body.config.host)) {
      return reply.code(400).send({ error: "That SMTP host is not allowed." });
    }
    const ch = createChannel({ type: body.type as ChannelType, name: body.name, config: body.config, events: body.events, minSeverity: body.minSeverity });
    logEvent({ type: "alert.channel_added", severity: "notice", actor: currentUser(req)?.username ?? "admin", summary: `Added ${body.type} notification channel "${body.name}"`, ip: clientIp(req), meta: {} });
    return reply.code(201).send(ch);
  });
  app.put("/api/channels/:id/enabled", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    setChannelEnabled(id, enabled);
    return { ok: true };
  });
  // Edit a channel's routing: which event types + the severity floor it alerts on.
  app.put("/api/channels/:id/routing", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const parsed = z.object({
      events: z.array(z.string().max(64)).max(50).optional(),
      minSeverity: z.enum(["info", "notice", "warn", "danger"]).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const ch = setChannelRouting(id, parsed.data);
    if (!ch) return reply.code(404).send({ error: "Channel not found" });
    return ch;
  });
  app.delete("/api/channels/:id", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    deleteChannel(id);
    return { ok: true };
  });
  app.post("/api/channels/:id/test", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    return testChannel(id);
  });
}
