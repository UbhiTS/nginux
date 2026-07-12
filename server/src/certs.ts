import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { X509Certificate, createPrivateKey, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import forge from "node-forge";
import acme from "acme-client";
import { db, getSettings } from "./db.ts";
import { getDnsProvider, recordName } from "./dns.ts";
import { registrableDomain } from "./registrable.ts";
import { logEvent } from "./auth.ts";
import { applyConfig } from "./nginx.ts";
import { assertWithin } from "./validate.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CERT_DIR = process.env.CERT_DIR ?? join(__dirname, "..", "data", "certs");
const ACME_WEBROOT = process.env.ACME_WEBROOT ?? join(__dirname, "..", "data", "acme-webroot");
const RENEW_LEAD_DAYS = 30;

/** Generate an RSA key pair without blocking the event loop. node-forge runs the
 *  (expensive) generation in setImmediate-chunked steps when given a callback, so
 *  the server keeps serving requests while a cert is being minted. */
export function generateRsaKeyPair(bits = 2048): Promise<forge.pki.rsa.KeyPair> {
  return new Promise((resolve, reject) => {
    forge.pki.rsa.generateKeyPair({ bits }, (err, keypair) => {
      if (err) reject(err);
      else resolve(keypair);
    });
  });
}

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
/** Parse the stored SANs JSON, falling back to [domain] so one corrupt row can't
 *  throw out of listCerts() (which feeds renewal, notifications, and the UI). */
function parseSans(raw: unknown, domain: string): string[] {
  try { const a = JSON.parse(String(raw)); return Array.isArray(a) && a.length ? a.map(String) : [domain]; }
  catch { return [domain]; }
}
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
    sans: parseSans(r.sans, String(r.domain)),
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
  // Remove the on-disk key/cert too, so any host on this domain falls back to the
  // shared bootstrap cert on the next config apply instead of a dangling path.
  try {
    rmSync(assertWithin(CERT_DIR, join(CERT_DIR, domain)), { recursive: true, force: true });
  } catch {
    /* nothing to remove */
  }
}

export interface CertDetails {
  subject: string;
  issuer: string;
  serialNumber: string;
  fingerprintSha256: string;
  sans: string[];
  notBefore: string;
  notAfter: string;
  signatureAlgorithm: string;
  publicKey: string;
  selfSigned: boolean;
}

/** Parse the leaf of a fullchain PEM with node:crypto so we handle EC *and* RSA
 *  (node-forge can't read EC keys). Returns the human-facing fields, or null. */
interface LeafInfo extends CertDetails { subjectCN: string; staging: boolean; }
function parseLeaf(pem: string | Buffer): LeafInfo | null {
  let c: X509Certificate;
  try { c = new X509Certificate(pem); } catch { return null; }
  // Let's Encrypt staging signs with deliberately silly intermediate names
  // (e.g. "(STAGING) Ersatz Edamame E1" / org "(STAGING) Let's Encrypt").
  const staging = /staging|pretend|ersatz|counterfeit|doctored|bogus|wannabe|fake/i.test(c.issuer);
  const dn = (s: string, k: string) => (s.match(new RegExp(`(?:^|[,\\n])${k}=([^,\\n]+)`)) || [])[1]?.trim() ?? "";
  const subjectCN = dn(c.subject, "CN");
  const issuerCN = dn(c.issuer, "CN") || dn(c.issuer, "O");
  const sans = (c.subjectAltName ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^DNS:/, ""))
    .filter((s) => s && !s.includes(":"));
  const kt = c.publicKey.asymmetricKeyType;
  const det = (c.publicKey.asymmetricKeyDetails ?? {}) as { modulusLength?: number; namedCurve?: string };
  const publicKey = kt === "ec" ? `EC · ${det.namedCurve ?? "?"}` : kt === "rsa" ? `RSA · ${det.modulusLength ?? "?"}-bit` : (kt ?? "unknown");
  return {
    subjectCN,
    subject: subjectCN,
    issuer: issuerCN || "Unknown",
    serialNumber: (c.serialNumber || "").replace(/^0+/, "") || "0",
    fingerprintSha256: c.fingerprint256 ?? "",
    sans,
    notBefore: new Date(c.validFrom).toISOString(),
    notAfter: new Date(c.validTo).toISOString(),
    signatureAlgorithm: "", // node:crypto doesn't expose it; omitted in the UI
    publicKey,
    selfSigned: c.subject === c.issuer,
    staging,
  };
}

