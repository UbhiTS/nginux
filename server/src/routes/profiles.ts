import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteCtx } from "./context.ts";
import { createProfile, deleteProfile, getProfile, listProfiles, profileInput, profilePatch, updateProfile } from "../profiles.ts";
import { getHost, updateHost } from "../repo.ts";
import { applyConfig } from "../nginx.ts";
import { snapshot } from "../versioning.ts";
import { syncGitOps } from "../gitops.ts";
import { logEvent } from "../auth.ts";

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
    const patch = profilePatch(profile);
    const actor = currentUser(req)?.username ?? "system";
    snapshot(`Before applying profile "${profile.name}"`, actor);
    let affected = 0;
    for (const hostId of parsed.data.ids) { if (getHost(hostId) && updateHost(hostId, patch)) affected++; }
    const apply = await applyConfig();
    void syncGitOps(`Apply profile "${profile.name}" to ${affected} service(s)`);
    logEvent({ type: "host.updated", severity: "notice", actor, summary: `Applied profile "${profile.name}" to ${affected} service${affected === 1 ? "" : "s"}`, ip: clientIp(req), meta: { profile: profile.id, affected } });
    return { affected, apply };
  });
}
