// TLS certificate store: self-signed issuance, on-disk cert lifecycle, PEM import
// (a path-traversal-sensitive surface - an attacker-chosen CN becomes a cert-dir
// path segment), and reconciliation of on-disk certs back into the DB.
// The ACME / Let's Encrypt NETWORK path is deliberately NOT exercised here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import forge from "node-forge";
import { setupTestEnv } from "./helpers.ts";

const env = setupTestEnv();
const certs = await import("../src/certs.ts");
const { db } = await import("../src/db.ts");

// Mint a self-signed cert + matching PKCS#1 key for an arbitrary CN. Used to forge
// a hostile CN the real code would never emit (the traversal test) and to build
// valid/mismatched import fixtures without going through issueSelfSigned's DB write.
function mintPair(cn: string): { certPem: string; keyPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400_000);
  const attrs = [{ name: "commonName", value: cn }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

// --- 1. issueSelfSigned: DB row + on-disk files + parseable details ---
test("issueSelfSigned mints a tracked, future-dated self-signed cert and writes files under CERT_DIR", async () => {
  const cert = await certs.issueSelfSigned("test.example.com");
  assert.equal(cert.domain, "test.example.com");
  assert.equal(cert.method, "selfsigned");
  assert.match(cert.issuer, /self-signed/i);
  assert.ok(cert.notAfter && Date.parse(cert.notAfter) > Date.now(), "notAfter must be in the future");

  // Shows up in the store listing with the same issuer + future expiry.
  const found = certs.listCerts().find((c) => c.domain === "test.example.com");
  assert.ok(found, "listCerts must include the issued domain");
  assert.match(found.issuer, /self-signed/i);
  assert.ok(found.notAfter && Date.parse(found.notAfter) > Date.now(), "listed notAfter must be in the future");
  assert.ok(typeof found.daysRemaining === "number" && found.daysRemaining > 0, "daysRemaining derived and positive");

  const got = certs.getCert("test.example.com");
  assert.ok(got, "getCert must return the issued cert");
  assert.equal(got.domain, "test.example.com");

  // The key/cert PEMs were written under CERT_DIR/<domain>/.
  const dir = join(certs.CERT_DIR, "test.example.com");
  assert.ok(existsSync(join(dir, "fullchain.pem")), "fullchain.pem must be written under CERT_DIR");
  assert.ok(existsSync(join(dir, "privkey.pem")), "privkey.pem must be written under CERT_DIR");

  // getCertDetails parses the leaf off disk: subject CN + validity window.
  const details = certs.getCertDetails("test.example.com");
  assert.ok(details, "getCertDetails must parse the on-disk cert");
  assert.equal(details.subject, "test.example.com", "subject CN must be the domain");
  assert.ok(Date.parse(details.notBefore) <= Date.now(), "notBefore must be at or before now");
  assert.ok(Date.parse(details.notAfter) > Date.now(), "notAfter must be in the future");
  assert.equal(details.selfSigned, true, "a self-signed cert must report selfSigned=true");
});

test("getCertDetails returns null for a domain with no cert file on disk", () => {
  assert.equal(certs.getCertDetails("nonexistent.example.com"), null);
});

// --- 2. deleteCert clears both the DB row AND the on-disk files ---
test("deleteCert removes the DB row and the on-disk key/cert directory", async () => {
  await certs.issueSelfSigned("delete.example.com");
  const dir = join(certs.CERT_DIR, "delete.example.com");
  assert.ok(existsSync(join(dir, "fullchain.pem")), "precondition: cert file exists");

  certs.deleteCert("delete.example.com");

  assert.equal(certs.getCert("delete.example.com"), null, "DB row must be gone");
  assert.ok(!certs.listCerts().some((c) => c.domain === "delete.example.com"), "must not appear in listCerts");
  assert.ok(!existsSync(dir), "on-disk cert directory must be removed so no dangling path is served");
});

// --- 3. PATH TRAVERSAL (importCertFiles) ---
// PINNED SECURITY INVARIANT: the certificate CN becomes a cert-dir path segment,
// so a hostile CN like "../escape" must NEVER cause a write outside CERT_DIR. The
// import must reject it (skipped, not imported) while still importing a valid pair.
test("importCertFiles rejects a traversal CN and never writes outside CERT_DIR, but imports a valid pair", () => {
  const evil = mintPair("../escape");
  const good = mintPair("good.example.com");

  const result = certs.importCertFiles([
    { path: "evil/cert.pem", content: evil.certPem },
    { path: "evil/privkey.pem", content: evil.keyPem },
    { path: "good/fullchain.pem", content: good.certPem },
    { path: "good/privkey.pem", content: good.keyPem },
  ]);

  // The traversal group is rejected, not imported.
  assert.ok(
    !result.imported.some((i) => i.domain.includes("..") || i.domain.includes("escape") || i.domain.includes("/")),
    "traversal CN must NOT be imported",
  );
  assert.ok(result.skipped.length >= 1, "the traversal group must be skipped");
  // And absolutely no file lands outside CERT_DIR (CN would resolve to a sibling of certs/).
  assert.ok(!existsSync(join(certs.CERT_DIR, "..", "escape")), "no cert dir may be created outside CERT_DIR");

  // The legitimate pair still imports and lands under CERT_DIR.
  assert.ok(result.imported.some((i) => i.domain === "good.example.com"), "the valid pair must be imported");
  assert.ok(
    existsSync(join(certs.CERT_DIR, "good.example.com", "fullchain.pem")),
    "valid import must write under CERT_DIR/<domain>/",
  );
});

test("importCertFiles skips a group that has a cert but no private key", () => {
  const good = mintPair("nokey.example.com");
  const result = certs.importCertFiles([{ path: "nokey/cert.pem", content: good.certPem }]);
  assert.equal(result.imported.length, 0, "a lone cert must not import");
  assert.ok(
    result.skipped.some((s) => /certificate and a private key/i.test(s.reason)),
    "skip reason must cite the missing key",
  );
});

test("importCertFiles skips a cert whose supplied key does not match it", () => {
  const cert = mintPair("mismatch.example.com");
  const other = mintPair("mismatch.example.com"); // same CN, different keypair
  const result = certs.importCertFiles([
    { path: "m/cert.pem", content: cert.certPem },
    { path: "m/privkey.pem", content: other.keyPem },
  ]);
  assert.ok(!result.imported.some((i) => i.domain === "mismatch.example.com"), "a mismatched key must not import");
  assert.ok(result.skipped.some((s) => /doesn't match/i.test(s.reason)), "skip reason must cite the key mismatch");
});

test("importCertFiles imports a real self-signed pair read back from disk", async () => {
  await certs.issueSelfSigned("roundtrip.example.com");
  const dir = join(certs.CERT_DIR, "roundtrip.example.com");
  const { readFileSync } = await import("node:fs");
  const certPem = readFileSync(join(dir, "fullchain.pem"), "utf8");
  const keyPem = readFileSync(join(dir, "privkey.pem"), "utf8");
  // Import the same PEMs under a fresh upload folder; the CN drives the target dir.
  const result = certs.importCertFiles([
    { path: "up/fullchain.pem", content: certPem },
    { path: "up/privkey.pem", content: keyPem },
  ]);
  assert.ok(result.imported.some((i) => i.domain === "roundtrip.example.com"), "a genuine pair must import");
  assert.equal(result.skipped.length, 0, "a genuine pair must not be skipped");
});

// --- 4. reconcileImportedCerts registers on-disk certs back into the DB ---
test("reconcileImportedCerts re-registers an on-disk cert whose DB row was dropped", async () => {
  await certs.issueSelfSigned("reconcile.example.com");
  // Drop ONLY the DB row (not deleteCert, which would also remove the files).
  db.prepare("DELETE FROM certificates WHERE domain = ?").run("reconcile.example.com");
  assert.equal(certs.getCert("reconcile.example.com"), null, "precondition: DB row gone");
  assert.ok(
    existsSync(join(certs.CERT_DIR, "reconcile.example.com", "fullchain.pem")),
    "precondition: cert files remain on disk",
  );

  certs.reconcileImportedCerts();

  const back = certs.getCert("reconcile.example.com");
  assert.ok(back, "reconcile must re-register the on-disk cert into the DB");
  assert.equal(back.method, "selfsigned", "a self-signed leaf must be reconciled as selfsigned");
  assert.match(back.issuer, /self-signed/i, "issuer must be classified as self-signed");
  assert.ok(back.notAfter && Date.parse(back.notAfter) > Date.now(), "reconciled expiry must be future-dated");
});