/** Parse the live cert file for a domain and surface the fields a human cares
 *  about. Returns null when no cert file exists (e.g. host on the bootstrap cert). */
export function getCertDetails(domain: string): CertDetails | null {
  const file = join(assertWithin(CERT_DIR, join(CERT_DIR, domain)), "fullchain.pem");
  if (!existsSync(file)) return null;
  const info = parseLeaf(readFileSync(file));
  if (!info) return null;
  const { subjectCN: _ignore, ...details } = info;
  return { ...details, subject: info.subjectCN || domain };
}

/** Register any cert files dropped into CERT_DIR (e.g. migrated from another
 *  proxy) into the DB so they show in the UI and can be managed/renewed. Runs at
 *  startup; skips domains whose DB record already matches the file's expiry. */
export function reconcileImportedCerts(): void {
  if (!existsSync(CERT_DIR)) return;
  for (const domain of readdirSync(CERT_DIR)) {
    const dir = join(CERT_DIR, domain);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    const fc = join(dir, "fullchain.pem"), pk = join(dir, "privkey.pem");
    if (!existsSync(fc) || !existsSync(pk)) continue;
    let info: LeafInfo | null;
    try { info = parseLeaf(readFileSync(fc)); } catch { continue; }
    if (!info) continue;
    const existing = getCert(domain);
    // Already tracked with the same expiry? Nothing to do.
    if (existing?.notAfter && Math.abs(Date.parse(existing.notAfter) - Date.parse(info.notAfter)) < 60_000) continue;
    const isLE = info.staging || (info.selfSigned ? false : /let'?s encrypt|^[ER]\d+$/i.test(info.issuer));
    upsertCert({
      domain,
      status: statusFromExpiry(new Date(info.notAfter)),
      issuer: info.selfSigned ? "Self-signed" : info.staging ? "Let's Encrypt (staging)" : isLE ? "Let's Encrypt" : info.issuer,
      method: info.selfSigned ? "selfsigned" : "http-01",
      notBefore: info.notBefore,
      notAfter: info.notAfter,
      sans: info.sans.length ? info.sans : [domain],
      wildcard: domain.startsWith("*.") || info.sans.some((s) => s.startsWith("*.")),
      lastError: null,
    });
    logEvent({ type: "cert.imported", severity: "info", actor: "system", summary: `Imported certificate for ${domain}`, ip: "", meta: { issuer: info.issuer } });
  }
}

function writeFiles(domain: string, keyPem: string, certPem: string) {
  const dir = assertWithin(CERT_DIR, join(CERT_DIR, domain));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "privkey.pem"), keyPem); // default perms so the data volume stays host-manageable (see commit 01f8ffa)
  writeFileSync(join(dir, "fullchain.pem"), certPem);
}

export interface ImportResult {
  imported: { domain: string; notAfter: string; staging: boolean }[];
  skipped: { name: string; reason: string }[];
}

/** Import uploaded PEM files. Files are grouped by their source folder (so a
 *  multi-domain upload pairs correctly); within each group we find the cert and
 *  its matching private key, read the domain from the cert, verify the key fits,
 *  and write them to /data/certs/<domain>/. */
