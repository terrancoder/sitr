// data-flow.md promises one `fetch(` call site in the extension
// (extension/src/lib/sync/client.ts). This is that grep, as a test.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(process.cwd(), "extension", "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|js|html)$/.test(name) ? [path] : [];
  });
}

test("the extension has one fetch( call site: lib/sync/client.ts", () => {
  const withCall = sources(root)
    .filter((path) => /fetch\(/.test(readFileSync(path, "utf8")))
    .map((path) => relative(root, path));
  assert.deepEqual(withCall, ["lib/sync/client.ts"]);
});
