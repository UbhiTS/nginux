import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// RFC 4648 base32 (no padding) - used for TOTP secrets / otpauth URIs.
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str: string): Buffer {
  const clean = str.replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, "0");
}

export function totp(secret: string, time = Date.now(), step = 30): string {
  return hotp(secret, Math.floor(time / 1000 / step));
}

/** Verify a token allowing ±`window` time steps for clock drift. */
export function verifyTotp(token: string, secret: string, window = 1): boolean {
  return verifyTotpCounter(token, secret, window) >= 0;
}

/** Like verifyTotp but returns the matched time-step counter (or -1). The caller
 *  can persist the last-consumed counter to reject replays within the window. */
export function verifyTotpCounter(token: string, secret: string, window = 1): number {
  const t = token.trim();
  if (!/^\d{6}$/.test(t)) return -1;
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let w = -window; w <= window; w++) {
    const expected = hotp(secret, counter + w);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(t))) return counter + w;
  }
  return -1;
}

export function otpauthURL(secret: string, account: string, issuer = "NginUX"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret, issuer, algorithm: "SHA1", digits: "6", period: "30",
    // Non-standard `image` param: a few authenticators (2FAS, Ente Auth, …) show
    // this as the entry's icon. The big ones (Microsoft/Google Authenticator)
    // ignore it and fall back to a generic tile - there's no standard way to set
    // a custom icon for those. Points at the official logo so every deployment
    // resolves the same brand mark.
    image: "https://raw.githubusercontent.com/UbhiTS/nginux/main/web/public/logo.png",
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
