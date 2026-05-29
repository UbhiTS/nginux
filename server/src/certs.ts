import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import forge from "node-forge";
import acme from "acme-client";
import { db, getSettings } from "./db.ts";
import { getDnsProvider, recordName } from "./dns.ts";
import { logEvent } from "./auth.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CERT_DIR = process.env.CERT_DIR ?? join(__dirname, "..", "data", "certs");
const ACME_WEBROOT = process.env.ACME_WEBROOT ?? join(__dirname, "..", "data", "acme-webroot");
const RENEW_LEAD_DAYS = 30;

export type CertMethod = "selfsigned" | "http-01" | "dns-01";
export type CertStatus = "valid" | "expiring" | "expired" | "pending" | "error" | "none";

export interface Certificate {
  domain: string;
  status: CertStatus;
  issuer: string;
  method: CertMethod;
  notBefore: string | null;
  notAfter: string | null;
  sans: string[];
  wildcard: boolean;
  autoRenew: boolean;
  lastError: string | null;
  daysRemaining: number | null;
  updatedAt: string;
}

type Row = Record<string, unknown>;
function toCert(r: Row): Certificate {
  const notAfter = r.notAfter ? String(r.notAfter) : null;
  const daysRemaining = notAfter
    ? Math.round((Date.parse(notAfter) - Date.now()) / 86400_000)
    : null;
  return {
    domain: String(r.domain),
    status: r.status as CertStatus,
    issuer: String(r.issuer),
    method: r.method as CertMethod,
    notBefore: r.notBefore ? String(r.notBefore) : null,
    notAfter,
    sans: JSON.parse(String(r.sans)),
    wildcard: !!r.wildcard,
    autoRenew: !!r.autoRenew,
    lastError: r.lastError ? String(r.lastError) : null,
    daysRemaining,
    updatedAt: String(r.updatedAt),
  };
}

export function listCerts(): Certificate[] {
  return (db.prepare("SELECT * FROM certificates ORDER BY domain").all() as Row[]).map(toCert);
}
export function getCert(domain: string): Certificate | null {
  const r = db.prepare("SELECT * FROM certificates WHERE domain = ?").get(domain) as Row | undefined;
  return r ? toCert(r) : null;
}

function upsertCert(c: Partial<Certificate> & { domain: string }) {
  const existing = getCert(c.domain);
  const merged = { ...existing, ...c } as Certificate;
  db.prepare(
    `INSERT INTO certificates (domain, status, issuer, method, notBefore, notAfter, sans, wildcard, autoRenew, lastError, updatedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(domain) DO UPDATE SET status=excluded.status, issuer=excluded.issuer, method=excluded.method,
       notBefore=excluded.notBefore, notAfter=excluded.notAfter, sans=excluded.sans, wildcard=excluded.wildcard,
       autoRenew=excluded.autoRenew, lastError=excluded.lastError, updatedAt=excluded.updatedAt`,
  ).run(
    merged.domain, merged.status ?? "none", merged.issuer ?? "", merged.method ?? "selfsigned",
    merged.notBefore ?? null, merged.notAfter ?? null, JSON.stringify(merged.sans ?? [merged.domain]),
    merged.wildcard ? 1 : 0, merged.autoRenew === false ? 0 : 1, merged.lastError ?? null,
    new Date().toISOString(),
  );
}

export function setAutoRenew(domain: string, on: boolean) {
  db.prepare("UPDATE certificates SET autoRenew = ? WHERE domain = ?").run(on ? 1 : 0, domain);
}
export function deleteCert(domain: string) {
  db.prepare("DELETE FROM certificates WHERE domain = ?").run(domain);
}

function writeFiles(domain: string, keyPem: string, certPem: string) {
  const dir = join(CERT_DIR, domain);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "privkey.pem"), keyPem);
  writeFileSync(join(dir, "fullchain.pem"), certPem);
}

function statusFromExpiry(notAfter: Date): CertStatus {
  const days = (notAfter.getTime() - Date.now()) / 86400_000;
  if (days < 0) return "expired";
  if (days < RENEW_LEAD_DAYS) return "expiring";
  return "valid";
}

// ---------- self-signed / internal CA (works offline) ----------
export function issueSelfSigned(domain: string): Certificate {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = Date.now().toString(16);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 825 * 86400_000);
  const attrs = [{ name: "commonName", value: domain }, { name: "organizationName", value: "NginUX" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "subjectAltName", altNames: [{ type: 2, value: domain }] },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  writeFiles(domain, forge.pki.privateKeyToPem(keys.privateKey), forge.pki.certificateToPem(cert));
  upsertCert({
    domain,
    status: statusFromExpiry(cert.validity.notAfter),
    issuer: "NginUX self-signed",
    method: "selfsigned",
    notBefore: cert.validity.notBefore.toISOString(),
    notAfter: cert.validity.notAfter.toISOString(),
    sans: [domain],
    lastError: null,
  });
  logEvent({ type: "cert.issued", severity: "info", actor: "system", summary: `Self-signed certificate for ${domain}`, ip: "", meta: { method: "selfsigned" } });
  return getCert(domain)!;
}

