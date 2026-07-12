// Registrable-domain derivation (server/src/registrable.ts) - the DNS-01 zone
// picker. Pure function, no deps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registrableDomain } from "../src/registrable.ts";

test("derives the base domain for ordinary subdomains", () => {
  assert.equal(registrableDomain("plex.ubhi.io"), "ubhi.io");
  assert.equal(registrableDomain("a.b.c.example.com"), "example.com");
  assert.equal(registrableDomain("example.com"), "example.com");
  assert.equal(registrableDomain("grafana.example.net"), "example.net");
});

test("is public-suffix aware for multi-label suffixes (co.uk, com.au, ...)", () => {
  assert.equal(registrableDomain("plex.example.co.uk"), "example.co.uk");
  assert.equal(registrableDomain("a.b.example.co.uk"), "example.co.uk");
  assert.equal(registrableDomain("app.example.com.au"), "example.com.au");
  assert.equal(registrableDomain("x.example.co.jp"), "example.co.jp");
  assert.equal(registrableDomain("example.co.uk"), "example.co.uk", "already registrable");
});

test("normalises wildcard, trailing dot, and case", () => {
  assert.equal(registrableDomain("*.ubhi.io"), "ubhi.io");
  assert.equal(registrableDomain("PLEX.UBHI.IO"), "ubhi.io");
  assert.equal(registrableDomain("plex.ubhi.io."), "ubhi.io");
  assert.equal(registrableDomain("*.example.co.uk"), "example.co.uk");
});

test("never returns a bare public suffix (always includes the label above)", () => {
  // Even if only the suffix + one label is present, that's the registrable domain.
  assert.equal(registrableDomain("example.co.uk"), "example.co.uk");
  // A single label is returned as-is (degenerate; no zone to climb to).
  assert.equal(registrableDomain("localhost"), "localhost");
});

test("two different base domains derive independently (the whole point of 3.2)", () => {
  assert.equal(registrableDomain("plex.ubhits.com"), "ubhits.com");
  assert.equal(registrableDomain("plex.ubhims.com"), "ubhims.com");
  assert.notEqual(registrableDomain("a.ubhits.com"), registrableDomain("a.ubhims.com"));
});
