import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

/**
 * The Safari stager is store-compliance machinery: the mas channel must be
 * provably free of the purchase-steering surface (App Store 3.1.1; the
 * store risk register's owner check). These tests run the real script over
 * the real build output — npm test builds dist/ first, so the inputs are
 * always the current code.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "tools/pack/stage-safari.mjs");

function stage(channel: string): string {
  const out = mkdtempSync(join(tmpdir(), `sitr-stage-${channel}-`));
  execFileSync("node", [SCRIPT, out, "--channel", channel], { cwd: ROOT });
  return out;
}

function walkFiles(dir: string, base = ""): string[] {
  return readdirSync(join(dir, base), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walkFiles(dir, join(base, e.name))
      : [join(base, e.name)],
  );
}

// Keep in lockstep with FORBIDDEN in tools/pack/stage-safari.mjs (the test
// intentionally re-states it so a gate regression can't weaken both at once).
const FORBIDDEN = /subscri|checkout|sitrshield\.com\/family|purchase|\bbuy\b|polar|upgrade/i;

test("devid channel keeps the full-channel surface", () => {
  const out = stage("devid");
  try {
    assert.ok(existsSync(join(out, "dist/options/fullChannel.js")));
    const html = readFileSync(join(out, "src/options/options.html"), "utf8");
    assert.ok(html.includes('id="full-channel-only"'));
    const channel = JSON.parse(readFileSync(join(out, "channel.json"), "utf8"));
    assert.equal(channel.channel, "devid");
    // The steering strings live ONLY in the excluded module.
    const fullChannel = readFileSync(join(out, "dist/options/fullChannel.js"), "utf8");
    assert.match(fullChannel, /subscription token/);
    const optionsJs = readFileSync(join(out, "dist/options/options.js"), "utf8");
    assert.ok(!FORBIDDEN.test(optionsJs), "options.js must stay steering-free");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("mas channel is join-only and steering-free (the 3.1.1 gate)", () => {
  const out = stage("mas");
  try {
    assert.ok(!existsSync(join(out, "dist/options/fullChannel.js")));
    const html = readFileSync(join(out, "src/options/options.html"), "utf8");
    assert.ok(!/full[- ]channel|strip/i.test(html), "no residue announcing the strip");
    assert.ok(html.includes("household-join-form"), "joining stays available");
    const channel = JSON.parse(readFileSync(join(out, "channel.json"), "utf8"));
    assert.equal(channel.channel, "mas");
    for (const rel of walkFiles(out)) {
      if (!/^(manifest\.json|src\/.*\.html|dist\/.*\.js)$/.test(rel)) continue;
      const text = readFileSync(join(out, rel), "utf8");
      assert.ok(
        !FORBIDDEN.test(text),
        `${rel} contains a forbidden steering string: ${FORBIDDEN.exec(text)?.[0]}`,
      );
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("both channels share the Safari manifest shape and are deterministic", () => {
  const a = stage("mas");
  const b = stage("mas");
  try {
    for (const rel of walkFiles(a)) {
      assert.deepEqual(
        readFileSync(join(a, rel)),
        readFileSync(join(b, rel)),
        `${rel} must be byte-identical across stagings`,
      );
    }
    const manifest = JSON.parse(readFileSync(join(a, "manifest.json"), "utf8"));
    assert.equal(manifest.storage, undefined);
    assert.ok(manifest.permissions.includes("declarativeNetRequestWithHostAccess"));
    assert.ok(manifest.background.service_worker);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});
