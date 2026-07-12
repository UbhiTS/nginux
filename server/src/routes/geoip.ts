import type { FastifyInstance } from "fastify";
import type { RouteCtx } from "./context.ts";
import { deleteGeoipDb, downloadGeoipDb, geoipStatus, writeGeoipConf } from "../geoip.ts";
import { applyConfig } from "../nginx.ts";
import { logEvent } from "../auth.ts";

// GeoIP (country lock) database management.
export function registerGeoipRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  const { requireRole, currentUser, clientIp } = ctx;

  app.get("/api/geoip/status", async () => geoipStatus());

  app.post("/api/geoip/download", async (req, reply) => {
    if (!requireRole(req, reply, "admin", "editor")) return;
    let result: { sizeBytes: number };
    try {
      result = await downloadGeoipDb();
    } catch (e) {
      return reply.code(422).send({ error: e instanceof Error ? e.message : "Download failed." });
    }
    // Regenerate the geo config and validate it. If nginx rejects it, drop the DB
    // and restore the allow-all include so we never leave a broken config behind.
    writeGeoipConf();
    const apply = await applyConfig();
    if (!apply.ok && apply.nginxAvailable) {
      deleteGeoipDb();
      writeGeoipConf();
      await applyConfig();
      return reply.code(422).send({ error: `Database installed but nginx rejected the geo config: ${apply.message}` });
    }
    logEvent({ type: "geoip.updated", severity: "info", actor: currentUser(req)?.username ?? "system", summary: `Updated GeoIP database (${Math.round(result.sizeBytes / 1024)} KB)`, ip: clientIp(req), meta: {} });
    return { ok: true, status: geoipStatus() };
  });

  app.delete("/api/geoip", async (req, reply) => {
    if (!requireRole(req, reply, "admin", "editor")) return;
    deleteGeoipDb();
    writeGeoipConf();
    const apply = await applyConfig();
    logEvent({ type: "geoip.deleted", severity: "notice", actor: currentUser(req)?.username ?? "system", summary: "Removed GeoIP database", ip: clientIp(req), meta: {} });
    return { ok: true, apply };
  });
}
