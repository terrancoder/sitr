/**
 * Import CLI — writes the `imported.txt` tier of each list named in
 * blocklist/imports/sources.json, plus blocklist/imports/ATTRIBUTION.md.
 * A build tool only; nothing here ships in any client.
 *
 * Usage: node tools/import/dist/cli.js [--blocklist blocklist] [--out <dir>]
 *          [--input <source-id>=<file>]... [--date YYYY-MM-DD]
 *
 *  --out    where to write (default: the blocklist directory itself). Use a
 *           scratch directory for a dry run.
 *  --input  read that source's upstream from a local file instead of its
 *           URL (tests and offline runs).
 *  --date   retrieval date to record. Default: kept from the existing
 *           imported.txt under --blocklist when the upstream SHA-256 is
 *           unchanged (so the same bytes always give the same output, also
 *           into a scratch --out), else today (UTC).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseEntries } from "../../compiler/dist/parse.js";
import { indexNeverBlock } from "../../compiler/dist/guards.js";
import { loadPublicSuffixList } from "../../compiler/dist/psl.js";
import {
  type Declaration,
  REASONS,
  renderAttribution,
  runImport,
  sha256Hex,
  type UpstreamSnapshot,
} from "./importer.js";

function args(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1] !== undefined) out.push(process.argv[i + 1]!);
  });
  return out;
}

function die(message: string): never {
  console.error(`import: ${message}`);
  process.exit(1);
}

function names(file: string, required: boolean): string[] {
  if (!existsSync(file)) {
    if (required) die(`missing ${file}`);
    return [];
  }
  const parsed = parseEntries(readFileSync(file, "utf8"), file);
  if (!parsed.ok) {
    die(parsed.error.map((e) => `${e.file}:${e.line}: ${e.message}`).join("\n"));
  }
  return parsed.value.map((e) => e.domain);
}

/** The date recorded for `id` in an existing imported.txt, if its hash matches. */
function previousDate(file: string, id: string, sha: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const m = new RegExp(
    `^# source: ${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n(?:#   .*\\n)*?#   retrieved: (\\S+)\\n#   sha256: (\\S+)$`,
    "m",
  ).exec(readFileSync(file, "utf8"));
  return m !== null && m[2] === sha ? m[1] : undefined;
}

const blocklist = args("blocklist")[0] ?? "blocklist";
const outRoot = args("out")[0] ?? blocklist;
const dateArg = args("date")[0];
if (dateArg !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) die("--date must be YYYY-MM-DD");
const inputs = new Map(
  args("input").map((a) => {
    const i = a.indexOf("=");
    if (i <= 0) die(`--input expects <source-id>=<file>, got "${a}"`);
    return [a.slice(0, i), a.slice(i + 1)] as const;
  }),
);

const declFile = join(blocklist, "imports", "sources.json");
const decl = JSON.parse(readFileSync(declFile, "utf8")) as Declaration;
for (const s of decl.sources) {
  for (const k of ["id", "target", "url", "format", "license", "attribution"] as const) {
    if (typeof s[k] !== "string" || s[k] === "") die(`${declFile}: a source is missing "${k}"`);
  }
  if (s.format !== "hosts" && s.format !== "domains") die(`${declFile}: "${s.id}" format must be hosts or domains`);
  if (!existsSync(join(blocklist, s.target))) die(`${declFile}: "${s.id}" target ${s.target} does not exist`);
}
for (const id of inputs.keys()) {
  if (!decl.sources.some((s) => s.id === id)) die(`--input names unknown source "${id}"`);
}

const curated = new Map<string, Set<string>>();
for (const group of ["sources", "optional"]) {
  const dir = join(blocklist, group);
  if (!existsSync(dir)) continue;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    curated.set(`${group}/${e.name}`, new Set(names(join(dir, e.name, "domains.txt"), false)));
  }
}

const today = new Date().toISOString().slice(0, 10);
const snapshots = new Map<string, UpstreamSnapshot>();
for (const s of decl.sources) {
  const local = inputs.get(s.id);
  let bytes: Uint8Array;
  if (local !== undefined) {
    bytes = readFileSync(local);
  } else {
    const res = await fetch(s.url);
    if (!res.ok) die(`${s.id}: GET ${s.url} -> ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  // Read the date from the blocklist's own copy, not --out: a dry run into
  // a scratch directory must give the same bytes a real run would.
  const retrieved =
    dateArg ?? previousDate(join(blocklist, s.target, "imported.txt"), s.id, sha256Hex(bytes)) ?? today;
  snapshots.set(s.id, { bytes, retrieved });
}

const outputs = runImport(decl, snapshots, {
  psl: loadPublicSuffixList(),
  neverBlock: indexNeverBlock(names(join(blocklist, "policy", "never-block.txt"), true)),
  exclusions: names(join(blocklist, "policy", "import-exclusions.txt"), false),
  curated,
});

for (const o of outputs) {
  mkdirSync(join(outRoot, o.target), { recursive: true });
  writeFileSync(join(outRoot, o.target, "imported.txt"), o.body);
  console.log(`${o.target}/imported.txt: ${o.domains.length} entries`);
  for (const r of o.sources) {
    console.log(`  ${r.id}: lines ${r.upstreamLines}, names ${r.upstreamNames}, kept ${r.kept}, sha256 ${r.sha256}`);
    for (const reason of REASONS) {
      if (r.rejected[reason] > 0) {
        console.log(`    ${reason}: ${r.rejected[reason]} (e.g. ${r.examples[reason].join(", ")})`);
      }
    }
  }
}
mkdirSync(join(outRoot, "imports"), { recursive: true });
writeFileSync(join(outRoot, "imports", "ATTRIBUTION.md"), renderAttribution(decl));