// ---------- Let's Encrypt (ACME) — runs with a reachable public domain ----------
export async function issueLetsEncrypt(domain: string, method: "http-01" | "dns-01"): Promise<Certificate> {
  const s = getSettings();
  if (!s.letsEncryptEmail) throw new Error("Set a Let's Encrypt contact email in Settings first.");
  upsertCert({ domain, status: "pending", method, issuer: "Let's Encrypt" });

  const wildcard = domain.startsWith("*.");
  try {
    const client = new acme.Client({
      directoryUrl: s.acmeStaging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production,
      accountKey: await acme.crypto.createPrivateKey(),
    });
    const [key, csr] = await acme.crypto.createCsr({ commonName: domain, altNames: [domain] });
    const dns = getDnsProvider();

    const certPem = await client.auto({
      csr,
      email: s.letsEncryptEmail,
      termsOfServiceAgreed: true,
      challengePriority: [method],
      challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
        if (challenge.type === "http-01") {
          mkdirSync(ACME_WEBROOT, { recursive: true });
          writeFileSync(join(ACME_WEBROOT, challenge.token), keyAuthorization);
        } else {
          await dns.upsertTxt(s.baseDomain, recordName(`_acme-challenge.${domain.replace(/^\*\./, "")}`, s.baseDomain), keyAuthorization);
        }
      },
      challengeRemoveFn: async (_authz, challenge) => {
        if (challenge.type === "dns-01") {
          await dns.removeTxt(s.baseDomain, recordName(`_acme-challenge.${domain.replace(/^\*\./, "")}`, s.baseDomain));
        }
      },
    });

    writeFiles(domain, key.toString(), certPem.toString());
    const parsed = forge.pki.certificateFromPem(certPem.toString());
    upsertCert({
      domain,
      status: statusFromExpiry(parsed.validity.notAfter),
      issuer: "Let's Encrypt",
      method,
      notBefore: parsed.validity.notBefore.toISOString(),
      notAfter: parsed.validity.notAfter.toISOString(),
      sans: [domain],
      wildcard,
      lastError: null,
    });
    logEvent({ type: "cert.issued", severity: "info", actor: "system", summary: `Let's Encrypt certificate for ${domain}`, ip: "", meta: { method } });
    return getCert(domain)!;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    upsertCert({ domain, status: "error", lastError: humanizeAcme(msg) });
    logEvent({ type: "cert.failed", severity: "warn", actor: "system", summary: `Certificate failed for ${domain}`, ip: "", meta: { error: msg } });
    throw new Error(humanizeAcme(msg));
  }
}

export async function issue(domain: string, method: CertMethod): Promise<Certificate> {
  return method === "selfsigned" ? issueSelfSigned(domain) : issueLetsEncrypt(domain, method);
}

/** Ensure an SSL host has at least a self-signed cert so nginx can boot. */
export function ensureCert(domain: string): void {
  if (!getCert(domain) && !existsSync(join(CERT_DIR, domain, "fullchain.pem"))) {
    issueSelfSigned(domain);
  }
}

/** Re-issue certs that are within the renewal lead window. */
export async function renewDue(): Promise<void> {
  for (const c of listCerts()) {
    if (!c.autoRenew || c.daysRemaining === null) continue;
    if (c.daysRemaining > RENEW_LEAD_DAYS) continue;
    try {
      await issue(c.domain, c.method);
    } catch {
      /* error already recorded on the cert */
    }
  }
}

export function startRenewalScheduler(): void {
  // check daily; also refresh status flags from expiry
  const tick = () => {
    for (const c of listCerts()) {
      if (c.notAfter) {
        const st = statusFromExpiry(new Date(c.notAfter));
        if (st !== c.status) db.prepare("UPDATE certificates SET status = ? WHERE domain = ?").run(st, c.domain);
      }
    }
    void renewDue();
  };
  setInterval(tick, 24 * 3600_000).unref?.();
}

function humanizeAcme(raw: string): string {
  if (/dns|TXT|propagat/i.test(raw)) return "Couldn't verify domain ownership via DNS yet — DNS may not have propagated, or the provider isn't connected.";
  if (/connection|timeout|unreachable|http-01|404/i.test(raw)) return "Let's Encrypt couldn't reach this domain on port 80 — it must be publicly reachable for HTTP validation.";
  if (/rate ?limit/i.test(raw)) return "Hit a Let's Encrypt rate limit. Try staging mode, or wait before retrying.";
  return "Certificate issuance failed: " + raw.split("\n")[0];
}

export { CERT_DIR };
