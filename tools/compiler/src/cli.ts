/**
 * Sitr ruleset compiler CLI.
 *
 * Usage: node cli.js --blocklist <blocklist/sources> --out <extension/rulesets>
 *                    [--safari-out <dir>] [--android-out <dir>]
 *
 * Reads every `<category>/domains.txt` under the blocklist sources directory,
 * compiles each to a DNR block ruleset, emits the SafeSearch ruleset, and
 * writes a manifest of SHA-256 hashes alongside the output for integrity
 * checks and reproducible-build verification.
 *
 * With `--safari-out`, also emits Safari content-blocker JSON per category
 * plus the blocker's bundled default list; with `--android-out`, plain
 * sorted domain lists plus the DNS SafeSearch host map. Each output
 * directory gets its own checksums.json. When the flags are absent the DNR
 * output is byte-identical to what this CLI has always produced.
 *
 * Exit code is non-zero on ANY issue; nothing is partially written on failure
 * (outputs are staged in memory and flushed only after all categories compile).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseDomainList } from "./parse.js";
import { compileBlockRuleset, serializeRuleset } from "./compile.js";
import { safesearchRules } from "./safesearch.js";
import {
  buildDefaultBlockerList,
  compileSafariRuleset,
  serializeSafariRuleset,
  type SafariRule,
} from "./emitSafari.js";
import {
  safesearchHostsMap,
  serializeDomainList,
  serializeSafesearchHosts,
} from "./emitAndroid.js";
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

// Sorted directory listing keeps category processing order deterministic.
const categories = readdirSync(sourcesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

if (categories.length === 0) {
  fail([
    {
      kind: "io-error",
      message: `no category directories found under ${sourcesDir}`,
    },
  ]);
}

// Stage all outputs in memory first: all-or-nothing (CLAUDE.md §4, atomicity).
// One staged map per output directory; every map flushes or none does.
const outputs = new Map<string, string>();
const safariOutputs = new Map<string, string>();
const androidOutputs = new Map<string, string>();
const safariByCategory = new Map<string, SafariRule[]>();

for (const category of categories) {
  const file = join(sourcesDir, category, "domains.txt");
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch (e) {
    fail([
      {
        kind: "io-error",
        message: `cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`,
      },
    ]);
  }

  const parsed = parseDomainList(content, file);
  if (!parsed.ok) fail(parsed.error);

  const compiled = compileBlockRuleset(category, parsed.value);
  if (!compiled.ok) fail([compiled.error]);

  outputs.set(`${category}.json`, serializeRuleset(compiled.value));

  if (safariOutDir !== undefined) {
    const safari = compileSafariRuleset(category, parsed.value);
    if (!safari.ok) fail([safari.error]);
    safariByCategory.set(category, safari.value);
    safariOutputs.set(
      `${category}.safari.json`,
      serializeSafariRuleset(safari.value),
    );
  }

  if (androidOutDir !== undefined) {
    androidOutputs.set(`${category}.domains`, serializeDomainList(parsed.value));
  }
}

outputs.set("safesearch.json", serializeRuleset(safesearchRules()));

if (safariOutDir !== undefined) {
  safariOutputs.set(
    "blockerList.default.json",
    serializeSafariRuleset(buildDefaultBlockerList(safariByCategory)),
  );
}

if (androidOutDir !== undefined) {
  androidOutputs.set(
    "safesearch-hosts.json",
    serializeSafesearchHosts(safesearchHostsMap()),
  );
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

addChecksums(outputs);
if (safariOutDir !== undefined) addChecksums(safariOutputs);
if (androidOutDir !== undefined) addChecksums(androidOutputs);

flush(outputs, outDir);
if (safariOutDir !== undefined) flush(safariOutputs, safariOutDir);
if (androidOutDir !== undefined) flush(androidOutputs, androidOutDir);

const extras = [
  ...(safariOutDir !== undefined ? [`safari -> ${safariOutDir}`] : []),
  ...(androidOutDir !== undefined ? [`android -> ${androidOutDir}`] : []),
];
console.log(
  `compiled ${categories.length} block ruleset(s) + safesearch -> ${outDir}` +
    (extras.length > 0 ? `; ${extras.join("; ")}` : ""),
);
