/**
 * Deterministic icon generator — no dependencies, no timestamps.
 * Emits a crescent mark (Sitr green #1a7f37) as PNG at the four sizes
 * Chrome wants. Output depends only on this file's constants, so icons are
 * reproducible like every other build artifact.
 *
 * Usage: node tools/icons/generate.mjs extension/public
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: node generate.mjs <output-dir>");
  process.exit(2);
}

const GREEN = [0x1a, 0x7f, 0x37];

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 4x supersampled coverage of the crescent at pixel (x, y), 0..1. */
function coverage(x, y, size) {
  const R = 0.46 * size;
  const cx = 0.48 * size;
  const cy = 0.5 * size;
  // Inner "bite" circle offset toward the top-right makes the crescent.
  const r = 0.38 * size;
  const bx = 0.66 * size;
  const by = 0.38 * size;
  let hits = 0;
  for (const dx of [0.25, 0.75]) {
    for (const dy of [0.25, 0.75]) {
      const px = x + dx;
      const py = y + dy;
      const inOuter = (px - cx) ** 2 + (py - cy) ** 2 <= R * R;
      const inBite = (px - bx) ** 2 + (py - by) ** 2 <= r * r;
      if (inOuter && !inBite) hits++;
    }
  }
  return hits / 4;
}

function png(size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const a = Math.round(coverage(x, y, size) * 255);
      const o = row + 1 + x * 4;
      raw[o] = GREEN[0];
      raw[o + 1] = GREEN[1];
      raw[o + 2] = GREEN[2];
      raw[o + 3] = a;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(outDir, `icon${size}.png`), png(size));
}
console.log(`wrote icon16/32/48/128.png -> ${outDir}`);
