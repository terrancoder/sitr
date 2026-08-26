/**
 * Deterministic Safari Web Extension stager: assembles the resource
 * directory the macOS appex bundles, from exactly the files the extension
 * needs at runtime — the Safari sibling of pack.mjs.
 *
 * Differences from the Chrome package, each deliberate:
 *  - manifest: `background` becomes a non-persistent event page (Safari's
 *    reliable path; its service-worker path lacks the host-permission CORS
 *    exemption and has a history of lifecycle bugs), and the Chrome-only
 *    `storage.managed_schema` key is dropped (no managed storage in Safari).
 *  - managed_schema.json is excluded — nothing can deliver it.
 *  - extension/_metadata (Chrome-generated) is excluded.
 *
 * Channels: --channel devid (default) stages the full UI. --channel mas is
 * REFUSED for now: the Mac App Store build must not contain the household
 * purchase-steering strings (App Store 3.1.1; the repo's own smoke-test and
 * risk-register gates), and a string-stripping build step has not been
 * built yet — refusing beats shipping a bundle that fails our own gates.
 *
 * Reproducibility: files are copied byte-identically in sorted order and a
 * checksums.json (sha256 per file) is emitted alongside, so CI can diff
 * two stagings and publish the hashes.
 *
 * Usage: node tools/pack/stage-safari.mjs [out-dir] [--channel devid|mas]
 *        (default out-dir: build/safari-extension)
 */
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const EXT = join(ROOT, "extension");

const args = process.argv.slice(2);
const channelIdx = args.indexOf("--channel");
const channel = channelIdx >= 0 ? args[channelIdx + 1] : "devid";
const positional = args.filter(
  (a, i) => i !== channelIdx && (channelIdx < 0 || i !== channelIdx + 1),
);
const outDir = resolve(positional[0] ?? join(ROOT, "build/safari-extension"));

if (channel === "mas") {
  console.error(
    "stage-safari: the mas channel is not implemented — the Mac App Store " +
      "bundle must strip the household purchase-steering strings " +
      "(store-review-risk-register.md) and that build step does not exist " +
      "yet. Stage the devid channel, or build the stripping step first.",
  );
  process.exit(2);
}
if (channel !== "devid") {
  console.error(`stage-safari: unknown channel "${channel}"`);
  process.exit(2);
}

// Runtime files only — like pack.mjs, minus the Chrome-only managed schema.
const INCLUDE = [
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
if (!files.includes("dist/background/service-worker.js")) {
  console.error("stage-safari: dist missing — run npm run build first");
  process.exit(1);
}

// --- Safari manifest: derived from the Chrome manifest, minimal diff. ---
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
delete manifest.storage; // Chrome-only managed_schema pointer
// Background stays the Chrome manifest's MV3 service worker (module):
// MV3 validators reject the event-page shapes (`persistent`,
// `background.page`), and the worker entry is an ES module that plain
// `background.scripts` cannot load. Safari runs MV3 service workers since
// 16.4; its known SW quirk (host-permission CORS not applying in the SW
// context) affects only the Family-sync fetch and is tracked in T13.
// Safari gates DNR redirect/modifyHeaders actions (the SafeSearch rules)
// behind this extra permission plus granted host access; without it the
// rules are silently ignored. Chrome doesn't need it, so it is added only
// to the Safari manifest.
if (!manifest.permissions.includes("declarativeNetRequestWithHostAccess")) {
  manifest.permissions = [
    ...manifest.permissions,
    "declarativeNetRequestWithHostAccess",
  ];
}

// Stage in memory first, flush all-or-nothing (house atomicity rule).
const staged = new Map();
staged.set("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
for (const rel of files) {
  staged.set(rel, readFileSync(join(EXT, rel)));
}

const hashes = {};
for (const [rel, body] of [...staged.entries()].sort(([a], [b]) =>
  a < b ? -1 : 1,
)) {
  hashes[rel] = createHash("sha256").update(body).digest("hex");
}
staged.set("checksums.json", JSON.stringify(hashes, null, 2) + "\n");

rmSync(outDir, { recursive: true, force: true });
for (const [rel, body] of staged) {
  mkdirSync(join(outDir, dirname(rel)), { recursive: true });
  writeFileSync(join(outDir, rel), body);
}
console.log(
  `staged ${staged.size} files (channel ${channel}) -> ${outDir}`,
);
