import type { FastifyRequest, FastifyReply } from "fastify";
import type { Role, User } from "../auth.ts";

// The small set of request-scoped auth/identity helpers that route modules need.
// Defined once in index.ts (which owns the Fastify instance + the auth preHandler)
// and passed to each registerXRoutes(app, ctx) so a route group can live in its
// own file without re-implementing session/role resolution. Everything else a
// route needs (domain functions, zod, logEvent, validators) it imports directly.
export interface RouteCtx {
  currentUser: (req: FastifyRequest) => User | null;
  requireAdmin: (req: FastifyRequest, reply: FastifyReply) => User | null;
  requireRole: (req: FastifyRequest, reply: FastifyReply, ...roles: Role[]) => User | null;
  userRoleAtLeast: (req: FastifyRequest, reply: FastifyReply, ...roles: Role[]) => boolean;
  clientIp: (req: FastifyRequest) => string;
}

/** Clamp a caller-supplied `limit` query param to [1, 1000] (or undefined). Shared
 *  by the routes that page audit / log lists. */
export const clampLimit = (raw?: string): number | undefined =>
  raw ? Math.min(1000, Math.max(1, Number(raw) || 1)) : undefined;
