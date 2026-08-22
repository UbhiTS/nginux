// First-run credential safety for source/local starts (not only NODE_ENV=production).
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTestEnv } from "./helpers.ts";

setupTestEnv();
delete process.env.NGINUX_ADMIN_PASSWORD;
delete process.env.NGINUX_INSECURE_DEV_DEFAULTS;

const auth = await import("../src/auth.ts");

test("a non-production first run generates a random bootstrap password by default", async () => {
  const seeded = await auth.seedAuthIfEmpty();
  assert.equal(seeded.usingDefault, false);
  assert.match(seeded.bootstrapPassword ?? "", /^[A-Za-z0-9_-]{24,}$/);
  assert.equal(await auth.checkCredentials("admin", "admin"), null, "known admin/admin must never work without explicit insecure opt-in");
  assert.ok(await auth.checkCredentials("admin", seeded.bootstrapPassword!), "the one-time generated password authenticates");
});
