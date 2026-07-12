// nginx.conf importer (server/src/importer.ts): parse server{} blocks into host
// drafts, preview (no side effects), then import. Guards the same injection sinks
// as the REST path (hostname / forward host).
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTestEnv, makeHost } from "./helpers.ts";

setupTestEnv();
const { parseNginxConf, previewNginxConf, importNginxConf } = await import("../src/importer.ts");
const { createHost, listHosts } = await import("../src/repo.ts");

const SAMPLE = `
server {
  listen 443 ssl;
  server_name grafana.example.com;
  location / {
    proxy_pass http://192.168.1.70:3000;
    proxy_set_header Upgrade $http_upgrade;   # websocket
  }
}
server {
  listen 80;
  server_name plain.example.com;
  location / { proxy_pass http://10.0.0.5:8080; }
}
server {
  # a static/redirect block with no proxy_pass - must be ignored
  listen 80;
  server_name static.example.com;
  return 301 https://$host$request_uri;
}
`;

test("parseNginxConf extracts proxy blocks (scheme/host/port/ssl/websockets), skips non-proxy blocks", () => {
  const parsed = parseNginxConf(SAMPLE);
  assert.equal(parsed.length, 2, "only the two proxy blocks are parsed");
  const g = parsed.find((p) => p.domain === "grafana.example.com")!;
  assert.equal(g.forwardHost, "192.168.1.70");
  assert.equal(g.forwardPort, 3000);
  assert.equal(g.ssl, true, "listen 443 ssl -> ssl");
  assert.equal(g.websockets, true, "proxy_set_header Upgrade -> websockets");
  const p = parsed.find((x) => x.domain === "plain.example.com")!;
  assert.equal(p.ssl, false);
  assert.equal(p.websockets, false);
});

test("previewNginxConf classifies importable vs skipped WITHOUT creating anything", () => {
  createHost(makeHost({ id: "dup", name: "dup", domain: "grafana.example.com" })); // pre-existing
  const before = listHosts().length;

  const preview = previewNginxConf(SAMPLE + `
server { server_name bad_host!!; location / { proxy_pass http://1.2.3.4:80; } }`);
  assert.ok(preview.toImport.some((d) => d.domain === "plain.example.com"), "a new host is importable");
  assert.ok(preview.skipped.some((s) => s.domain === "grafana.example.com" && /exists/.test(s.reason)), "the duplicate is skipped with a reason");
  assert.ok(preview.skipped.some((s) => /bad_host/.test(s.domain) && /hostname/.test(s.reason)), "the bad hostname is skipped");
  assert.equal(listHosts().length, before, "preview creates nothing");
});

test("importNginxConf actually creates the importable hosts", () => {
  const result = importNginxConf(`
server { listen 443 ssl; server_name newimport.example.com; location / { proxy_pass https://192.168.1.9:8443; } }`);
  assert.deepEqual(result.imported, ["newimport.example.com"]);
  const created = listHosts().find((h) => h.domain === "newimport.example.com")!;
  assert.equal(created.forwardScheme, "https");
  assert.equal(created.forwardPort, 8443);
  assert.equal(created.ssl, true);
});
