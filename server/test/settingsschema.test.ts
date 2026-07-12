// Shared settings-write schema (server/src/settingsschema.ts). Used by BOTH the
// REST boundary and the agent update_settings tool, so the two can't drift; this
// pins the validation + the safe widening (agent may now set the fields the old
// SETTING_KEYS allowlist dropped, because they're now validated).
import { test } from "node:test";
import assert from "node:assert/strict";
import { settingsInput } from "../src/settingsschema.ts";

const ok = (patch: Record<string, unknown>) => settingsInput.safeParse(patch);

test("accepts fields the old agent allowlist dropped (now that they're validated)", () => {
  const r = ok({
    allowedCountries: "US, GB",
    updateCheckEnabled: false,
    require2faForManagers: true,
    ssoLoginUrl: "https://nginux.example.com",
    ssoCookieDomain: ".example.com",
    logMaxMb: 25,
    logKeepFiles: 3,
  });
  assert.ok(r.success, "the widened fields validate");
  assert.equal(r.data.allowedCountries, "US, GB");
  assert.equal(r.data.ssoLoginUrl, "https://nginux.example.com");
  assert.equal(r.data.logMaxMb, 25);
});

test("rejects invalid values on the widened fields (the reason they were gated)", () => {
  assert.equal(ok({ ssoLoginUrl: "not a url" }).success, false, "a bad SSO URL is rejected");
  assert.equal(ok({ allowedCountries: "US; return 403" }).success, false, "injection in allowedCountries is rejected");
  assert.equal(ok({ ssoCookieDomain: "bad domain!" }).success, false, "a bad cookie domain is rejected");
  assert.equal(ok({ logMaxMb: 999999 }).success, false, "an out-of-range logMaxMb is rejected");
  assert.equal(ok({ dnsProvider: "route53" }).success, false, "an off-enum dnsProvider is rejected");
});

test("strips unknown keys (the schema doubles as the write allowlist)", () => {
  const r = settingsInput.parse({ instanceName: "Lab", role: "admin", isAdmin: true, __proto__: {} } as Record<string, unknown>);
  assert.deepEqual(Object.keys(r), ["instanceName"], "only known settings survive");
});

test("is partial: a one-field patch validates without the others", () => {
  const r = ok({ theme: "light" });
  assert.ok(r.success);
  assert.deepEqual(Object.keys(r.data), ["theme"], "no defaults injected, no other fields required");
});
