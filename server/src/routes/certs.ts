import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteCtx } from "./context.ts";
import { isHostname } from "../validate.ts";
import { applyConfig } from "../nginx.ts";
import { logEvent } from "../auth.ts";
import {
  AcmeError,
  deleteCert,
  getAcmeActivity,
  getCert,
  getCertDetails,
  importCertFiles,
  issue,
  listCerts,
  reconcileImportedCerts,
  setAutoRenew,
  type CertMethod,
} from "../certs.ts";

// Validate a :domain path param the same way everywhere: a hostname, length-bounded.
const domainParam = z.string().min(1).max(253).refine(isHostname, "Invalid domain.");

// Certificate lifecycle: list / ACME activity feed / issue / renew / auto-renew /
// import / details / delete. Every mutation re-applies nginx so the new (or removed)
// cert paths take effect immediately.
export function registerCertRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  const { requireRole, currentUser, clientIp } = ctx;

  app.get("/api/certificates", async (req, reply) => requireRole(req, reply, "admin", "editor") ? listCerts() : undefined);

  // Live ACME activity feed for the Certificates page - everything NginUX and
  // acme-client did while talking to Let's Encrypt, so failures aren't a black box.
  app.get("/api/acme/log", async (req, reply) => {
    if (!requireRole(req, reply, "admin", "editor")) return;
    const since = Number((req.query as { since?: string }).since ?? 0) || 0;
    return getAcmeActivity(since);
  });

  app.post("/api/certificates/:domain/issue", async (req, reply) => {
    if (!requireRole(req, reply, "admin", "editor")) return;
    const dp = domainParam.safeParse((req.params as { domain: string }).domain);
    if (!dp.success) return reply.code(400).send({ error: "Invalid domain." });
    const domain = dp.data;
    const { method } = z
      .object({ method: z.enum(["selfsigned", "http-01", "dns-01"]).default("selfsigned") })
      .parse(req.body ?? {});
    try {
      const cert = await issue(domain, method as CertMethod);
      await applyConfig(); // pick up the new cert paths
      logEvent({ type: "cert.issued", severity: "info", actor: currentUser(req)?.username ?? "system", summary: `Issued ${method} certificate for ${domain}`, ip: clientIp(req), meta: {} });
      return cert;
    } catch (e) {
      const kind = e instanceof AcmeError ? e.kind : "other";
      return reply.code(kind === "rate_limit" ? 429 : 422).send({ error: e instanceof Error ? e.message : "Issuance failed.", kind });
    }
  });

  app.post("/api/certificates/:domain/renew", async (req, reply) => {
    if (!requireRole(req, reply, "admin", "editor")) return;
    const dp = domainParam.safeParse((req.params as { domain: string }).domain);
    if (!dp.success) return reply.code(400).send({ error: "Invalid domain." });
    const domain = dp.data;
    const cert = getCert(domain);
    if (!cert) return reply.code(404).send({ error: "No certificate for that domain." });
    try {
      const next = await issue(domain, cert.method);
      await applyConfig();
      return next;
    } catch (e) {
      const kind = e instanceof AcmeError ? e.kind : "other";
      return reply.code(kind === "rate_limit" ? 429 : 422).send({ error: e instanceof Error ? e.message : "Renewal failed.", kind });
    }
  });

  app.put("/api/certificates/:domain/autorenew", async (req, reply) => {
    if (!requireRole(req, reply, "admin", "editor")) return;
    const dp = domainParam.safeParse((req.params as { domain: string }).domain);
    if (!dp.success) return reply.code(400).send({ error: "Invalid domain." });
    const { on } = z.object({ on: z.boolean() }).parse(req.body);
    setAutoRenew(dp.data, on);
    return getCert(dp.data);
  });

  app.post("/api/certificates/import", async (req, reply) => {
    if (!requireRole(req, reply, "admin", "editor")) return;
    const parsed = z.object({
      files: z.array(z.object({ path: z.string().max(1024), content: z.string().max(200_000) })).min(1).max(300),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid upload." });
    const result = importCertFiles(parsed.data.files);
    if (result.imported.length) {
      reconcileImportedCerts(); // register the new files in the DB
      await applyConfig();       // and have nginx start serving them
      logEvent({ type: "cert.imported", severity: "notice", actor: currentUser(req)?.username ?? "admin", summary: `Imported ${result.imported.length} certificate(s)`, ip: clientIp(req), meta: { domains: result.imported.map((i) => i.domain) } });
    }
    return result;
  });

  app.get("/api/certificates/:domain/details", async (req, reply) => {
    if (!requireRole(req, reply, "admin", "editor")) return;
    const dp = domainParam.safeParse((req.params as { domain: string }).domain);
    if (!dp.success) return reply.code(400).send({ error: "Invalid domain." });
    const details = getCertDetails(dp.data);
    if (!details) return reply.code(404).send({ error: "No certificate file for that domain yet." });
    return details;
  });

  app.delete("/api/certificates/:domain", async (req, reply) => {
    if (!requireRole(req, reply, "admin", "editor")) return;
    const dp = domainParam.safeParse((req.params as { domain: string }).domain);
    if (!dp.success) return reply.code(400).send({ error: "Invalid domain." });
    deleteCert(dp.data);
    // Re-apply so any host on this domain drops back to the bootstrap cert cleanly.
    const apply = await applyConfig();
    logEvent({ type: "cert.deleted", severity: "warn", actor: currentUser(req)?.username ?? "system", summary: `Deleted certificate for ${dp.data}`, ip: clientIp(req), meta: {} });
    return { ok: true, apply };
  });
}
