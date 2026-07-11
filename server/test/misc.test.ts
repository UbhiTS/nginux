// Regression coverage for three smaller modules: bans.ts, versioning.ts, totp.ts.
//
// bans.ts and versioning.ts open the DB (via db.ts/repo.ts) and read on-disk
// paths (the banned.conf snippet) at import time, so they MUST be imported
// dynamically AFTER setupTestEnv() or they'd touch the real dev DB / repo tree.
// totp.ts is pure (node:crypto only) but is imported the same way for symmetry.
//
// Pinned invariants:
//  - bans: an added IP is listed + reported banned; removeBan clears it; a CIDR
//    ban round-trips into the nginx deny-list; an EXPIRED ban is NEVER served.
//  - versioning: a snapshot is listed with its label/actor/hostCount; diffVersion
//    classifies added/removed/changed hosts and returns null for a bogus id.
//  - totp: a freshly-valid code verifies; wrong/malformed codes are rejected and
//    a malformed secret never throws.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupTestEnv } from "./helpers.ts";
import { makeHost } from "./helpers.ts";

setupTestEnv();
const { addBan, removeBan, listBans, writeBannedConf, BANNED_FILE } = await import("../src/bans.ts");
const { snapshot, listVersions, diffVersion, restoreVersion } = await import("../src/versioning.ts");
const { createHost, updateHost, deleteHost, listHosts } = await import("../src/repo.ts");
const { generateSecret, totp, verifyTotp, verifyTotpCounter, otpauthURL } = await import("../src/totp.ts");

// No exported "is this IP banned" predicate exists in bans.ts; the canonical
// answer is membership in the (expiry-filtered) listBans() result.
const isBanned = (ip: string): boolean => listBans().some((b) => b.ip === ip);

// ---------------------------------------------------------------------------
// bans.ts
// ---------------------------------------------------------------------------

test("addBan → listBans includes it; predicate true; removeBan clears it", () => {
  const ip = "203.0.113.5";
  const ban = addBan(ip, "manual test", "manual");
  assert.equal(ban.ip, ip);
  assert.equal(ban.reason, "manual test");
  assert.equal(ban.source, "manual");
  assert.ok(ban.expiresAt, "a default (24h) ban has an expiry");

  assert.ok(isBanned(ip), "banned IP must be reported banned");
  assert.ok(listBans().some((b) => b.ip === ip));

  assert.equal(removeBan(ip), true, "removeBan returns true when a row was deleted");
  assert.equal(isBanned(ip), false, "removed IP must no longer be banned");
});

test("removeBan on an IP that was never banned returns false", () => {
  assert.equal(removeBan("192.0.2.222"), false);
});

test("addBan upserts on the IP primary key (second call updates the reason)", () => {
  const ip = "203.0.113.9";
  addBan(ip, "first reason", "auto");
  const second = addBan(ip, "second reason", "geoip");
  assert.equal(second.reason, "second reason");
  assert.equal(second.source, "geoip");
  // Exactly one row for that IP, carrying the latest reason.
  const rows = listBans().filter((b) => b.ip === ip);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, "second reason");
  removeBan(ip);
});

test("a CIDR ban round-trips into listBans and the nginx deny-list", () => {
  const cidr = "198.51.100.0/24";
  addBan(cidr, "block subnet", "manual");
  assert.ok(isBanned(cidr), "CIDR ban must be listed");

  writeBannedConf(); // addBan already writes it, but assert the generated snippet directly
  const conf = readFileSync(BANNED_FILE, "utf8");
  assert.ok(conf.includes(`deny ${cidr};`), `banned.conf must contain: deny ${cidr};`);
  removeBan(cidr);

  const after = readFileSync(BANNED_FILE, "utf8");
  assert.ok(!after.includes(`deny ${cidr};`), "removing a ban must drop it from the deny-list");
});

test("an EXPIRED ban is never served by listBans (pinned: read path filters expiry)", () => {
  const ip = "203.0.113.44";
  // ttlMs in the past -> expiresAt is already behind us.
  const ban = addBan(ip, "stale", "auto", -1000);
  assert.ok(ban.expiresAt, "the stored row still carries the (past) expiry");
  assert.equal(isBanned(ip), false, "expired bans must not appear in listBans");
  const conf = readFileSync(BANNED_FILE, "utf8");
  assert.ok(!conf.includes(`deny ${ip};`), "expired bans must not reach the deny-list");
});

test("ttlMs=0 creates a permanent ban (null expiry) that is always listed", () => {
  const ip = "203.0.113.77";
  const ban = addBan(ip, "permanent", "manual", 0);
  assert.equal(ban.expiresAt, null);
  assert.ok(isBanned(ip));
  removeBan(ip);
});

// ---------------------------------------------------------------------------
// versioning.ts
// ---------------------------------------------------------------------------

