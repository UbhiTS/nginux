import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { resolveSafeOutboundHost, safeOutboundRequest } from "../src/outbound.ts";

test("outbound resolver rejects canonicalized metadata and full IPv6 link-local space", async () => {
  for (const host of ["169.254.169.254", "0xa9.0xfe.0xa9.0xfe", "fe90::1"]) {
    await assert.rejects(() => resolveSafeOutboundHost(host), /not allowed|blocked|link-local/i, host);
  }
});

test("safe outbound HTTP pins a vetted address, preserves Host, and never follows redirects", async () => {
  let requests = 0;
  let seenHost = "";
  const server = http.createServer((req, res) => {
    requests++;
    seenHost = req.headers.host ?? "";
    res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await safeOutboundRequest(`http://localhost:${address.port}/hook`, { method: "POST", body: "{}" });
    assert.equal(response.status, 302);
    assert.equal(response.ok, false);
    assert.equal(requests, 1, "the metadata redirect is returned, never followed");
    assert.equal(seenHost, `localhost:${address.port}`, "the original virtual host is preserved while dialing the vetted IP");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