export function importCertFiles(files: { path: string; content: string }[]): ImportResult {
  const imported: ImportResult["imported"] = [];
  const skipped: ImportResult["skipped"] = [];
  const groups = new Map<string, { path: string; content: string }[]>();
  for (const f of files) {
    const norm = f.path.replace(/\\/g, "/");
    const dir = norm.includes("/") ? norm.slice(0, norm.lastIndexOf("/")) : "";
    const arr = groups.get(dir) ?? [];
    arr.push(f);
    groups.set(dir, arr);
  }
  for (const [dir, gfiles] of groups) {
    const label = dir || gfiles[0]?.path || "upload";
    const certFile = gfiles.find((f) => /-----BEGIN CERTIFICATE-----/.test(f.content) && /fullchain|cert/i.test(f.path))
      ?? gfiles.find((f) => /-----BEGIN CERTIFICATE-----/.test(f.content));
    const keyFile = gfiles.find((f) => /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(f.content));
    if (!certFile || !keyFile) { skipped.push({ name: label, reason: "need both a certificate and a private key" }); continue; }
    let domain = "", info: LeafInfo | null = null, keyOk = false;
    try {
      const c = new X509Certificate(certFile.content);
      domain = (c.subject.match(/(?:^|[,\n])CN=([^,\n]+)/) || [])[1]?.trim() ?? "";
      keyOk = c.checkPrivateKey(createPrivateKey(keyFile.content));
      info = parseLeaf(certFile.content);
    } catch { skipped.push({ name: label, reason: "couldn't parse the certificate" }); continue; }
    // CN becomes a cert-dir path segment - reject traversal explicitly (writeFiles'
    // assertWithin is the backstop, but don't rely on it alone).
    if (!domain || !/^[a-z0-9.*-]+$/i.test(domain) || domain.includes("..")) { skipped.push({ name: label, reason: "no valid domain (CN) in the certificate" }); continue; }
    if (!keyOk) { skipped.push({ name: domain, reason: "the private key doesn't match the certificate" }); continue; }
    try {
      writeFiles(domain, keyFile.content, certFile.content);
      imported.push({ domain, notAfter: info?.notAfter ?? "", staging: info?.staging ?? false });
    } catch { skipped.push({ name: domain, reason: "couldn't save the certificate" }); }
  }
  return { imported, skipped };
}

function statusFromExpiry(notAfter: Date): CertStatus {
  const days = (notAfter.getTime() - Date.now()) / 86400_000;
  if (days < 0) return "expired";
  if (days < RENEW_LEAD_DAYS) return "expiring";
  return "valid";
}

