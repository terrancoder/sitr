import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

/**
 * The extension manifest's DNR ruleset list must match what the compiler
 * emits into extension/rulesets: a ruleset file with no manifest entry
 * never loads, an entry with no file breaks the extension load, and an
 * opt-in list declared `enabled: true` would block for every user.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const RULESETS = join(ROOT, "extension/rulesets");

interface RuleResource { id: string; enabled: boolean; path: string }

const resources = (
  JSON.parse(readFileSync(join(ROOT, "extension/manifest.json"), "utf8")) as {
    declarative_net_request: { rule_resources: RuleResource[] };
  }
).declarative_net_request.rule_resources;

test("manifest rulesets and emitted extension rulesets agree", () => {
  const emitted = readdirSync(RULESETS).filter((f) => f.endsWith(".json") && f !== "checksums.json").sort();
  const declared = resources.map((r) => r.path.replace(/^rulesets\//, "")).sort();
  assert.deepEqual(declared, emitted, "every emitted ruleset needs exactly one manifest entry, and every entry a file");
  for (const r of resources) {
    assert.ok(existsSync(join(ROOT, "extension", r.path)), `${r.id}: ${r.path} missing`);
  }
  assert.equal(new Set(resources.map((r) => r.id)).size, resources.length, "duplicate ruleset id");
});

test("opt-in lists and media rulesets ship disabled; categories ship enabled", () => {
  const lists = JSON.parse(readFileSync(join(ROOT, "blocklist/optional/lists.json"), "utf8")) as Record<
    string,
    { platforms: string[] }
  >;
  const optional = new Set([
    ...Object.entries(lists).filter(([, d]) => d.platforms.includes("extension")).map(([id]) => `rulesets/${id}.json`),
    "rulesets/greylist.json",
    "rulesets/media-all.json",
  ]);
  for (const r of resources) {
    assert.equal(r.enabled, !optional.has(r.path), `${r.id}: enabled must be ${!optional.has(r.path)}`);
  }
});

test("the claim host is an optional host permission only, and absent from the Mac App Store manifest", async () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "extension/manifest.json"), "utf8")) as {
    host_permissions: string[];
    optional_host_permissions?: string[];
    permissions: string[];
  };
  const claimHost = "https://claim.sitrshield.com/*";
  assert.deepEqual(manifest.optional_host_permissions, [claimHost]);
  assert.ok(!manifest.host_permissions.some((h) => h.includes("claim.")), "never a required host");
  assert.ok(!manifest.permissions.some((p) => p.includes("claim.")));
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  for (const channel of ["mas", "devid"]) {
    const out = mkdtempSync(join(tmpdir(), `sitr-manifest-${channel}-`));
    try {
      execFileSync("node", [join(ROOT, "tools/pack/stage-safari.mjs"), out, "--channel", channel], { stdio: "pipe" });
      const staged = readFileSync(join(out, "manifest.json"), "utf8");
      assert.equal(staged.includes("claim.sitrshield.com"), channel === "devid", channel);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }
});
