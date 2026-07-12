import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProxyHost } from "../src/types.ts"; // type-only: erased, no module side effect

/**
 * Isolate EVERY on-disk path a server module touches at import time into a fresh
 * temp dir, so tests never read/write the dev DB, the repo's nginx/ tree, certs,
 * or logs. Call this at the very TOP of a test file, BEFORE dynamically importing
 * any `../src/*.ts` module (db.ts/nginx.ts/geoip.ts/etc. read these env vars when
 * they are first evaluated):
 *
 *   import { setupTestEnv } from "./helpers.ts";
 *   const env = setupTestEnv();
 *   const { generateHostConfig } = await import("../src/nginx.ts");
 *
 * node --test runs each file in its own process, so per-file env is fully isolated.
 */
export function setupTestEnv(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "nginux-test-"));
  const p = (...s: string[]) => join(dir, ...s);
  Object.assign(process.env, {
    NGINUX_DATA_DIR: dir,
    NGINX_CONF_DIR: p("conf.d"),
    NGINX_STREAM_DIR: p("stream.d"),
    NGINX_GEOIP_CONF: p("geoip.conf"),
    GEOIP_DIR: p("geoip"),
    CERT_DIR: p("certs"),
    ACME_WEBROOT: p("acme-webroot"),
    NGINX_ACCESS_LOG: p("access.log"),
    NGINX_BANNED_FILE: p("banned.conf"),
    NGINX_DEFAULT_CERT: p("selfsigned.crt"),
    NGINX_DEFAULT_KEY: p("selfsigned.key"),
    // Force the "nginx not installed" path so applyConfig() is a deterministic
    // no-op (writes config, skips validate/reload) on EVERY runner. Without this,
    // a CI host that ships nginx (e.g. ubuntu-latest) would actually run `nginx -t`
    // against the test's generated config and flip host create/update to the 422
    // rollback path - a false failure that has nothing to do with the code.
    NGINX_BIN: "nginux-tests-no-nginx-binary",
    NODE_ENV: "test",
    LOG_LEVEL: "silent", // keep Fastify's request logs out of the test output
  });
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } };
}

/** A complete, valid ProxyHost with safe defaults; override any field per test.
 *  Pure data (type-only import), so it's safe to call before setupTestEnv(). */
export function makeHost(overrides: Partial<ProxyHost> = {}): ProxyHost {
  return {
    id: "svc", name: "Service", iconUrl: "", domain: "app.example.com",
    forwardScheme: "http", forwardHost: "192.168.1.60", forwardPort: 3000, preset: "custom",
    websockets: false, http2: true, ssl: true, requireLogin: false, require2fa: false,
    countryLock: false, serverGroup: "s", serverIp: "192.168.1.60", enabled: true, health: "online",
    certExpiresAt: null, certDomain: "", maintenanceMode: false, securityHeaders: true, hsts: false,
    rateLimit: false, rateLimitRps: 10, rateLimitBurst: 20, blockExploits: true,
    ipAllow: "", ipDeny: "", customHeaders: "", customNginx: "", upstreams: "",
    lbMethod: "round_robin", protocol: "http", listenPort: 0, pathRules: "", mtls: false,
    rateLimitKbps: 0, maxConns: 0, healthCheckType: "tcp", healthCheckPath: "/", healthCheckStatus: 0,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}
