// Portable backup bundle (backup.ts) + passphrase encryption (cryptobox.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTestEnv, makeHost } from "./helpers.ts";

setupTestEnv();
const { buildBundle, restoreBundle } = await import("../src/backup.ts");
const { encryptJson, decryptJson, isEncryptedEnvelope } = await import("../src/cryptobox.ts");
const { createHost, listHosts } = await import("../src/repo.ts");
const { addBan, listBans } = await import("../src/bans.ts");
const { createChannel, listChannels } = await import("../src/notify.ts");
const { saveSettings, getSettings } = await import("../src/db.ts");

// ---------------------------------------------------------------------------
// 1. cryptobox: authenticated passphrase encryption.
// ---------------------------------------------------------------------------
test("encryptJson/decryptJson round-trips an object under the right passphrase", () => {
  const secret = { hello: "world", n: 42, nested: { a: [1, 2, 3] } };
  const env = encryptJson(secret, "correct horse battery");
  assert.ok(isEncryptedEnvelope(env), "produces a self-describing envelope");
  assert.ok(!JSON.stringify(env).includes("world"), "ciphertext doesn't leak plaintext");
  assert.deepEqual(decryptJson(env, "correct horse battery"), secret);
});

test("decryptJson rejects a wrong passphrase and a tampered blob (GCM auth)", () => {
  const env = encryptJson({ a: 1 }, "right-pass");
  assert.throws(() => decryptJson(env, "wrong-pass"), /wrong passphrase or corrupt/i);
  const tampered = { ...env, ct: Buffer.from("garbage").toString("base64") };
  assert.throws(() => decryptJson(tampered, "right-pass"), /wrong passphrase or corrupt/i);
});

// ---------------------------------------------------------------------------
// 2. buildBundle: what goes in the bundle + secret masking.
// ---------------------------------------------------------------------------
test("buildBundle captures hosts + bans + channels; masks secrets unless includeSecrets", () => {
  createHost(makeHost({ id: "b1", name: "svc", domain: "backup.example.com" }));
  addBan("203.0.113.42", "test ban", "manual");
  createChannel({ type: "gotify", name: "ops", config: { server: "https://g.example.com", token: "supersecrettoken123" } });
  saveSettings({ godaddyApiKey: "REAL-SECRET-KEY", instanceName: "MyLab" });

  const masked = buildBundle("2026-07-12T00:00:00Z", false);
  assert.equal(masked.magic, "nginux-backup");
  assert.ok(masked.hosts.some((h) => h.domain === "backup.example.com"));
  assert.ok(masked.bans.some((b) => b.ip === "203.0.113.42"));
  assert.ok(masked.channels.some((c) => c.name === "ops"));
  assert.ok(!JSON.stringify(masked.settings).includes("REAL-SECRET-KEY"), "secrets masked in a plain bundle");
  assert.ok(!JSON.stringify(masked.channels).includes("supersecrettoken123"), "channel secrets masked too");

  const full = buildBundle("2026-07-12T00:00:00Z", true);
  assert.ok(JSON.stringify(full.settings).includes("REAL-SECRET-KEY"), "includeSecrets ships real credentials");
  assert.ok(JSON.stringify(full.channels).includes("supersecrettoken123"), "…and real channel config");
});

// ---------------------------------------------------------------------------
// 3. restoreBundle: round-trip + validation.
// ---------------------------------------------------------------------------
test("restoreBundle replaces hosts/bans/channels from a full (secret-bearing) bundle", () => {
  // Snapshot the current state (with real secrets), then mutate, then restore.
  const bundle = buildBundle(new Date().toISOString(), true);
  const domainsBefore = listHosts().map((h) => h.domain).sort();

  createHost(makeHost({ id: "extra", name: "extra", domain: "extra.example.com" }));
  addBan("198.51.100.99", "temp", "manual");
  assert.ok(listHosts().some((h) => h.domain === "extra.example.com"), "precondition: extra host added");

  const res = restoreBundle(bundle);
  assert.ok(res.hosts >= 1 && res.channels >= 1, "counts returned");
  // The extra host + ban are gone (full replace); the bundle's set is back.
  assert.deepEqual(listHosts().map((h) => h.domain).sort(), domainsBefore, "hosts restored to the bundle set");
  assert.ok(!listBans().some((b) => b.ip === "198.51.100.99"), "the post-bundle ban was replaced away");
  // The real channel secret is restored (came from a full bundle).
  assert.ok(getSettings().godaddyApiKey === "REAL-SECRET-KEY", "real secret restored from a full bundle");
});

test("restoreBundle rejects an invalid bundle", () => {
  assert.throws(() => restoreBundle({ magic: "not-nginux" }), /Invalid backup bundle/i);
  assert.throws(() => restoreBundle({ magic: "nginux-backup", schema: 1, hosts: [{ name: "x;{}", domain: "bad" }] }), /Invalid backup bundle/i);
});

test("restoreBundle from a redacted bundle does NOT clobber a real secret with a placeholder", () => {
  saveSettings({ godaddyApiKey: "STILL-REAL" });
  const redacted = buildBundle(new Date().toISOString(), false); // godaddyApiKey masked to ••••
  restoreBundle(redacted);
  assert.equal(getSettings().godaddyApiKey, "STILL-REAL", "a masked secret is skipped, not written over the real one");
});
