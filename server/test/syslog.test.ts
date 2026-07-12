// Syslog audit sink (server/src/syslog.ts): URL parsing, RFC 5424 formatting, and
// a real UDP round-trip. No DB/env needed - these are pure + a local socket.
import { test } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { parseSyslogUrl, isSyslogUrl, formatRfc5424, sendSyslog } from "../src/syslog.ts";

const ev = { id: "evt-1", ts: "2026-07-12T00:00:00.000Z", type: "security.ip_banned", data: { severity: "danger", summary: "banned 1.2.3.4", ip: "1.2.3.4" } };

test("parseSyslogUrl handles udp/tcp + default port; isSyslogUrl detects the scheme", () => {
  assert.deepEqual(parseSyslogUrl("syslog://siem.local"), { proto: "udp", host: "siem.local", port: 514 });
  assert.deepEqual(parseSyslogUrl("syslog://siem.local:1514"), { proto: "udp", host: "siem.local", port: 1514 });
  assert.deepEqual(parseSyslogUrl("syslog+tcp://10.0.0.9:601"), { proto: "tcp", host: "10.0.0.9", port: 601 });
  assert.equal(parseSyslogUrl("https://example.com"), null, "http URLs are not syslog");
  assert.equal(isSyslogUrl("syslog://x"), true);
  assert.equal(isSyslogUrl("https://x"), false);
});

test("formatRfc5424 encodes the priority, version, ids, and JSON detail", () => {
  const line = formatRfc5424("box", ev);
  // facility local0 (16)*8 + danger->err(3) = 131.
  assert.ok(line.startsWith("<131>1 2026-07-12T00:00:00.000Z box nginux - evt-1 - "), `unexpected header: ${line}`);
  assert.ok(line.includes("security.ip_banned"), "carries the event type");
  assert.ok(line.includes('"ip":"1.2.3.4"'), "carries the JSON detail");
  // An info event uses severity 6 -> priority 134.
  assert.ok(formatRfc5424("box", { ...ev, data: { severity: "info" } }).startsWith("<134>1 "));
});

test("sendSyslog delivers a UDP datagram to a listening collector", async () => {
  const server = dgram.createSocket("udp4");
  const received = new Promise<string>((resolve) => server.once("message", (m) => resolve(m.toString())));
  await new Promise<void>((r) => server.bind(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const status = await sendSyslog({ proto: "udp", host: "127.0.0.1", port }, ev);
    assert.equal(status, "ok", "UDP send reports ok");
    const msg = await received;
    assert.ok(msg.includes("security.ip_banned"), "the collector received the event");
    assert.ok(msg.startsWith("<131>1 "), "…as a well-formed RFC 5424 line");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("sendSyslog to a dead TCP port fails soft (a status string, never a throw)", async () => {
  const status = await sendSyslog({ proto: "tcp", host: "127.0.0.1", port: 1 }, ev);
  assert.ok(status.startsWith("failed:"), "a broken sink returns a failure status, doesn't reject");
});
