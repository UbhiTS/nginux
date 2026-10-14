import { open } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";

// Bounded, async, reverse line reader for the access log. Replaces the synchronous
// "openSync -> allocate up-to-32MB -> readSync -> toString -> split" pattern that
// blocked the event loop on every filtered /logs lookup and per-host analytics
// open. Reads the tail in fixed chunks from the END backwards and yields COMPLETE
// lines newest-first, so a consumer that only needs `limit` matches stops early
// (`break`) after touching a few KB - never decoding the whole tail.
//
// Buffer-based (not string) leftover, so a multi-byte UTF-8 character split across
// a chunk boundary is never mis-decoded.

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_CHUNK = 256 * 1024;
const NEWLINE = 0x0a;

export async function* readLinesReverse(
  path: string,
  maxBytes: number = DEFAULT_MAX_BYTES,
  chunkSize: number = DEFAULT_CHUNK,
): AsyncGenerator<string> {
  if (!existsSync(path)) return;
  const size = statSync(path).size;
  if (size <= 0) return;
  // Don't read below this offset (bounded tail). When we stop here mid-line, that
  // partial first line is dropped - mirrors the old `lines.shift()` on a trim.
  const floor = size > maxBytes ? size - maxBytes : 0;
  const fh = await open(path, "r");
  try {
    let pos = size;
    let leftover = Buffer.alloc(0); // head bytes of the already-read (later) region, no preceding newline yet
    const buf = Buffer.allocUnsafe(chunkSize);
    while (pos > floor) {
      const want = Math.min(chunkSize, pos - floor);
      const start = pos - want;
      const { bytesRead } = await fh.read(buf, 0, want, start);
      pos = start;
      const combined = Buffer.concat([buf.subarray(0, bytesRead), leftover]);
      const nl = combined.indexOf(NEWLINE);
      if (nl === -1) { leftover = combined; continue; } // no complete line yet
      leftover = combined.subarray(0, nl); // incomplete head -> carry to the earlier chunk
      const lines = combined.subarray(nl + 1).toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) if (lines[i] !== "") yield lines[i];
    }
    // Reached the floor: the final leftover is the first line of the read region.
    // Only a genuine start-of-file line (floor === 0) is complete; a trimmed tail's
    // first line is partial and dropped.
    if (floor === 0 && leftover.length) {
      const first = leftover.toString("utf8");
      if (first !== "") yield first;
    }
  } finally {
    await fh.close();
  }
}

/** Existing log files in a rotation chain, newest-first: `[basePath, basePath.1, basePath.2, …]`. */
export function listLogFiles(basePath: string, maxRotated = 50): string[] {
  const out: string[] = [];
  if (existsSync(basePath)) out.push(basePath);
  for (let i = 1; i <= maxRotated; i++) {
    const rotated = `${basePath}.${i}`;
    if (existsSync(rotated)) out.push(rotated);
  }
  return out;
}

/** Stream complete lines newest-first across `basePath` AND its rotated `.1 .. .N`
 *  copies, up to `maxTotalBytes` across the chain. Lets 7d/30d IP searches and
 *  per-host analytics reach back across log rotations without stopping at the
 *  current live file. */
export async function* readLogChainReverse(
  basePath: string,
  maxTotalBytes: number = 256 * 1024 * 1024,
  chunkSize: number = DEFAULT_CHUNK,
  maxRotated = 50,
): AsyncGenerator<string> {
  let remaining = maxTotalBytes;
  for (const file of listLogFiles(basePath, maxRotated)) {
    if (remaining <= 0) break;
    let size = 0;
    try { size = statSync(file).size; } catch { continue; }
    if (size <= 0) continue;
    const budget = Math.min(size, remaining);
    remaining -= budget;
    for await (const line of readLinesReverse(file, budget, chunkSize)) {
      yield line;
    }
  }
}