// ---------- self-signed / internal CA (works offline) ----------
export async function issueSelfSigned(domain: string): Promise<Certificate> {
  const keys = await generateRsaKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = (() => { const b = randomBytes(16); b[0] &= 0x7f; if (b[0] === 0) b[0] = 1; return b.toString("hex"); })();
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

// How long a single ACME issuance may run before we give up (configurable).
// Generous on purpose - DNS-01 propagation can legitimately take 60-90s with some
// providers. We no longer retry timeouts, so this is one bounded attempt, not 3×.
const ACME_TIMEOUT_MS = Number(process.env.ACME_TIMEOUT_MS ?? 120000);
const ACCOUNT_KEY_PATH = join(CERT_DIR, "acme-account.key");

// ---------- ACME activity log (feeds the live panel on the Certificates page) ----------
export interface AcmeLogEntry {
  seq: number;
  ts: string;
  domain: string;
  level: "info" | "warn" | "error" | "debug";
  msg: string;
}
const ACME_LOG_MAX = 400;
const acmeActivity: AcmeLogEntry[] = [];
let acmeSeq = 0;
// Domains with an issuance in flight - tags the acme-client internal log lines.
const acmeInflight = new Set<string>();

export function acmeLog(domain: string, msg: string, level: AcmeLogEntry["level"] = "info"): void {
  acmeActivity.push({ seq: ++acmeSeq, ts: new Date().toISOString(), domain, level, msg });
  if (acmeActivity.length > ACME_LOG_MAX) acmeActivity.splice(0, acmeActivity.length - ACME_LOG_MAX);
}
/** Entries after `since` (a seq from a prior poll), plus whether anything is in flight. */
export function getAcmeActivity(since = 0): { entries: AcmeLogEntry[]; lastSeq: number; busy: boolean } {
  return { entries: acmeActivity.filter((e) => e.seq > since), lastSeq: acmeSeq, busy: acmeInflight.size > 0 };
}
// acme-client's internal trace (directory fetch, order status, challenge polls,
// retries) - exactly the play-by-play you want when issuance misbehaves.
acme.setLogger((msg) => {
  const tag = acmeInflight.size === 1 ? [...acmeInflight][0] : "acme";
  acmeLog(tag, msg, "debug");
});

/** A categorized ACME failure so the UI can decide whether a retry is worthwhile. */
export type AcmeErrorKind = "rate_limit" | "timeout" | "dns" | "unreachable" | "config" | "other";
export class AcmeError extends Error {
  kind: AcmeErrorKind;
  constructor(message: string, kind: AcmeErrorKind) { super(message); this.name = "AcmeError"; this.kind = kind; }
}

function classifyAcme(raw: string): { message: string; kind: AcmeErrorKind } {
  if (/rate ?limit|too many|tooManyRequests/i.test(raw))
    return { kind: "rate_limit", message: "Hit a Let's Encrypt rate limit. These reset after an hour (or longer for duplicate certificates) - wait before retrying, or switch on staging mode in Settings to test freely." };
  if (/timed? ?out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(raw))
    return { kind: "timeout", message: "Let's Encrypt didn't respond in time. It may be slow, rate-limiting, or your domain isn't reachable yet." };
  if (/dns|TXT|propagat/i.test(raw))
    return { kind: "dns", message: "Couldn't verify domain ownership via DNS yet - DNS may not have propagated, or the provider isn't connected in Settings." };
  if (/connection|unreachable|http-01|:80|\b404\b|refused/i.test(raw))
    return { kind: "unreachable", message: "Let's Encrypt couldn't reach this domain on port 80 - it must be publicly reachable (DNS pointed at your IP, port 80 forwarded) for HTTP validation." };
  if (/email|account|contact/i.test(raw))
    return { kind: "config", message: raw.split("\n")[0] };
  return { kind: "other", message: "Certificate issuance failed: " + raw.split("\n")[0] };
}

/** Reuse one ACME account key across issuances instead of registering a fresh
 *  account every time - repeated registrations are themselves rate-limited. */
async function acmeAccountKey(domain: string): Promise<Buffer> {
  if (existsSync(ACCOUNT_KEY_PATH)) {
    acmeLog(domain, "Using the existing ACME account key.");
    return readFileSync(ACCOUNT_KEY_PATH);
  }
  acmeLog(domain, "First issuance on this install - creating an ACME account key.");
  const key = await acme.crypto.createPrivateKey();
  mkdirSync(CERT_DIR, { recursive: true });
  writeFileSync(ACCOUNT_KEY_PATH, key); // default perms so the data volume stays host-manageable (see commit 01f8ffa)
  return key;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// ---------- Let's Encrypt (ACME) - runs with a reachable public domain ----------
export async function issueLetsEncrypt(domain: string, method: "http-01" | "dns-01"): Promise<Certificate> {
  const s = getSettings();
  if (!s.letsEncryptEmail) {
    acmeLog(domain, "No Let's Encrypt contact email configured - set one in Settings → Network & SSL.", "error");
    throw new AcmeError("Set a Let's Encrypt contact email in Settings first.", "config");
  }
  upsertCert({ domain, status: "pending", method, issuer: "Let's Encrypt" });

  const wildcard = domain.startsWith("*.");
  const directoryUrl = s.acmeStaging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production;
  acmeInflight.add(domain);
  acmeLog(domain, `Requesting a certificate via ${method.toUpperCase()} from ${s.acmeStaging ? "Let's Encrypt STAGING (test certs, relaxed rate limits)" : "Let's Encrypt production"}.`);
  acmeLog(domain, `ACME directory: ${directoryUrl}`, "debug");
  try {
    const client = new acme.Client({
      directoryUrl,
      accountKey: await acmeAccountKey(domain),
    });
    const [key, csr] = await acme.crypto.createCsr({ commonName: domain, altNames: [domain] });
    const dns = getDnsProvider();

    const certPem = await withTimeout(client.auto({
      csr,
      email: s.letsEncryptEmail,
      termsOfServiceAgreed: true,
      challengePriority: [method],
      challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
        if (challenge.type === "http-01") {
          mkdirSync(ACME_WEBROOT, { recursive: true });
          writeFileSync(join(ACME_WEBROOT, challenge.token), keyAuthorization);
          acmeLog(domain, `Challenge token staged - Let's Encrypt will fetch http://${domain.replace(/^\*\./, "")}/.well-known/acme-challenge/${challenge.token.slice(0, 12)}… (port 80 must reach this server).`);
        } else {
          // Derive the zone from the FQDN being issued (public-suffix aware) so
          // DNS-01 + wildcards work for ANY domain on this instance, not only the
          // one globally-configured baseDomain.
          const fqdn = domain.replace(/^\*\./, "");
          const zone = registrableDomain(fqdn);
          const rec = recordName(`_acme-challenge.${fqdn}`, zone);
          acmeLog(domain, `Creating DNS TXT record "${rec}" in zone ${zone} via ${s.dnsProvider} - waiting for it to propagate.`);
          await dns.upsertTxt(zone, rec, keyAuthorization);
        }
      },
      challengeRemoveFn: async (_authz, challenge) => {
        if (challenge.type === "dns-01") {
          acmeLog(domain, "Validation done - removing the DNS TXT record.", "debug");
          const fqdn = domain.replace(/^\*\./, "");
          const zone = registrableDomain(fqdn);
          await dns.removeTxt(zone, recordName(`_acme-challenge.${fqdn}`, zone));
        }
      },
    }), ACME_TIMEOUT_MS, "Let's Encrypt issuance");

    writeFiles(domain, key.toString(), certPem.toString());
    // Parse with node:crypto X509Certificate (EC-aware) - node-forge can't read
    // EC certs and would throw here, marking a SUCCESSFUL issuance as failed and
    // triggering rate-limit-burning retries. The cert is already on disk.
    const info = parseLeaf(certPem.toString());
    upsertCert({
      domain,
      status: info ? statusFromExpiry(new Date(info.notAfter)) : "valid",
      issuer: s.acmeStaging ? "Let's Encrypt (staging)" : "Let's Encrypt",
      method,
      notBefore: info?.notBefore ?? null,
      notAfter: info?.notAfter ?? null,
      sans: [domain],
      wildcard,
      lastError: null,
    });
    acmeLog(domain, `Certificate issued${info?.notAfter ? ` - valid until ${new Date(info.notAfter).toDateString()}` : ""}${s.acmeStaging ? " (staging - not browser-trusted)" : ""}. ✓`);
    logEvent({ type: "cert.issued", severity: "info", actor: "system", summary: `Let's Encrypt certificate for ${domain}`, ip: "", meta: { method } });
    return getCert(domain)!;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const { message, kind } = classifyAcme(raw);
    acmeLog(domain, message, "error");
    acmeLog(domain, `Detail: ${raw.split("\n")[0]}`, "debug");
    if (kind === "rate_limit") acmeLog(domain, "Rate-limit reference: https://letsencrypt.org/docs/rate-limits/", "warn");
    upsertCert({ domain, status: "error", lastError: message });
    logEvent({ type: "cert.failed", severity: "warn", actor: "system", summary: `Certificate failed for ${domain}`, ip: "", meta: { error: raw, kind } });
    throw new AcmeError(message, kind);
  } finally {
    acmeInflight.delete(domain);
  }
}

export async function issue(domain: string, method: CertMethod): Promise<Certificate> {
  return method === "selfsigned" ? await issueSelfSigned(domain) : issueLetsEncrypt(domain, method);
}

/** Ensure an SSL host has at least a self-signed cert so nginx can boot. */
export async function ensureCert(domain: string): Promise<void> {
  if (!getCert(domain) && !existsSync(join(CERT_DIR, domain, "fullchain.pem"))) {
    await issueSelfSigned(domain);
  }
}

/** Re-issue certs that are within the renewal lead window. */
export async function renewDue(): Promise<void> {
  let renewed = 0;
  for (const c of listCerts()) {
    if (!c.autoRenew || c.daysRemaining === null) continue;
    if (c.daysRemaining > RENEW_LEAD_DAYS) continue;
    if (c.method !== "selfsigned") acmeLog(c.domain, `Auto-renewal: ${c.daysRemaining} day${c.daysRemaining === 1 ? "" : "s"} left - renewing now.`);
    try {
      await issue(c.domain, c.method);
      renewed++;
    } catch {
      /* error already recorded on the cert */
    }
  }
  // issue() only writes the new cert/key to disk; nginx caches certs in memory and
  // won't serve the fresh one until reloaded. The manual renew paths apply config
  // themselves, but the background scheduler must too - otherwise an auto-renewed
  // cert sits unused on disk and the live cert can silently expire. Reload once,
  // outside the per-cert loop, so one failure doesn't skip the others.
  if (renewed > 0) {
    try { await applyConfig(); } catch { /* a failed reload is logged by applyConfig's callers; the certs are on disk */ }
  }
}

/** A "pending" cert with no cert file on disk and no expiry is a first-issuance
 *  attempt that was interrupted (container restart / OOM mid-ACME, before any
 *  cert was written). It would otherwise sit as an invisible dead state forever:
 *  the daily status refresh only runs `if (c.notAfter)`, reconcile skips it (no
 *  fullchain.pem), and renewDue skips it (daysRemaining is null). Flip it to
 *  "error" so it surfaces in the UI and is eligible for a manual re-issue.
 *  Returns how many rows were recovered. */
export function recoverStuckPending(): number {
  let recovered = 0;
  for (const c of listCerts()) {
    if (c.status !== "pending" || c.notAfter) continue; // mid-flight rows have an expiry; leave them
    if (existsSync(join(CERT_DIR, c.domain, "fullchain.pem"))) continue; // cert did land - reconcile will adopt it
    upsertCert({ domain: c.domain, status: "error", lastError: "Issuance was interrupted before a certificate was written. Re-issue to retry." });
    acmeLog(c.domain, "Previous issuance was interrupted before a certificate was written; marked as error. Re-issue to retry.", "error");
    recovered++;
  }
  return recovered;
}

export function startRenewalScheduler(): void {
  // check daily; also refresh status flags from expiry
  const tick = () => {
    try {
      recoverStuckPending(); // rescue certs orphaned in "pending" by an interrupted issuance
      for (const c of listCerts()) {
        if (c.notAfter) {
          const st = statusFromExpiry(new Date(c.notAfter));
          if (st !== c.status) db.prepare("UPDATE certificates SET status = ? WHERE domain = ?").run(st, c.domain);
        }
      }
      void renewDue();
    } catch {
      /* a transient DB error in one tick must not kill the daily interval */
    }
  };
  // Run once at startup so an interrupted issuance is rescued immediately, not up
  // to 24h later on the first daily tick.
  try { recoverStuckPending(); } catch { /* best effort; the daily tick retries */ }
  setInterval(tick, 24 * 3600_000).unref?.();
}

export { CERT_DIR };
