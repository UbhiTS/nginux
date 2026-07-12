// Unit tests for the input-validation boundary. These guards emit user strings
// into real nginx config + onto the filesystem, so they are a security boundary:
// SSRF (isDangerousHost), path traversal (assertWithin), and nginx-directive
// injection (metachar rejection). Pure functions - no DB, no env setup needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertWithin, hasNginxMetachars, isDangerousHost, isHeaderName, isHost,
  isHostPort, isHostname, isIpOrCidr, isLocationPath, splitEntries, splitLines,
} from "../src/validate.ts";
import { join } from "node:path";

test("isHostname accepts FQDNs, wildcards, and bare labels", () => {
  for (const s of ["example.com", "sub.example.co.uk", "*.example.com", "localhost", "a-b.example.io"]) {
    assert.equal(isHostname(s), true, s);
  }
});
test("isHostname rejects junk, metachars, and traversal", () => {
  for (const s of ["", "-bad.com", "no_underscore.com", "a..b.com", "ex ample.com", "a;b.com", "../etc", "http://x.com"]) {
    assert.equal(isHostname(s), false, s);
  }
});

test("isHost accepts hostnames + IPv4 + IPv6, rejects nginx metachars (injection guard)", () => {
  for (const s of ["192.168.1.50", "10.0.0.1", "plex.local", "example.com", "::1", "[fe80::1]", "2001:db8::1"]) {
    assert.equal(isHost(s), true, s);
  }
  // A forwardHost is emitted into `proxy_pass http://<host>:<port>` - these must
  // never pass or an editor/agent could inject directives.
  for (const s of ["", "a;b", "a b", "host{}", "h'x", 'h"x', "a\\b", "a\nb", "1.2.3.4; return 403"]) {
    assert.equal(isHost(s), false, JSON.stringify(s));
  }
});

test("isHostPort requires host:port with a valid port", () => {
  assert.equal(isHostPort("192.168.1.50:3000"), true);
  assert.equal(isHostPort("plex.local:32400"), true);
  assert.equal(isHostPort("192.168.1.50:0"), false);
  assert.equal(isHostPort("192.168.1.50:70000"), false);
  assert.equal(isHostPort("192.168.1.50"), false);
  assert.equal(isHostPort("a b:80"), false);
});

test("isIpOrCidr accepts addresses + CIDRs, rejects bad masks/metachars", () => {
  for (const s of ["192.168.1.0/24", "10.0.0.1", "::1", "2001:db8::/32", "0.0.0.0/0"]) {
    assert.equal(isIpOrCidr(s), true, s);
  }
  for (const s of ["192.168.1.0/33", "10.0.0.1/x", "1.2.3.4/8/8", "1.2.3.4; deny all", ""]) {
    assert.equal(isIpOrCidr(s), false, s);
  }
});

test("isHeaderName only allows token chars", () => {
  assert.equal(isHeaderName("X-Frame-Options"), true);
  assert.equal(isHeaderName("Content-Type"), true);
  assert.equal(isHeaderName("X Bad"), false);
  assert.equal(isHeaderName("X:Bad"), false);
  assert.equal(isHeaderName(""), false);
});

test("isLocationPath requires a leading slash and rejects metachars", () => {
  assert.equal(isLocationPath("/grafana"), true);
  assert.equal(isLocationPath("/api/v1"), true);
  assert.equal(isLocationPath("grafana"), false); // no leading slash
  assert.equal(isLocationPath("/a b"), false);
  assert.equal(isLocationPath("/a{}"), false);
  assert.equal(isLocationPath("/a;return"), false);
});

test("hasNginxMetachars flags directive-breakout chars", () => {
  for (const s of ["a;b", "a{b", "a}b", "a\nb", "a\rb"]) assert.equal(hasNginxMetachars(s), true, JSON.stringify(s));
  for (const s of ["plain", "a-b_c.d", "/path/x"]) assert.equal(hasNginxMetachars(s), false, s);
});

test("isDangerousHost blocks cloud-metadata / link-local / unspecified (SSRF guard)", () => {
  for (const s of ["169.254.169.254", "169.254.0.1", "metadata.google.internal", "0.0.0.0", "0.1.2.3", "::", "fe80::1", "[::]"]) {
    assert.equal(isDangerousHost(s), true, s);
  }
});
test("isDangerousHost normalises IPv4-mapped IPv6 (regression: audit finding #18)", () => {
  // Both the dotted and hex forms of ::ffff:169.254.169.254 must be caught.
  assert.equal(isDangerousHost("::ffff:169.254.169.254"), true);
  assert.equal(isDangerousHost("[::ffff:169.254.169.254]"), true);
  assert.equal(isDangerousHost("::ffff:a9fe:a9fe"), true); // a9fe.a9fe = 169.254.169.254
  assert.equal(isDangerousHost("::169.254.169.254"), true);
});
test("isDangerousHost allows legitimate homelab LAN targets", () => {
  for (const s of ["192.168.1.50", "10.0.0.10", "172.16.0.5", "plex.local", "example.com"]) {
    assert.equal(isDangerousHost(s), false, s);
  }
});

test("assertWithin permits paths inside the base and blocks traversal", () => {
  const base = join(process.cwd(), "certs");
  assert.equal(assertWithin(base, join(base, "plex.ubhi.io", "fullchain.pem")).startsWith(base), true);
  assert.throws(() => assertWithin(base, join(base, "..", "..", "etc", "passwd")), /escapes/);
  assert.throws(() => assertWithin(base, join(base, "..", "other")), /escapes/);
});

// Canonical tokenisers - ONE definition shared by the validators and the nginx
// generator (they used to be copy-pasted in 3 files). If these ever diverge, a
// value could validate one way and generate another.
test("splitLines: newline-separated, trimmed, drops blanks", () => {
  assert.deepEqual(splitLines("a\n b \n\n\tc\t\n"), ["a", "b", "c"]);
  assert.deepEqual(splitLines(""), []);
  // A CRLF upload: split on \n then trim removes the trailing \r.
  assert.deepEqual(splitLines("X-Foo: a\r\nX-Bar: b"), ["X-Foo: a", "X-Bar: b"]);
});
test("splitEntries: whitespace/comma-separated, trimmed, drops blanks", () => {
  assert.deepEqual(splitEntries("1.2.3.4, 5.6.7.8"), ["1.2.3.4", "5.6.7.8"]);
  assert.deepEqual(splitEntries("10.0.0.0/8\n  192.168.0.0/16 "), ["10.0.0.0/8", "192.168.0.0/16"]);
  assert.deepEqual(splitEntries("   "), []);
});
