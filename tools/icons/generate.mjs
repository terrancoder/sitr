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

/**
 * Mark: a rounded-square tile pierced by a diamond lattice — a mashrabiya
 * screen, the traditional privacy screen (sitr = "covering, screen").
 * Returns [coverage 0..1, isHole] for pixel (x, y); holes render lighter.
 */
function sample(px, py, size) {
  const m = 0.04 * size; // outer margin
  const r = 0.22 * size; // corner radius
  const lo = m;
  const hi = size - m;
  // Rounded-rect signed test
  const qx = Math.max(lo + r - px, px - (hi - r), 0);
  const qy = Math.max(lo + r - py, py - (hi - r), 0);
  const inTile =
    px >= lo && px <= hi && py >= lo && py <= hi && qx * qx + qy * qy <= r * r;
  if (!inTile) return [false, false];
  // Diamond lattice: n×n cells across the inner area, diamond hole per cell.
  const n = size >= 48 ? 3 : 2;
  const inset = 0.17 * size;
  const span = size - 2 * inset;
  if (px >= inset && px < inset + span && py >= inset && py < inset + span) {
    const cell = span / n;
    const lx = ((px - inset) % cell) / cell - 0.5;
    const ly = ((py - inset) % cell) / cell - 0.5;
    if (Math.abs(lx) + Math.abs(ly) <= 0.44) return [true, true];
  }
  return [true, false];
}

function coverage(x, y, size) {
  let tile = 0;
  let hole = 0;
  for (const dx of [0.25, 0.75]) {
    for (const dy of [0.25, 0.75]) {
      const [inTile, isHole] = sample(x + dx, y + dy, size);
      if (inTile) tile++;
      if (isHole) hole++;
    }
  }
  return [tile / 4, hole / 4];
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
      const [tile, hole] = coverage(x, y, size);
      const o = row + 1 + x * 4;
      // Holes are near-white so the lattice reads at every size.
      const t = hole;
      raw[o] = Math.round(GREEN[0] * (1 - t) + 245 * t);
      raw[o + 1] = Math.round(GREEN[1] * (1 - t) + 250 * t);
      raw[o + 2] = Math.round(GREEN[2] * (1 - t) + 246 * t);
      raw[o + 3] = Math.round(tile * 255);
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
