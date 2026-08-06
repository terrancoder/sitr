/**
 * Deterministic extension packer: builds sitr-<version>.zip for the Chrome
 * Web Store from exactly the files the extension needs at runtime.
 *
 * Reproducibility: entries are sorted, timestamps fixed to a constant, and
 * files are STORED uncompressed — so the same inputs always produce a
 * byte-identical zip whose SHA-256 anyone can verify against CI's.
 *
 * Usage: node tools/pack/pack.mjs [out-dir]   (default: build/)
 */
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const EXT = join(ROOT, "extension");
const outDir = resolve(process.argv[2] ?? join(ROOT, "build"));

// Runtime files only. No sources, no .d.ts, no _metadata, no store-listing.
const INCLUDE = [
  /^manifest\.json$/,
  /^managed_schema\.json$/,
  /^dist\/.*\.js$/,
  /^rulesets\/.*\.json$/,
  /^public\/.*\.png$/,
  /^src\/.*\.html$/,
];

function walk(dir, base = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

const files = walk(EXT).filter((rel) => INCLUDE.some((re) => re.test(rel)));
if (files.length === 0) {
  console.error("pack: no files matched — run npm run build first");
  process.exit(1);
}
const missing = [
  "manifest.json",
  "managed_schema.json", // manifest storage.managed_schema — Chrome refuses to load without it
  "dist/background/service-worker.js",
].filter((f) => !files.includes(f));
if (missing.length) {
  console.error(`pack: required files missing: ${missing.join(", ")} — run npm run build`);
  process.exit(1);
}

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

// Fixed DOS date/time: 2026-01-01 00:00:00 — constant for reproducibility.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

const localParts = [];
const centralParts = [];
let offset = 0;

for (const rel of files) {
  const data = readFileSync(join(EXT, rel));
  const name = Buffer.from(rel, "utf8");
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(0, 8); // method: store
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  localParts.push(local, name, data);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10); // method: store
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  centralParts.push(central, name);

  offset += local.length + name.length + data.length;
}

const centralSize = centralParts.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

const zip = Buffer.concat([...localParts, ...centralParts, end]);
const { version } = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `sitr-${version}.zip`);
writeFileSync(outPath, zip);
const sha = createHash("sha256").update(zip).digest("hex");
console.log(`packed ${files.length} files (${(statSync(outPath).size / 1024).toFixed(0)} KiB)`);
console.log(`  ${outPath}`);
console.log(`  sha256: ${sha}`);
