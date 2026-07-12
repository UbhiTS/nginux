import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteCtx } from "./context.ts";
import { createWebhook, deleteWebhook, listWebhooks } from "../events.ts";
import { isSyslogUrl, parseSyslogUrl } from "../syslog.ts";
import { assertSafeOutboundUrl, isDangerousHost } from "../validate.ts";
import { logEvent } from "../auth.ts";

// Outbound event webhooks (admin only). An http(s) sink is SSRF-guarded; a
// syslog:// sink (SIEM) validates its host separately.
export function registerWebhookRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  const { requireAdmin, currentUser, clientIp } = ctx;

  app.get("/api/webhooks", async (req, reply) => requireAdmin(req, reply) ? listWebhooks() : undefined);
  app.post("/api/webhooks", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const parsed = z.object({ url: z.string().min(1).max(2048), events: z.array(z.string().max(64)).max(50).default(["*"]) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    if (isSyslogUrl(parsed.data.url)) {
      const t = parseSyslogUrl(parsed.data.url);
      if (!t) return reply.code(400).send({ error: "Invalid syslog URL (expected syslog://host:port)." });
      if (isDangerousHost(t.host)) return reply.code(400).send({ error: "That destination host is not allowed." });
    } else {
      try { assertSafeOutboundUrl(parsed.data.url); }
      catch (e) { return reply.code(400).send({ error: e instanceof Error ? e.message : "Invalid URL." }); }
    }
    const { webhook, secret } = createWebhook(parsed.data.url, parsed.data.events);
    logEvent({ type: "webhook.created", severity: "notice", actor: currentUser(req)?.username ?? "admin", summary: `Created webhook → ${parsed.data.url}`, ip: clientIp(req), meta: { id: webhook.id, events: parsed.data.events } });
    return reply.code(201).send({ webhook, secret }); // secret shown once
  });
  app.delete("/api/webhooks/:id", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    deleteWebhook(id);
    logEvent({ type: "webhook.deleted", severity: "notice", actor: currentUser(req)?.username ?? "admin", summary: `Deleted webhook ${id}`, ip: clientIp(req), meta: { id } });
    return { ok: true };
  });
}
