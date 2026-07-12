// Security profiles (server/src/profiles.ts): named reusable bundles of a host's
// security fields, validated through the SAME hostInput rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTestEnv } from "./helpers.ts";

setupTestEnv();
const { createProfile, getProfile, listProfiles, updateProfile, deleteProfile, profilePatch, profileFieldsSchema, seedBuiltinProfiles } =
  await import("../src/profiles.ts");

test("create/get/update/list a profile round-trips its fields", () => {
  const p = createProfile({ name: "Hardened", description: "test", fields: { requireLogin: true, hsts: true, rateLimit: true, rateLimitRps: 25 } });
  assert.equal(p.name, "Hardened");
  assert.equal(p.fields.requireLogin, true);
  assert.equal(p.builtin, false);
  assert.deepEqual(getProfile(p.id)?.fields, { requireLogin: true, hsts: true, rateLimit: true, rateLimitRps: 25 });

  const up = updateProfile(p.id, { fields: { requireLogin: false, blockExploits: true } });
  assert.equal(up?.fields.requireLogin, false);
  assert.ok(listProfiles().some((x) => x.id === p.id));
});

test("profileFieldsSchema reuses hostInput validation (bad security values rejected)", () => {
  assert.equal(profileFieldsSchema.safeParse({ requireLogin: true, rateLimitRps: 25 }).success, true);
  assert.equal(profileFieldsSchema.safeParse({ ipAllow: "not-an-ip;{}" }).success, false, "ipAllow injection rejected");
  assert.equal(profileFieldsSchema.safeParse({ customHeaders: "X-Foo: a\nevil" }).success, false, "bad custom header rejected");
  assert.equal(profileFieldsSchema.safeParse({ rateLimitRps: 999999 }).success, false, "out-of-range rate rejected");
  // Non-security fields aren't part of a profile (picked subset only).
  assert.deepEqual(profileFieldsSchema.parse({ forwardHost: "1.2.3.4", requireLogin: true }), { requireLogin: true }, "non-security keys stripped");
});

test("profilePatch is exactly the stored security fields", () => {
  const p = createProfile({ name: "P", fields: { securityHeaders: true, hsts: true } });
  assert.deepEqual(profilePatch(p), { securityHeaders: true, hsts: true });
});

test("built-in profiles are seeded, idempotent, and can't be deleted", () => {
  seedBuiltinProfiles();
  seedBuiltinProfiles(); // idempotent
  const builtins = listProfiles().filter((p) => p.builtin);
  assert.ok(builtins.length >= 3, "starter profiles seeded once");
  assert.equal(deleteProfile(builtins[0].id), false, "a built-in profile can't be deleted");

  // A user profile CAN be deleted.
  const mine = createProfile({ name: "mine", fields: { requireLogin: true } });
  assert.equal(deleteProfile(mine.id), true);
  assert.equal(getProfile(mine.id), null);
});
