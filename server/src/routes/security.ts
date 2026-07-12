import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type RouteCtx, clampLimit } from "./context.ts";
import { listEvents, securityExposure, securityOverview, logEvent } from "../auth.ts";
import { blockedAttempts } from "../metrics.ts";
import { activeAllowedCountries } from "../geoip.ts";
import { addBan, listBans, removeBan } from "../bans.ts";
import { isIpOrCidr } from "../validate.ts";

// Audit log, security posture, geo-block analytics, and manual IP bans.
export function registerSecurityRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  const { requireAdmin, requireRole, currentUser, clientIp } = ctx;

  // ---- audit + security posture ----
  app.get("/api/audit", async (req, reply) => {
    if (!requireRole(req, reply, "admin", "editor")) return;
    const { type, limit } = req.query as { type?: string; limit?: string };
    return listEvents({ type, limit: clampLimit(limit) });
  });
  app.get("/api/security/overview", async (req, reply) => requireRole(req, reply, "admin", "editor") ? securityOverview() : undefined);
  app.get("/api/security/exposure", async (req, reply) => requireRole(req, reply, "admin", "editor") ? securityExposure() : undefined);
  // Geo-block analytics: recent denied requests (auth / geo / IP / exploit / rate)
  // by country + top offending IPs, plus the current country allow-list. Admin/editor
  // (carries client IPs), matching the other security feeds.
  app.get("/api/security/blocked", async (req, reply) => {
    if (!requireRole(req, reply, "admin", "editor")) return undefined;
    return { ...blockedAttempts(12), allowedCountries: activeAllowedCountries() };
  });

  // ---- IP bans (fail2ban-style) ----
  app.get("/api/bans", async (req, reply) => requireRole(req, reply, "admin", "editor") ? listBans() : undefined);
  app.post("/api/bans", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const parsed = z.object({
      ip: z.string().refine(isIpOrCidr, "Must be a valid IP or CIDR."),
      reason: z.string().max(200).default("Manually banned"),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const { ip, reason } = parsed.data;
    const ban = addBan(ip, reason, "manual");
    logEvent({ type: "security.ip_banned", severity: "warn", actor: currentUser(req)?.username ?? "admin", summary: `Banned ${ip}`, ip: clientIp(req), meta: { source: "manual" } });
    return reply.code(201).send(ban);
  });
  app.delete("/api/bans/:ip", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { ip } = req.params as { ip: string };
    const ok = removeBan(decodeURIComponent(ip));
    if (ok) logEvent({ type: "security.ip_unbanned", severity: "info", actor: currentUser(req)?.username ?? "admin", summary: `Unbanned ${ip}`, ip: clientIp(req), meta: {} });
    return { ok };
  });
}
