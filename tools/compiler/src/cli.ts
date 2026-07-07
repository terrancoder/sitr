/**
 * Sitr ruleset compiler CLI.
 *
 * Usage: node cli.js --blocklist <blocklist/sources> --out <extension/rulesets>
 *
 * Reads every `<category>/domains.txt` under the blocklist sources directory,
 * compiles each to a DNR block ruleset, emits the SafeSearch ruleset, and
 * writes a manifest of SHA-256 hashes alongside the output for integrity
 * checks and reproducible-build verification.
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
import type { CompileIssue } from "./types.js";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined) {
    console.error(`missing required argument --${name}`);
    process.exit(2);
  }
  return v;
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
const outputs = new Map<string, string>();

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
}

outputs.set("safesearch.json", serializeRuleset(safesearchRules()));

// Hash manifest: lets the extension/CI verify artifact integrity and lets
// anyone confirm the build is reproducible.
const hashes: Record<string, string> = {};
for (const [name, body] of outputs) {
  hashes[name] = createHash("sha256").update(body).digest("hex");
}
outputs.set("checksums.json", JSON.stringify(hashes, null, 2) + "\n");

mkdirSync(outDir, { recursive: true });
for (const [name, body] of outputs) {
  writeFileSync(join(outDir, name), body, "utf8");
}
console.log(
  `compiled ${categories.length} block ruleset(s) + safesearch -> ${outDir}`,
);
