import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteCtx } from "./context.ts";
import { createProfile, deleteProfile, getProfile, listProfiles, profileInput, profilePatch, updateProfile } from "../profiles.ts";
import { getHost, updateHost } from "../repo.ts";
import { applyConfig } from "../nginx.ts";
import { snapshot } from "../versioning.ts";
import { syncGitOps } from "../gitops.ts";
import { logEvent } from "../auth.ts";
import { protocolSupportsHttpControls } from "../hostschema.ts";

// Security profiles: reusable named security bundles (admin/editor).
export function registerProfileRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  const { requireRole, currentUser, clientIp } = ctx;

  app.get("/api/security-profiles", async (req, reply) => requireRole(req, reply, "admin", "editor") ? listProfiles() : undefined);
  app.post("/api/security-profiles", async (req, reply) => {
    if (!requireRole(req, reply, "admin", "editor")) return;
    const parsed = profileInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const p = createProfile(parsed.data);
    logEvent({ type: "security.profile_created", severity: "notice", actor: currentUser(req)?.username ?? "admin", summary: `Created security profile "${p.name}"`, ip: clientIp(req), meta: { id: p.id } });
    return reply.code(201).send(p);
  });
  app.put("/api/security-profiles/:id", async (req, reply) => {
    if (!requireRole(req, reply, "admin", "editor")) return;
    const { id } = req.params as { id: string };
    const parsed = profileInput.partial().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const p = updateProfile(id, parsed.data);
    if (!p) return reply.code(404).send({ error: "Profile not found" });
    return p;
  });
  app.delete("/api/security-profiles/:id", async (req, reply) => {
    if (!requireRole(req, reply, "admin", "editor")) return;
    const { id } = req.params as { id: string };
    if (!deleteProfile(id)) return reply.code(400).send({ error: "That profile can't be deleted (built-in or not found)." });
    return { ok: true };
  });
  // Apply a profile's security fields to one or many services, with a single reload.
  app.post("/api/security-profiles/:id/apply", async (req, reply) => {
    if (!requireRole(req, reply, "admin", "editor")) return;
    const { id } = req.params as { id: string };
    const profile = getProfile(id);
    if (!profile) return reply.code(404).send({ error: "Profile not found" });
    const parsed = z.object({ ids: z.array(z.string().max(64)).min(1).max(500) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const unsupported = parsed.data.ids
      .map((hostId) => getHost(hostId))
      .filter((h) => h && !protocolSupportsHttpControls(h.protocol));
    if (unsupported.length) {
      return reply.code(400).send({
        error: `Security profiles use HTTP-only controls and cannot protect TCP/UDP/SNI passthrough (${unsupported.map((h) => h!.name).join(", ")}).`,
      });
    }
    const patch = profilePatch(profile);
    const actor = currentUser(req)?.username ?? "system";
    snapshot(`Before applying profile "${profile.name}"`, actor);
    const previous = new Map<string, NonNullable<ReturnType<typeof getHost>>>();
    let affected = 0;
    for (const hostId of parsed.data.ids) {
      const cur = getHost(hostId);
      if (cur && updateHost(hostId, patch)) {
        previous.set(hostId, cur);
        affected++;
      }
    }
    const apply = await applyConfig();
    if (!apply.ok && apply.nginxAvailable) {
      for (const [hostId, prev] of previous) updateHost(hostId, prev);
      await applyConfig();
      logEvent({ type: "host.update_failed", severity: "warn", actor, summary: `Reverted security profile "${profile.name}" - config rejected`, ip: clientIp(req), meta: { profile: profile.id, error: apply.message } });
      return reply.code(422).send({ error: apply.message, apply });
    }
    void syncGitOps(`Apply profile "${profile.name}" to ${affected} service(s)`);
    logEvent({ type: "host.updated", severity: "notice", actor, summary: `Applied profile "${profile.name}" to ${affected} service${affected === 1 ? "" : "s"}`, ip: clientIp(req), meta: { profile: profile.id, affected } });
    return { affected, apply };
  });
}
