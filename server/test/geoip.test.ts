// Country-lock allowlist (the travel-allowlist feature) + generated geo config.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { setupTestEnv } from "./helpers.ts";

setupTestEnv();
const { saveSettings } = await import("../src/db.ts");
const { activeAllowedCountries, writeGeoipConf, geoipConfPath, geoipDbPath } = await import("../src/geoip.ts");

test("activeAllowedCountries unions home + travel allowlist, dedupes + normalises + filters junk", () => {
  delete process.env.NGINUX_ALLOWED_COUNTRIES;
  saveSettings({ homeCountry: "US", allowedCountries: "JP, gb , ZZ, 1x" });
  assert.deepEqual(activeAllowedCountries(), ["US", "JP", "GB", "ZZ"]); // gb→GB, "1x" dropped
});

test("NGINUX_ALLOWED_COUNTRIES env break-glass is unioned in (regression: locked-out recovery)", () => {
  saveSettings({ homeCountry: "US", allowedCountries: "JP" });
  process.env.NGINUX_ALLOWED_COUNTRIES = "FR, us";
  assert.deepEqual(activeAllowedCountries(), ["US", "JP", "FR"]); // "us" deduped against home
  delete process.env.NGINUX_ALLOWED_COUNTRIES;
});

test("writeGeoipConf active branch allows every configured country + LAN", () => {
  saveSettings({ homeCountry: "US", allowedCountries: "JP,GB" });
  mkdirSync(dirname(geoipDbPath), { recursive: true });
  writeFileSync(geoipDbPath, "stub-mmdb"); // force the active branch
  writeGeoipConf();
  const conf = readFileSync(geoipConfPath, "utf8");
  for (const line of ["US 1;", "JP 1;", "GB 1;"]) assert.ok(conf.includes(line), `missing: ${line}`);
  assert.ok(conf.includes("192.168.0.0/16 1;"), "LAN must always be allowed");
  assert.ok(conf.includes("127.0.0.0/8 1;"), "loopback must always be allowed");
  rmSync(geoipDbPath, { force: true });
});

test("writeGeoipConf with no GeoIP DB is a safe allow-all no-op", () => {
  rmSync(geoipDbPath, { force: true });
  saveSettings({ homeCountry: "US", allowedCountries: "JP" });
  writeGeoipConf();
  const conf = readFileSync(geoipConfPath, "utf8");
  assert.match(conf, /geo \$nginux_allowed_country \{ default 1; \}/);
});
