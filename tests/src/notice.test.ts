import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { readNotice } from "../../tools/compiler/dist/notice.js";

/**
 * CC BY / CC BY-SA attribution must travel with the distributed lists: the
 * packed Chrome zip and the staged Safari extension each carry NOTICE.txt,
 * generated from blocklist/imports/ATTRIBUTION.md at pack time.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const expected = readNotice(join(ROOT, "blocklist/imports/ATTRIBUTION.md"));

test("the notice carries both licences and the full attribution with the MIT text", () => {
  assert.match(expected, /Mozilla Public License 2\.0/);
  assert.match(expected, /CC BY-SA 4\.0/);
  assert.match(expected, /## stevenblack-gambling-only/);
  assert.match(expected, /Permission is hereby granted, free of charge/);
});

test("the Chrome Web Store zip contains NOTICE.txt", () => {
  const out = mkdtempSync(join(tmpdir(), "sitr-pack-"));
  try {
    execFileSync("node", [join(ROOT, "tools/pack/pack.mjs"), out], { cwd: ROOT });
    const [zipName] = readdirSync(out).filter((f) => f.endsWith(".zip"));
    const zip = readFileSync(join(out, zipName!));
    // Entries are STORED and NOTICE.txt is first: local header, name, bytes.
    const nameLength = zip.readUInt16LE(26);
    const size = zip.readUInt32LE(22);
    assert.equal(zip.subarray(30, 30 + nameLength).toString("utf8"), "NOTICE.txt");
    assert.equal(zip.subarray(30 + nameLength, 30 + nameLength + size).toString("utf8"), expected);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("the staged Safari extension contains NOTICE.txt, checksummed", () => {
  const out = mkdtempSync(join(tmpdir(), "sitr-stage-notice-"));
  try {
    execFileSync("node", [join(ROOT, "tools/pack/stage-safari.mjs"), out], { cwd: ROOT });
    assert.equal(readFileSync(join(out, "NOTICE.txt"), "utf8"), expected);
    const sums = JSON.parse(readFileSync(join(out, "checksums.json"), "utf8"));
    assert.ok(sums["NOTICE.txt"]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
