import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import forge from "node-forge";
import { db } from "./db.ts";
import { generateRsaKeyPair } from "./certs.ts";
import { assertWithin } from "./validate.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CERT_DIR = process.env.CERT_DIR ?? join(__dirname, "..", "data", "certs");

export interface ClientCert {
  id: string;
  hostId: string;
  name: string;
  serial: string;
  fingerprint: string;
  notAfter: string;
  createdAt: string;
}

export function clientCaPath(domain: string): string {
  return join(CERT_DIR, domain, "client-ca.crt");
}

/** Create the per-host client CA if it doesn't exist yet. */
export async function ensureClientCA(domain: string): Promise<void> {
  const dir = assertWithin(CERT_DIR, join(CERT_DIR, domain));
  const caCrt = join(dir, "client-ca.crt");
  if (existsSync(caCrt)) return;
  mkdirSync(dir, { recursive: true });

  const keys = await generateRsaKeyPair(2048);
  const ca = forge.pki.createCertificate();
  ca.publicKey = keys.publicKey;
  ca.serialNumber = "01" + Date.now().toString(16);
  ca.validity.notBefore = new Date();
  ca.validity.notAfter = new Date(Date.now() + 3650 * 86400_000);
  const attrs = [{ name: "commonName", value: `NginUX Client CA - ${domain}` }, { name: "organizationName", value: "NginUX" }];
  ca.setSubject(attrs);
  ca.setIssuer(attrs);
  ca.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true },
  ]);
  ca.sign(keys.privateKey, forge.md.sha256.create());
  writeFileSync(caCrt, forge.pki.certificateToPem(ca));
  writeFileSync(join(dir, "client-ca.key"), forge.pki.privateKeyToPem(keys.privateKey));
}

type Row = Record<string, unknown>;
const toCert = (r: Row): ClientCert => ({
  id: String(r.id), hostId: String(r.hostId), name: String(r.name), serial: String(r.serial),
  fingerprint: String(r.fingerprint), notAfter: String(r.notAfter), createdAt: String(r.createdAt),
});

export function listClientCerts(hostId: string): ClientCert[] {
  return (db.prepare("SELECT * FROM client_certs WHERE hostId = ? ORDER BY createdAt DESC").all(hostId) as Row[]).map(toCert);
}

export function revokeClientCert(id: string): boolean {
  return db.prepare("DELETE FROM client_certs WHERE id = ?").run(id).changes > 0;
}

/** Issue a client cert signed by the host's client CA. Returns PEM (shown once). */
export async function issueClientCert(hostId: string, domain: string, name: string): Promise<{ cert: string; key: string; record: ClientCert }> {
  await ensureClientCA(domain);
  const dir = assertWithin(CERT_DIR, join(CERT_DIR, domain));
  const caCert = forge.pki.certificateFromPem(readFileSync(join(dir, "client-ca.crt"), "utf8"));
  const caKey = forge.pki.privateKeyFromPem(readFileSync(join(dir, "client-ca.key"), "utf8"));

  const keys = await generateRsaKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  const serial = Date.now().toString(16);
  cert.serialNumber = serial;
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400_000);
  cert.setSubject([{ name: "commonName", value: name }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", clientAuth: true },
  ]);
  cert.sign(caKey, forge.md.sha256.create());

  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const fingerprint = forge.md.sha256.create().update(der).digest().toHex().match(/.{2}/g)!.join(":");

  const id = randomUUID();
  db.prepare(
    "INSERT INTO client_certs (id, hostId, name, serial, fingerprint, notAfter, createdAt) VALUES (?,?,?,?,?,?,?)",
  ).run(id, hostId, name, serial, fingerprint, cert.validity.notAfter.toISOString(), new Date().toISOString());

  return {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
    record: toCert(db.prepare("SELECT * FROM client_certs WHERE id = ?").get(id) as Row),
  };
}
