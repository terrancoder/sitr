/**
 * Deterministic Safari Web Extension stager: assembles the resource
 * directory the macOS appex bundles, from exactly the files the extension
 * needs at runtime — the Safari sibling of pack.mjs.
 *
 * Differences from the Chrome package, each deliberate:
 *  - manifest: the MV3 module service worker is kept UNCHANGED (Safari
 *    validates the same MV3 background shapes Chrome does; the event-page
 *    forms `persistent`/`background.page` are rejected in MV3), the
 *    Chrome-only `storage.managed_schema` key is dropped (no managed
 *    storage in Safari), and `declarativeNetRequestWithHostAccess` is
 *    added (Safari gates redirect/header rules behind it).
 *  - managed_schema.json is excluded — nothing can deliver it.
 *  - extension/_metadata (Chrome-generated) is excluded.
 *
 * Channels: --channel devid (default) stages the full UI. --channel mas
 * stages the join-only App Store variant: the full-channel module
 * (dist/options/fullChannel.js — household creation + entitlement token)
 * is EXCLUDED, its #full-channel-only block is stripped from options.html,
 * and a grep gate then proves the bundle carries none of the
 * purchase-steering strings the store risk register forbids (guideline
 * 3.1.1). The gate failing is a build failure, never a warning.
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
let channel = "devid";
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--channel") {
    channel = args[++i];
  } else if (a.startsWith("--channel=")) {
    channel = a.slice("--channel=".length);
  } else if (a.startsWith("-")) {
    console.error(`stage-safari: unknown option "${a}"`);
    process.exit(2);
  } else {
    positional.push(a);
  }
}
if (positional.length > 1) {
  console.error("stage-safari: at most one output directory");
  process.exit(2);
}
const outDir = resolve(
  positional[0] ??
    join(ROOT, channel === "mas" ? "build/safari-extension-mas" : "build/safari-extension"),
);

if (channel !== "devid" && channel !== "mas") {
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
  if (channel === "mas" && rel === "dist/options/fullChannel.js") continue;
  staged.set(rel, readFileSync(join(EXT, rel)));
}

if (channel === "mas") {
  // Strip the full-channel block from options.html. The block is kept flat
  // in source (no nested divs) precisely so this excision is trivial and
  // verifiable; assert that stays true rather than silently mis-cutting.
  const rel = "src/options/options.html";
  let html = staged.get(rel).toString("utf8");
  const open = html.indexOf('<div id="full-channel-only">');
  const close = html.indexOf("</div>", open);
  if (open < 0 || close < 0) {
    console.error("stage-safari: #full-channel-only block not found in options.html");
    process.exit(1);
  }
  const inner = html.slice(open + 1, close);
  if (inner.includes("<div")) {
    console.error("stage-safari: #full-channel-only must stay flat (nested <div> found)");
    process.exit(1);
  }
  html = html.slice(0, open) + html.slice(close + "</div>".length);
  staged.set(rel, html);

  // 3.1.1 gate: the staged bundle must be free of purchase-steering copy.
  // Pattern list mirrors Udocs/store-review-risk-register.md's owner check.
  // Human-copy surfaces only: the machine-generated rulesets are domain
  // lists where \bbuy\b/polar-style patterns would be false positives.
  const COPY_SURFACE = /^(manifest\.json|src\/.*\.html|dist\/.*\.js)$/;
  const FORBIDDEN = /subscri|checkout|sitrshield\.com\/family|purchase|\bbuy\b|polar|upgrade/i;
  const offenders = [];
  for (const [name, body] of staged) {
    if (!COPY_SURFACE.test(name)) continue;
    const text = body.toString("utf8");
    const m = FORBIDDEN.exec(text);
    if (m) offenders.push(`${name}: "${m[0]}"`);
  }
  if (offenders.length > 0) {
    console.error("stage-safari: mas gate FAILED — purchase-steering strings present:");
    for (const o of offenders) console.error("  " + o);
    process.exit(1);
  }
}

staged.set("channel.json", JSON.stringify({ channel }) + "\n");

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
