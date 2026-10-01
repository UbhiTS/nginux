import { scrypt as scryptCallback, scryptSync, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";

// Passphrase-based authenticated encryption for backup bundles. scrypt derives a
// 32-byte key from the passphrase + a random salt; AES-256-GCM encrypts and
// authenticates. A wrong passphrase fails the GCM auth tag on decrypt, so tampered
// or wrong-key blobs are rejected rather than silently mis-decrypted. Everything a
// restore needs (salt/iv/tag) travels in the self-describing envelope.

const KDF_N = 16384, KDF_r = 8, KDF_p = 1; // scrypt cost params (interactive-grade)
const KEY_LEN = 32, SALT_LEN = 16, IV_LEN = 12, TAG_LEN = 16;

export interface EncryptedEnvelope {
  magic: "nginux-encrypted";
  v: 1;
  kdf: "scrypt";
  salt: string; // base64
  iv: string;   // base64
  tag: string;  // base64
  ct: string;   // base64 ciphertext
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, { N: KDF_N, r: KDF_r, p: KDF_p });
}

function deriveKeyAsync(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(passphrase, salt, KEY_LEN, { N: KDF_N, r: KDF_r, p: KDF_p }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

function sealWithKey(obj: unknown, key: Buffer, salt: Buffer, iv: Buffer): EncryptedEnvelope {
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LEN });
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    magic: "nginux-encrypted", v: 1, kdf: "scrypt",
    salt: salt.toString("base64"), iv: iv.toString("base64"),
    tag: tag.toString("base64"), ct: ct.toString("base64"),
  };
}

function openWithKey<T>(env: EncryptedEnvelope, key: Buffer, iv: Buffer, tag: Buffer): T {
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(Buffer.from(env.ct, "base64")), decipher.final()]);
  return JSON.parse(pt.toString("utf8")) as T;
}

function parseEnvelopeParts(env: EncryptedEnvelope): { salt: Buffer; iv: Buffer; tag: Buffer } {
  if (typeof env.salt !== "string" || typeof env.iv !== "string" || typeof env.tag !== "string") {
    throw new Error("Malformed envelope fields.");
  }
  const salt = Buffer.from(env.salt, "base64");
  const iv = Buffer.from(env.iv, "base64");
  const tag = Buffer.from(env.tag, "base64");
  if (salt.length !== SALT_LEN || iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new Error("Invalid salt, IV, or authentication tag length.");
  }
  return { salt, iv, tag };
}

/** Encrypt any JSON-serialisable value under a passphrase (synchronous). */
export function encryptJson(obj: unknown, passphrase: string): EncryptedEnvelope {
  if (!passphrase) throw new Error("A passphrase is required to encrypt.");
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  return sealWithKey(obj, key, salt, iv);
}

/** Encrypt any JSON-serialisable value under a passphrase without blocking the event loop. */
export async function encryptJsonAsync(obj: unknown, passphrase: string): Promise<EncryptedEnvelope> {
  if (!passphrase) throw new Error("A passphrase is required to encrypt.");
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = await deriveKeyAsync(passphrase, salt);
  return sealWithKey(obj, key, salt, iv);
}

/** True if a parsed object looks like our encrypted envelope. */
export function isEncryptedEnvelope(o: unknown): o is EncryptedEnvelope {
  const e = o as EncryptedEnvelope;
  return !!e && e.magic === "nginux-encrypted" && e.kdf === "scrypt" && typeof e.ct === "string";
}

/** Decrypt an envelope back to its JSON value. Throws a clean error on a wrong
 *  passphrase or a corrupt/tampered blob (GCM auth-tag failure). */
export function decryptJson<T = unknown>(env: EncryptedEnvelope, passphrase: string): T {
  if (!isEncryptedEnvelope(env)) throw new Error("Not an encrypted NginUX bundle.");
  if (!passphrase) throw new Error("A passphrase is required to decrypt.");
  try {
    const { salt, iv, tag } = parseEnvelopeParts(env);
    const key = deriveKey(passphrase, salt);
    return openWithKey<T>(env, key, iv, tag);
  } catch {
    throw new Error("Couldn't decrypt - wrong passphrase or corrupt backup file.");
  }
}

/** Decrypt an envelope back to its JSON value without blocking the event loop. */
export async function decryptJsonAsync<T = unknown>(env: EncryptedEnvelope, passphrase: string): Promise<T> {
  if (!isEncryptedEnvelope(env)) throw new Error("Not an encrypted NginUX bundle.");
  if (!passphrase) throw new Error("A passphrase is required to decrypt.");
  try {
    const { salt, iv, tag } = parseEnvelopeParts(env);
    const key = await deriveKeyAsync(passphrase, salt);
    return openWithKey<T>(env, key, iv, tag);
  } catch {
    throw new Error("Couldn't decrypt - wrong passphrase or corrupt backup file.");
  }
}

// Re-exported so callers that compare secrets elsewhere use a constant-time check.
export { timingSafeEqual };
