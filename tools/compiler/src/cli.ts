/**
 * Sitr ruleset compiler CLI.
 *
 * Usage: node cli.js --blocklist <blocklist/sources> --out <extension/rulesets>
 *                    [--safari-out <dir>] [--android-out <dir>]
 *
 * Reads every `<category>/` under the blocklist sources directory — the
 * hand-curated `domains.txt` plus the machine-written `imported.txt`, either
 * optional but not both absent — compiles each to a DNR block ruleset, emits
 * the SafeSearch ruleset, and writes a manifest of SHA-256 hashes alongside
 * the output for integrity checks and reproducible-build verification.
 *
 * Next to the sources directory (its parent, `blocklist/`) it also reads:
 *  - `policy/never-block.txt` (required) and `policy/import-exclusions.txt`
 *    (optional) for the guards in guards.ts;
 *  - `optional/lists.json` + `optional/<id>/` — opt-in lists, off by
 *    default, emitted as separate artifacts only for the platforms each
 *    declares, never merged into a category or the Safari default list.
 * Every list passes the public-suffix, never-block and duplicate guards;
 * any failure stops the build with file and line.
 *
 * With `--safari-out`, also emits Safari content-blocker JSON per category
 * (both tiers) plus the blocker's bundled fallback list (the hand-curated
 * tier of the default-on categories only, see buildDefaultBlockerList);
 * with `--notice-out <file>`, the licence and attribution notice
 * (notice.ts) from `imports/ATTRIBUTION.md`; with `--android-out`, plain
 * sorted domain lists plus the DNS SafeSearch host map. Each output
 * directory gets its own checksums.json. When the flags are absent the DNR
 * output is byte-identical to what this CLI has always produced.
 *
 * Exit code is non-zero on ANY issue; nothing is partially written on failure
 * (outputs are staged in memory and flushed only after all categories compile).
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { type Entry, parseDomainList, parseEntries } from "./parse.js";
import {
  checkCrossListDuplicates,
  checkExclusions,
  checkNeverBlock,
  checkIpAddresses,
  checkPublicSuffixes,
  indexNeverBlock,
  mergeTiers,
  type MergedList,
} from "./guards.js";
import { loadPublicSuffixList } from "./psl.js";
import { compileBlockRuleset, serializeRuleset } from "./compile.js";
import { safesearchRules } from "./safesearch.js";
import { SITE_MEDIA_HOSTS, compileGreylistRuleset, mediaAllRules } from "./greylist.js";
import {
  buildDefaultBlockerList,
  checkSafariBudget,
  compileSafariRuleset,
  SAFARI_RULE_BUDGET,
  SAFARI_RULE_RESERVE,
  serializeSafariRuleset,
  type SafariRule,
} from "./emitSafari.js";
import {
  safesearchHostsMap,
  serializeDomainList,
  serializeSafesearchHosts,
  serializeStrictSearchHosts,
  strictSearchHosts,
} from "./emitAndroid.js";
import { readNotice } from "./notice.js";
import type { CompileIssue } from "./types.js";

function arg(name: string): string {
  const v = optionalArg(name);
  if (v === undefined) {
    console.error(`missing required argument --${name}`);
    process.exit(2);
  }
  return v;
}

function optionalArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(issues: CompileIssue[]): never {
  for (const issue of issues) {
    const loc = issue.file
      ? `${issue.file}${issue.line !== undefined ? `:${issue.line}` : ""}: `
      : "";
    console.error(`error(${issue.kind}): ${loc}${issue.message}`);
  }
  process.exit(1);
}

const sourcesDir = arg("blocklist");
const outDir = arg("out");
const safariOutDir = optionalArg("safari-out");
const androidOutDir = optionalArg("android-out");
// The media greylist (T12) is wired explicitly — never discovered under
// sources/ — so it cannot leak into the Safari/Android emitters.
const greylistFile = optionalArg("greylist");
const noticeOut = optionalArg("notice-out");

const blocklistRoot = dirname(sourcesDir);
const issues: CompileIssue[] = [];

function readOptionalFile(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    issues.push({
      kind: "io-error",
      message: `cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`,
    });
    return undefined;
  }
}

function readEntries(file: string): Entry[] {
  const content = readOptionalFile(file);
  if (content === undefined) return [];
  const parsed = parseEntries(content, file);
  if (!parsed.ok) {
    issues.push(...parsed.error);
    return [];
  }
  return parsed.value;
}

type Platform = "extension" | "safari" | "android";
const ALL_PLATFORMS: Platform[] = ["extension", "safari", "android"];

interface ListSource {
  id: string;
  dir: string;
  optional: boolean;
  platforms: Platform[];
  neverBlockExempt: boolean;
  curated: Entry[];
  imported: Entry[];
}

function readList(
  id: string,
  dir: string,
  meta: Pick<ListSource, "optional" | "platforms" | "neverBlockExempt">,
): ListSource {
  const curatedFile = join(dir, "domains.txt");
  const importedFile = join(dir, "imported.txt");
  if (!existsSync(curatedFile) && !existsSync(importedFile)) {
    issues.push({
      kind: "io-error",
      message: `${dir} has neither domains.txt nor imported.txt`,
    });
  }
  const list = {
    id,
    dir,
    ...meta,
    curated: readEntries(curatedFile),
    imported: readEntries(importedFile),
  };
  if (list.curated.length + list.imported.length === 0) {
    issues.push({ kind: "empty-category", message: `no domains in ${dir}` });
  }
  return list;
}

function subdirs(dir: string): string[] {
  // Sorted listing keeps processing order (and output order) deterministic.
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

const categories = subdirs(sourcesDir);
if (categories.length === 0) {
  fail([
    {
      kind: "io-error",
      message: `no category directories found under ${sourcesDir}`,
    },
  ]);
}

const lists: ListSource[] = categories.map((id) =>
  readList(id, join(sourcesDir, id), {
    optional: false,
    platforms: ALL_PLATFORMS,
    neverBlockExempt: false,
  }),
);

// Optional lists: every directory must be declared and every declaration
// must have a directory, so nothing ships (or silently doesn't) by accident.
const optionalDir = join(blocklistRoot, "optional");
const declarationFile = join(optionalDir, "lists.json");
const declarationText = readOptionalFile(declarationFile);
const optionalDirs = existsSync(optionalDir) ? subdirs(optionalDir) : [];
let declarations: Record<string, unknown> = {};
if (declarationText !== undefined) {
  try {
    declarations = JSON.parse(declarationText) as Record<string, unknown>;
  } catch (e) {
    issues.push({
      kind: "invalid-declaration",
      message: `not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      file: declarationFile,
    });
  }
}
for (const id of [...new Set([...optionalDirs, ...Object.keys(declarations)])].sort()) {
  const decl = declarations[id] as
    | { platforms?: unknown; neverBlockExempt?: unknown; description?: unknown }
    | undefined;
  const bad = (message: string): void => {
    issues.push({ kind: "invalid-declaration", message: `"${id}": ${message}`, file: declarationFile });
  };
  if (decl === undefined || typeof decl !== "object" || decl === null) {
    bad("directory optional/" + id + " is not declared in lists.json");
    continue;
  }
  if (!optionalDirs.includes(id)) {
    bad(`declared but optional/${id}/ does not exist`);
    continue;
  }
  if (categories.includes(id)) bad("an optional list may not share a category's id");
  const unknown = Object.keys(decl).filter(
    (k) => !["platforms", "neverBlockExempt", "description"].includes(k),
  );
  if (unknown.length > 0) bad(`unknown key(s) ${unknown.join(", ")}`);
  const platforms = decl.platforms;
  if (
    !Array.isArray(platforms) ||
    platforms.length === 0 ||
    !platforms.every((p) => ALL_PLATFORMS.includes(p as Platform))
  ) {
    bad(`"platforms" must be a non-empty subset of ${ALL_PLATFORMS.join(", ")}`);
    continue;
  }
  if (decl.neverBlockExempt !== undefined && typeof decl.neverBlockExempt !== "boolean") {
    bad(`"neverBlockExempt" must be true or false`);
  }
  lists.push(
    readList(id, join(optionalDir, id), {
      optional: true,
      platforms: ALL_PLATFORMS.filter((p) => platforms.includes(p)),
      neverBlockExempt: decl.neverBlockExempt === true,
    }),
  );
}

// Guards. Collect everything, then fail once with the full picture.
const neverBlockFile = join(blocklistRoot, "policy", "never-block.txt");
if (!existsSync(neverBlockFile)) {
  issues.push({ kind: "io-error", message: `missing ${neverBlockFile}` });
}
const neverBlock = indexNeverBlock(readEntries(neverBlockFile).map((e) => e.domain));
const exclusions = readEntries(
  join(blocklistRoot, "policy", "import-exclusions.txt"),
).map((e) => e.domain);
let psl: ReturnType<typeof loadPublicSuffixList>;
try {
  psl = loadPublicSuffixList();
} catch (e) {
  fail([{ kind: "io-error", message: e instanceof Error ? e.message : String(e) }]);
}

for (const list of lists) {
  const entries = [...list.curated, ...list.imported];
  issues.push(...checkPublicSuffixes(entries, psl));
  issues.push(...checkIpAddresses(entries));
  issues.push(...checkNeverBlock(list.curated, neverBlock, list.neverBlockExempt));
  issues.push(...checkNeverBlock(list.imported, neverBlock, list.neverBlockExempt, true));
  issues.push(...checkExclusions(list.imported, exclusions));
}
// The per-site media lists deliberately name hosts of big platforms, so
// they get the narrow exemption (guards.ts neverBlockHit).
for (const [site, hosts] of Object.entries(SITE_MEDIA_HOSTS)) {
  const entries = hosts.map((domain) => ({
    domain,
    file: `tools/compiler/src/greylist.ts SITE_MEDIA_HOSTS.${site}`,
  }));
  issues.push(...checkPublicSuffixes(entries, psl));
  issues.push(...checkIpAddresses(entries));
  issues.push(...checkNeverBlock(entries, neverBlock, true));
}
issues.push(
  ...checkCrossListDuplicates(
    lists.map((l) => ({ id: l.id, entries: [...l.curated, ...l.imported] })),
  ),
);
if (issues.length > 0) fail(issues);

const merged = new Map<string, MergedList>(
  lists.map((l) => [l.id, mergeTiers(l)]),
);

// Worst case on Safari is everything enabled: every list that reaches the
// iOS content blocker or the macOS Safari extension (which converts DNR
// requestDomains one-for-one), plus every per-site media list.
const budgetLists = [
  ...lists
    .filter((l) => l.platforms.includes("safari") || l.platforms.includes("extension"))
    .map((l) => ({ id: l.id, rules: merged.get(l.id)!.domains.length })),
  ...Object.entries(SITE_MEDIA_HOSTS).map(([site, hosts]) => ({
    id: `${site}-media`,
    rules: hosts.length,
  })),
];
const budgetIssue = checkSafariBudget(budgetLists);
if (budgetIssue !== undefined) fail([budgetIssue]);

// Stage all outputs in memory first: all-or-nothing (CLAUDE.md §4, atomicity).
// One staged map per output directory; every map flushes or none does.
const outputs = new Map<string, string>();
const safariOutputs = new Map<string, string>();
const androidOutputs = new Map<string, string>();
const safariByCategory = new Map<string, SafariRule[]>();

function emitList(
  list: ListSource,
  domains: string[],
  defaultSafari: Map<string, SafariRule[]> | undefined,
): void {
  if (list.platforms.includes("extension")) {
    const compiled = compileBlockRuleset(list.id, domains);
    if (!compiled.ok) fail([compiled.error]);
    outputs.set(`${list.id}.json`, serializeRuleset(compiled.value));
  }
  if (safariOutDir !== undefined && list.platforms.includes("safari")) {
    const safari = compileSafariRuleset(list.id, domains);
    if (!safari.ok) fail([safari.error]);
    if (defaultSafari !== undefined) {
      // The bundled fallback carries the curated tier only (emitSafari.ts).
      const curated = compileSafariRuleset(
        list.id,
        mergeTiers({ curated: list.curated, imported: [] }).domains,
      );
      if (!curated.ok) fail([curated.error]);
      defaultSafari.set(list.id, curated.value);
    }
    safariOutputs.set(`${list.id}.safari.json`, serializeSafariRuleset(safari.value));
  }
  if (androidOutDir !== undefined && list.platforms.includes("android")) {
    androidOutputs.set(`${list.id}.domains`, serializeDomainList(domains));
  }
}

for (const list of lists) {
  if (!list.optional) emitList(list, merged.get(list.id)!.domains, safariByCategory);
}

outputs.set("safesearch.json", serializeRuleset(safesearchRules()));
outputs.set("media-all.json", serializeRuleset(mediaAllRules()));

if (greylistFile !== undefined) {
  let greylistContent: string;
  try {
    greylistContent = readFileSync(greylistFile, "utf8");
  } catch (e) {
    fail([
      {
        kind: "io-error",
        message: `cannot read ${greylistFile}: ${e instanceof Error ? e.message : String(e)}`,
      },
    ]);
  }
  const greylistParsed = parseDomainList(greylistContent, greylistFile);
  if (!greylistParsed.ok) fail(greylistParsed.error);
  const greylist = compileGreylistRuleset(greylistParsed.value);
  if (!greylist.ok) fail([greylist.error]);
  outputs.set("greylist.json", serializeRuleset(greylist.value));
}

const defaultBlockerList = buildDefaultBlockerList(safariByCategory);
if (safariOutDir !== undefined) {
  safariOutputs.set(
    "blockerList.default.json",
    serializeSafariRuleset(defaultBlockerList),
  );
  // Optional, off by default — added outside safariByCategory so it can
  // never land in the bundled default list.
  for (const [site, hosts] of Object.entries(SITE_MEDIA_HOSTS)) {
    const media = compileSafariRuleset(`${site}-media`, hosts);
    if (!media.ok) fail([media.error]);
    safariOutputs.set(`${site}-media.safari.json`, serializeSafariRuleset(media.value));
  }
}

if (androidOutDir !== undefined) {
  androidOutputs.set(
    "safesearch-hosts.json",
    serializeSafesearchHosts(safesearchHostsMap()),
  );
  // Optional Strict Search (off by default) — see emitAndroid.ts and
  // threat-model.md T11 for why these are separate from the blocklist.
  androidOutputs.set(
    "strict-search-hosts.json",
    serializeStrictSearchHosts(strictSearchHosts()),
  );
  for (const [site, hosts] of Object.entries(SITE_MEDIA_HOSTS)) {
    androidOutputs.set(`${site}-media.domains`, serializeDomainList(hosts));
  }
}

// Optional lists last, so existing artifacts and manifest keys keep their
// order. Their Safari fragments stay out of safariByCategory: off by
// default means never in blockerList.default.json.
for (const list of lists) {
  if (list.optional) emitList(list, merged.get(list.id)!.domains, undefined);
}

// Hash manifest: lets the extension/CI verify artifact integrity and lets
// anyone confirm the build is reproducible. One manifest per directory.
function addChecksums(staged: Map<string, string>): void {
  const hashes: Record<string, string> = {};
  for (const [name, body] of staged) {
    hashes[name] = createHash("sha256").update(body).digest("hex");
  }
  staged.set("checksums.json", JSON.stringify(hashes, null, 2) + "\n");
}

function flush(staged: Map<string, string>, dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of staged) {
    writeFileSync(join(dir, name), body, "utf8");
  }
}

let notice: string | undefined;
if (noticeOut !== undefined) {
  try {
    notice = readNotice(join(blocklistRoot, "imports", "ATTRIBUTION.md"));
  } catch (e) {
    fail([{ kind: "io-error", message: e instanceof Error ? e.message : String(e) }]);
  }
}

addChecksums(outputs);
if (safariOutDir !== undefined) addChecksums(safariOutputs);
if (androidOutDir !== undefined) addChecksums(androidOutputs);

flush(outputs, outDir);
if (safariOutDir !== undefined) flush(safariOutputs, safariOutDir);
if (androidOutDir !== undefined) flush(androidOutputs, androidOutDir);
if (noticeOut !== undefined) {
  mkdirSync(dirname(noticeOut), { recursive: true });
  writeFileSync(noticeOut, notice!, "utf8");
}

const extras = [
  ...(safariOutDir !== undefined ? [`safari -> ${safariOutDir}`] : []),
  ...(androidOutDir !== undefined ? [`android -> ${androidOutDir}`] : []),
  ...(noticeOut !== undefined ? [`notice -> ${noticeOut}`] : []),
];
console.log(
  `compiled ${categories.length} block ruleset(s) + safesearch -> ${outDir}` +
    (extras.length > 0 ? `; ${extras.join("; ")}` : ""),
);
for (const list of lists) {
  const m = merged.get(list.id)!;
  console.log(
    `  ${list.optional ? "optional" : "category"} ${list.id}: ${m.domains.length} ` +
      `(curated ${list.curated.length}, imported ${list.imported.length}, ` +
      `in both tiers ${m.inBothTiers}, redundant subdomains dropped ${m.redundant}) ` +
      `-> ${list.platforms.join(", ")}`,
  );
}
const budgetUsed = budgetLists.reduce((sum, l) => sum + l.rules, 0);
console.log(
  `  Safari worst case: ${budgetUsed} list rules + ${SAFARI_RULE_RESERVE} reserve = ` +
    `${budgetUsed + SAFARI_RULE_RESERVE} of ${SAFARI_RULE_BUDGET}`,
);
if (safariOutDir !== undefined) {
  console.log(
    `  Safari bundled fallback blockerList.default.json: ${defaultBlockerList.length} rules ` +
      `(curated tier of the default-on categories; the app builds the full list on first launch)`,
  );
}
