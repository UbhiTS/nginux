// Multi-realm login gate (server/src/realms.ts): per-base-domain login URL +
// cookie domain, so a second-domain gated service doesn't loop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTestEnv } from "./helpers.ts";

setupTestEnv();
const { parseRealms, realmForHost } = await import("../src/realms.ts");
const { saveSettings } = await import("../src/db.ts");

const REALMS = [
  { baseDomain: "ubhits.com", loginUrl: "https://nginux.ubhits.com" },
  { baseDomain: "ubhims.com", loginUrl: "https://sso.ubhims.com/" },
];

test("parseRealms tolerates junk and normalises entries", () => {
  assert.deepEqual(parseRealms(""), []);
  assert.deepEqual(parseRealms("not json"), []);
  assert.deepEqual(parseRealms("{}"), [], "non-array -> []");
  const r = parseRealms(JSON.stringify([...REALMS, { baseDomain: "", loginUrl: "x" }, { junk: 1 }]));
  assert.equal(r.length, 2, "invalid entries dropped");
  assert.equal(r[1].loginUrl, "https://sso.ubhims.com", "trailing slash trimmed");
});

test("realmForHost matches a host's registrable base to its realm (own login + cookie)", () => {
  const list = parseRealms(JSON.stringify(REALMS));
  const a = realmForHost("plex.ubhits.com", list);
  assert.deepEqual(a, { loginUrl: "https://nginux.ubhits.com", cookieDomain: ".ubhits.com" });
  const b = realmForHost("grafana.ubhims.com", list);
  assert.deepEqual(b, { loginUrl: "https://sso.ubhims.com", cookieDomain: ".ubhims.com" });
  // The two domains are independent realms.
  assert.notEqual(a!.cookieDomain, b!.cookieDomain);
  // A host on no configured realm -> null (caller uses the legacy global behaviour).
  assert.equal(realmForHost("app.example.com", list), null);
  // No realms at all -> null.
  assert.equal(realmForHost("plex.ubhits.com", []), null);
});

test("realmForHost reads the ssoRealms setting when no list is passed", () => {
  saveSettings({ ssoRealms: JSON.stringify(REALMS) });
  assert.equal(realmForHost("x.ubhits.com")?.cookieDomain, ".ubhits.com");
  saveSettings({ ssoRealms: "" });
  assert.equal(realmForHost("x.ubhits.com"), null, "cleared -> falls back to legacy (null)");
});