test("snapshot is listed with its label/actor/hostCount; diffVersion classifies changes", () => {
  // Two hosts in the baseline.
  const a = createHost(makeHost({ id: "a", name: "A", domain: "a.example.com" }));
  const b = createHost(makeHost({ id: "b", name: "B", domain: "b.example.com" }));
  assert.equal(listHosts().length, 2);

  const v = snapshot("baseline", "tester");
  assert.ok(v.id);
  assert.equal(v.label, "baseline");
  assert.equal(v.actor, "tester");
  assert.equal(v.hostCount, 2);

  const listed = listVersions().find((x) => x.id === v.id);
  assert.ok(listed, "snapshot must appear in listVersions");
  assert.equal(listed!.label, "baseline");
  assert.equal(listed!.actor, "tester");
  assert.equal(listed!.hostCount, 2);

  // No mutations yet -> the diff is empty in all three buckets.
  const clean = diffVersion(v.id);
  assert.ok(clean);
  assert.deepEqual(clean!.added, []);
  assert.deepEqual(clean!.removed, []);
  assert.deepEqual(clean!.changed, []);

  // Add a host (added), change a host's real field (changed), delete one (removed).
  createHost(makeHost({ id: "c", name: "C", domain: "c.example.com" }));
  updateHost(a.id, { forwardPort: 9999 });
  deleteHost(b.id);

  const diff = diffVersion(v.id)!;
  assert.deepEqual(diff.added, ["c.example.com"]);
  assert.deepEqual(diff.removed, ["b.example.com"]);
  assert.deepEqual(diff.changed, ["a.example.com"]);
});

test("diffVersion returns null for a bogus version id", () => {
  assert.equal(diffVersion("does-not-exist"), null);
});

test("restoreVersion rolls hosts back to the snapshot; null for a bogus id", () => {
  // Reset to a known fresh two-host state, snapshot it, then mutate and restore.
  for (const h of listHosts()) deleteHost(h.id);
  createHost(makeHost({ id: "r1", name: "R1", domain: "r1.example.com" }));
  createHost(makeHost({ id: "r2", name: "R2", domain: "r2.example.com" }));
  const v = snapshot("restore-point", "system");
  assert.equal(v.actor, "system"); // default actor

  // Drift away from the snapshot.
  for (const h of listHosts()) deleteHost(h.id);
  createHost(makeHost({ id: "drift", name: "Drift", domain: "drift.example.com" }));

  const res = restoreVersion(v.id);
  assert.deepEqual(res, { restored: 2 });
  const domains = listHosts().map((h) => h.domain).sort();
  assert.deepEqual(domains, ["r1.example.com", "r2.example.com"]);

  assert.equal(restoreVersion("nope"), null);
});

test("snapshot defaults the actor to 'system' when omitted", () => {
  const v = snapshot("auto-label");
  const listed = listVersions().find((x) => x.id === v.id)!;
  assert.equal(listed.actor, "system");
});

// ---------------------------------------------------------------------------
// totp.ts
// ---------------------------------------------------------------------------

test("generateSecret returns a 32-char RFC4648 base32 secret (160 bits, no padding)", () => {
  const s = generateSecret();
  assert.match(s, /^[A-Z2-7]{32}$/);
  assert.notEqual(generateSecret(), s, "secrets must be random");
});

test("verifyTotp accepts a freshly-valid code and its matched counter", () => {
  const secret = generateSecret();
  const code = totp(secret);
  assert.equal(verifyTotp(code, secret), true);
  const counter = verifyTotpCounter(code, secret);
  // A match returns a non-negative counter within ±1 step of "now" (the ±1 slack
  // makes this immune to a 30s TOTP boundary crossing mid-test).
  const nowCounter = Math.floor(Date.now() / 1000 / 30);
  assert.ok(counter >= nowCounter - 1 && counter <= nowCounter + 1, `matched counter ${counter} near ${nowCounter}`);
});

test("verifyTotp tolerates ±1 step of clock drift but rejects codes outside the window", () => {
  const secret = generateSecret();
  const now = Date.now();
  assert.equal(verifyTotp(totp(secret, now - 30_000), secret), true, "prev step within window");
  assert.equal(verifyTotp(totp(secret, now + 30_000), secret), true, "next step within window");
  // 3 steps (90s) away is outside the default ±1 window.
  assert.equal(verifyTotp(totp(secret, now - 90_000), secret), false, "far-past code rejected");
});

test("verifyTotp rejects an obviously wrong code and malformed tokens", () => {
  const secret = generateSecret();
  const now = Date.now();
  // Deterministically pick a 6-digit code that is NOT one of the 3 valid ones.
  const valid = new Set([totp(secret, now - 30_000), totp(secret, now), totp(secret, now + 30_000)]);
  let wrong = "000000";
  let n = 0;
  while (valid.has(wrong)) { n += 1; wrong = String(n).padStart(6, "0"); }
  assert.equal(verifyTotp(wrong, secret), false, "a non-matching 6-digit code must be rejected");

  // Malformed shapes never verify (and never throw).
  for (const bad of ["", "abc", "12345", "1234567", "12 34 56", "0x1234"]) {
    assert.equal(verifyTotp(bad, secret), false, `malformed token rejected: ${JSON.stringify(bad)}`);
  }
  assert.equal(verifyTotpCounter(wrong, secret), -1);
});

test("verifyTotp with a malformed secret returns a boolean and does not throw", () => {
  let result: boolean | undefined;
  assert.doesNotThrow(() => { result = verifyTotp("123456", "!!! not base32 !!!"); });
  assert.equal(typeof result, "boolean");
});

test("otpauthURL encodes secret, issuer and the SHA1/6-digit/30s parameters", () => {
  const secret = generateSecret();
  const url = otpauthURL(secret, "alice@example.com");
  assert.ok(url.startsWith("otpauth://totp/"), "must be an otpauth TOTP URI");
  assert.ok(url.includes(encodeURIComponent("NginUX:alice@example.com")), "label carries issuer:account");
  assert.ok(url.includes(`secret=${secret}`), "secret is present");
  assert.ok(url.includes("digits=6"));
  assert.ok(url.includes("period=30"));
  assert.ok(url.includes("algorithm=SHA1"));
});
