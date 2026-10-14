// Async reverse line reader (server/src/logtail.ts) - the replacement for the
// synchronous 32MB access-log read. Verified against a naive reverse-split.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listLogFiles, readLinesReverse, readLogChainReverse } from "../src/logtail.ts";
import { pruneOldRotatedLogs } from "../src/logrotate.ts";

const dir = mkdtempSync(join(tmpdir(), "logtail-"));
const write = (name: string, content: string) => { const p = join(dir, name); writeFileSync(p, content); return p; };
async function collect(path: string, maxBytes?: number, chunk?: number): Promise<string[]> {
  const out: string[] = [];
  for await (const line of readLinesReverse(path, maxBytes ?? 32 * 1024 * 1024, chunk ?? 256 * 1024)) out.push(line);
  return out;
}
// Naive reference: all non-empty lines, newest-first.
const naiveReverse = (content: string) => content.split("\n").filter((l) => l !== "").reverse();

test("yields non-empty lines newest-first (with and without a trailing newline)", async () => {
  const withNl = "a\nbb\nccc\n";
  assert.deepEqual(await collect(write("a.log", withNl)), naiveReverse(withNl));
  const noNl = "a\nbb\nccc";
  assert.deepEqual(await collect(write("b.log", noNl)), naiveReverse(noNl));
});

test("is correct across MANY chunk sizes (multi-byte UTF-8 safe across boundaries)", async () => {
  // Lines of varying length incl. multibyte chars, > any small chunk size.
  const lines = Array.from({ length: 200 }, (_, i) => `line-${i}-café-${"x".repeat(i % 40)}-日本`);
  const content = lines.join("\n") + "\n";
  const p = write("c.log", content);
  const expected = naiveReverse(content);
  for (const chunk of [1, 3, 7, 16, 64, 500, 4096]) {
    assert.deepEqual(await collect(p, 32 * 1024 * 1024, chunk), expected, `chunk=${chunk}`);
  }
});

test("early stop reads only what the consumer takes (newest lines first)", async () => {
  const content = Array.from({ length: 1000 }, (_, i) => `l${i}`).join("\n") + "\n";
  const p = write("d.log", content);
  const first3: string[] = [];
  for await (const line of readLinesReverse(p, 32 * 1024 * 1024, 64)) { first3.push(line); if (first3.length === 3) break; }
  assert.deepEqual(first3, ["l999", "l998", "l997"], "newest 3 lines, then stopped");
});

test("maxBytes trims the tail and drops the resulting partial first line", async () => {
  // 10 lines "aaa.."(each 4 bytes incl \n). Cap so we only read the last few.
  const lines = Array.from({ length: 10 }, (_, i) => `L${i.toString().padStart(2, "0")}`); // 3 chars each
  const content = lines.join("\n") + "\n"; // 4 bytes per line
  const p = write("e.log", content);
  // Cap to ~14 bytes -> the last ~3 full lines; the partial line at the cut is dropped.
  const got = await collect(p, 14, 8);
  assert.ok(got.length >= 2 && got.length <= 4, `bounded read returned a small tail (${got.length})`);
  assert.equal(got[0], "L09", "newest line is intact");
  // Every returned line must be a real, whole line from the file.
  for (const g of got) assert.ok(lines.includes(g), `"${g}" is a whole line`);
});

test("empty / missing file yields nothing", async () => {
  assert.deepEqual(await collect(write("empty.log", "")), []);
  assert.deepEqual(await collect(join(dir, "nope.log")), []);
});

test("readLogChainReverse walks access.log -> .1 -> .2 newest-first and honors maxTotalBytes", async () => {
  const base = write("chain.log", "live-1\nlive-2\n");
  write("chain.log.1", "rot1-a\nrot1-b\n");
  write("chain.log.2", "rot2-x\nrot2-y\n");
  assert.equal(listLogFiles(base).length, 3);

  const all: string[] = [];
  for await (const line of readLogChainReverse(base)) all.push(line);
  assert.deepEqual(all, ["live-2", "live-1", "rot1-b", "rot1-a", "rot2-y", "rot2-x"]);

  // Budget that covers only the live file + .1 (each is 14 bytes) stops before .2.
  const bounded: string[] = [];
  for await (const line of readLogChainReverse(base, 28)) bounded.push(line);
  assert.deepEqual(bounded, ["live-2", "live-1", "rot1-b", "rot1-a"]);
});

test("pruneOldRotatedLogs removes rotated files older than 30 days or past keep count", () => {
  const base = write("prune.log", "live\n");
  const r1 = write("prune.log.1", "fresh\n");
  const r2 = write("prune.log.2", "stale-35d\n");
  const r3 = write("prune.log.3", "beyond-keep\n");
  const oldSec = Math.floor((Date.now() - 35 * 86400_000) / 1000);
  utimesSync(r2, oldSec, oldSec);

  const removed = pruneOldRotatedLogs("prune.log", 2, 30 * 86400_000, dir);
  assert.equal(removed, 2, "removes both the >30d file (.2) and the >keep file (.3)");
  assert.equal(existsSync(base), true);
  assert.equal(existsSync(r1), true);
  assert.equal(existsSync(r2), false);
  assert.equal(existsSync(r3), false);
});

process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
