import { randomBytes, randomUUID } from "node:crypto";
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
  revokedAt: string | null;
}

/** A random, even-length, positive (high bit clear) serial. Even-length + high
 *  bit clear means the cert and the CRL encode the exact same ASN.1 INTEGER
 *  bytes (so CRL matching works), and ≥120 bits of entropy hardens against
 *  serial-prediction. */
function randomSerial(): string {
  const b = randomBytes(16);
  b[0] &= 0x7f;
  if (b[0] === 0) b[0] = 1;
  return b.toString("hex");
}

export function clientCaPath(domain: string): string {
  return join(CERT_DIR, domain, "client-ca.crt");
}

export function clientCrlPath(domain: string): string {
  return join(CERT_DIR, domain, "client-ca.crl");
}

/** Build a signed X.509 v2 CRL (node-forge has no CRL builder, so we assemble
 *  the ASN.1 by hand and sign it with the CA key). The output is validated to
 *  parse and verify against the CA by OpenSSL — i.e. nginx's `ssl_crl` accepts it. */
function buildCrlPem(caCertPem: string, caKeyPem: string, revoked: { serial: string; date: Date }[]): string {
  const { asn1 } = forge;
  const { Type, Class } = asn1;
  const caCert = forge.pki.certificateFromPem(caCertPem);
  const caKey = forge.pki.privateKeyFromPem(caKeyPem);
  // Reuse the CA's own issuer Name ASN.1 so the CRL issuer matches exactly
  // (self-signed CA => issuer == subject; index 3 in the TBSCertificate).
  const tbsCert = (forge.pki.certificateToAsn1(caCert).value as forge.asn1.Asn1[])[0];
  const issuerName = (tbsCert.value as forge.asn1.Asn1[])[3];
  const sha256Rsa = () =>
    asn1.create(Class.UNIVERSAL, Type.SEQUENCE, true, [
      asn1.create(Class.UNIVERSAL, Type.OID, false, asn1.oidToDer("1.2.840.113549.1.1.11").getBytes()),
      asn1.create(Class.UNIVERSAL, Type.NULL, false, ""),
    ]);
  const entries = revoked.map((r) => {
    const hex = r.serial.length % 2 ? "0" + r.serial : r.serial;
    return asn1.create(Class.UNIVERSAL, Type.SEQUENCE, true, [
      asn1.create(Class.UNIVERSAL, Type.INTEGER, false, forge.util.hexToBytes(hex)),
      asn1.create(Class.UNIVERSAL, Type.UTCTIME, false, asn1.dateToUtcTime(r.date)),
    ]);
  });
  const tbsFields = [
    asn1.create(Class.UNIVERSAL, Type.INTEGER, false, forge.util.hexToBytes("01")), // v2
    sha256Rsa(),
    issuerName,
    asn1.create(Class.UNIVERSAL, Type.UTCTIME, false, asn1.dateToUtcTime(new Date())),
    // Far-future nextUpdate; we regenerate the CRL on every revocation anyway.
    asn1.create(Class.UNIVERSAL, Type.UTCTIME, false, asn1.dateToUtcTime(new Date(Date.now() + 3650 * 86400_000))),
  ];
  if (entries.length) tbsFields.push(asn1.create(Class.UNIVERSAL, Type.SEQUENCE, true, entries));
  const tbs = asn1.create(Class.UNIVERSAL, Type.SEQUENCE, true, tbsFields);
  const md = forge.md.sha256.create();
  md.update(asn1.toDer(tbs).getBytes());
  const crl = asn1.create(Class.UNIVERSAL, Type.SEQUENCE, true, [
    tbs,
    sha256Rsa(),
    asn1.create(Class.UNIVERSAL, Type.BITSTRING, false, String.fromCharCode(0) + caKey.sign(md)),
  ]);
  const der = asn1.toDer(crl).getBytes();
  return "-----BEGIN X509 CRL-----\n" + forge.util.encode64(der).match(/.{1,64}/g)!.join("\n") + "\n-----END X509 CRL-----\n";
}

/** (Re)write the per-host-CA CRL from the currently-revoked certs for `domain`. */
export function writeClientCrl(domain: string): void {
  const dir = assertWithin(CERT_DIR, join(CERT_DIR, domain));
  const caCrt = join(dir, "client-ca.crt");
  const caKey = join(dir, "client-ca.key");
  if (!existsSync(caCrt) || !existsSync(caKey)) return;
  const revoked = (db
    .prepare("SELECT serial, revokedAt FROM client_certs WHERE domain = ? AND revokedAt IS NOT NULL")
    .all(domain) as Row[]).map((r) => ({ serial: String(r.serial), date: new Date(String(r.revokedAt)) }));
  writeFileSync(join(dir, "client-ca.crl"), buildCrlPem(readFileSync(caCrt, "utf8"), readFileSync(caKey, "utf8"), revoked));
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
  ca.serialNumber = randomSerial();
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
  // The CA signing key can mint client certs that pass mTLS — keep it owner-only.
  writeFileSync(join(dir, "client-ca.key"), forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
  // Seed an (empty) CRL so nginx's ssl_crl always has a file to load.
  writeClientCrl(domain);
}

type Row = Record<string, unknown>;
const toCert = (r: Row): ClientCert => ({
  id: String(r.id), hostId: String(r.hostId), name: String(r.name), serial: String(r.serial),
  fingerprint: String(r.fingerprint), notAfter: String(r.notAfter), createdAt: String(r.createdAt),
  revokedAt: r.revokedAt ? String(r.revokedAt) : null,
});

export function listClientCerts(hostId: string): ClientCert[] {
  return (db.prepare("SELECT * FROM client_certs WHERE hostId = ? ORDER BY createdAt DESC").all(hostId) as Row[]).map(toCert);
}

/** Soft-delete: mark the cert revoked (kept so it can be published in the CRL).
 *  The caller regenerates the CRL + reloads nginx so revocation is enforced. */
export function revokeClientCert(id: string): boolean {
  return db.prepare("UPDATE client_certs SET revokedAt = ? WHERE id = ? AND revokedAt IS NULL")
    .run(new Date().toISOString(), id).changes > 0;
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
  const serial = randomSerial();
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
    "INSERT INTO client_certs (id, hostId, domain, name, serial, fingerprint, notAfter, createdAt) VALUES (?,?,?,?,?,?,?,?)",
  ).run(id, hostId, domain, name, serial, fingerprint, cert.validity.notAfter.toISOString(), new Date().toISOString());

  return {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
    record: toCert(db.prepare("SELECT * FROM client_certs WHERE id = ?").get(id) as Row),
  };
}
