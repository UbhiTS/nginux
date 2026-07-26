import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PUBLIC = join(process.cwd(), "public");

function decodeRgbaPng(name: string) {
  const png = readFileSync(join(PUBLIC, name));
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  expect(png[24]).toBe(8); // bit depth
  expect(png[25]).toBe(6); // RGBA
  expect(png[28]).toBe(0); // non-interlaced

  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }

  const packed = inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  const rgba = Buffer.alloc(stride * height);
  let source = 0;
  for (let y = 0; y < height; y++) {
    const filter = packed[source++];
    for (let x = 0; x < stride; x++) {
      const raw = packed[source++];
      const left = x >= 4 ? rgba[(y * stride) + x - 4] : 0;
      const up = y > 0 ? rgba[((y - 1) * stride) + x] : 0;
      const upperLeft = y > 0 && x >= 4 ? rgba[((y - 1) * stride) + x - 4] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upperLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upperLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft;
      } else if (filter !== 0) {
        throw new Error(`Unsupported PNG filter ${filter}`);
      }
      rgba[(y * stride) + x] = (raw + predictor) & 0xff;
    }
  }
  return { width, height, rgba };
}

describe("installable app icons", () => {
  it.each([
    ["apple-touch-icon.png", 180],
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["app-icon-1024.png", 1024],
  ])("%s has the advertised square dimensions", (name, size) => {
    const png = readFileSync(join(PUBLIC, name));
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
  });

  it("keeps the Apple artwork out of the outer 8% iOS mask-crop band", () => {
    const { width, height, rgba } = decodeRgbaPng("apple-touch-icon.png");
    const background = rgba.subarray(0, 4);
    const band = Math.floor(width * 0.08);
    let colorfulPixels = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = ((y * width) + x) * 4;
        const sameAsBackground = background.every((value, channel) => rgba[offset + channel] === value);
        const inOuterBand = x < band || y < band || x >= width - band || y >= height - band;
        if (inOuterBand) expect(sameAsBackground).toBe(true);
        if (!sameAsBackground) colorfulPixels++;
      }
    }
    expect(colorfulPixels).toBeGreaterThan(width * height * 0.25);
  });
});
