import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

import { SITE_MEDIA_HOSTS } from "../../tools/compiler/dist/greylist.js";
import { SAFARI_RULE_BUDGET, SAFARI_RULE_RESERVE, safariUrlFilter } from "../../tools/compiler/dist/emitSafari.js";
import { renderNotice } from "../../tools/compiler/dist/notice.js";

/**
 * End-to-end runs of the real compiler CLI over a throwaway blocklist:
 * tiers, optional lists and platform targeting, the guards' file:line
 * errors, checksums, the combined Safari budget and determinism.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const CLI = join(ROOT, "tools/compiler/dist/cli.js");

type Tree = Record<string, string>;

const BASE: Tree = {
  "sources/adult/domains.txt": "# curated\nadult-one.example\nshared.example\n",
  "sources/adult/imported.txt": "# machine\nshared.example\nadult-two.example\ncdn.adult-one.example\n",
  "sources/gambling/domains.txt": "bet.example\n",
  "policy/never-block.txt": "safe.example\nplatform.example\ncdn.media.platform.example\n",
  "optional/lists.json": JSON.stringify({
    doh: { platforms: ["android"], neverBlockExempt: true },
    drugs: { platforms: ["extension", "safari", "android"] },
  }),
  "optional/doh/domains.txt": "dns.resolver.example\nmedia.platform.example\n",
  "optional/drugs/domains.txt": "drug-shop.example\n",
};

function writeTree(tree: Tree): string {
  const root = mkdtempSync(join(tmpdir(), "sitr-cli-"));
  for (const [path, body] of Object.entries(tree)) {
    if (body === undefined) continue;
    mkdirSync(dirname(join(root, "blocklist", path)), { recursive: true });
    writeFileSync(join(root, "blocklist", path), body);
  }
  return root;
}

function compile(root: string, out = "out", withSafari = true, extra: string[] = []) {
  const r = spawnSync(
    "node",
    [
      CLI,
      "--blocklist", join(root, "blocklist/sources"),
      "--out", join(root, out, "rulesets"),
      ...(withSafari ? ["--safari-out", join(root, out, "safari")] : []),
      "--android-out", join(root, out, "android"),
      ...extra,
    ],
    { encoding: "utf8" },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function withTree(changes: Tree, fn: (root: string) => void): void {
  const tree: Tree = { ...BASE };
  for (const [k, v] of Object.entries(changes)) {
    if (v === "") delete tree[k];
    else tree[k] = v;
  }
  const root = writeTree(tree);
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const read = (root: string, p: string) => readFileSync(join(root, p), "utf8");
const files = (root: string, p: string) => readdirSync(join(root, p)).sort();

test("tiers merge, optional lists emit only for their platforms", () => {
  withTree({}, (root) => {
    const r = compile(root);
    assert.equal(r.status, 0, r.stderr);
    // Curated wins on overlap; cdn.adult-one.example is redundant.
    assert.equal(read(root, "out/android/adult.domains"), "adult-one.example\nadult-two.example\nshared.example\n");
    assert.match(r.stdout, /category adult: 3 \(curated 2, imported 3, in both tiers 1, redundant subdomains dropped 1\)/);

    assert.deepEqual(files(root, "out/rulesets").filter((f) => /^(doh|drugs)/.test(f)), ["drugs.json"]);
    assert.deepEqual(files(root, "out/safari").filter((f) => /^(doh|drugs)/.test(f)), ["drugs.safari.json"]);
    assert.deepEqual(files(root, "out/android").filter((f) => /^(doh|drugs)/.test(f)), ["doh.domains", "drugs.domains"]);
    assert.equal(read(root, "out/android/doh.domains"), "dns.resolver.example\nmedia.platform.example\n");

    // Own id range for the optional ruleset.
    const drugs = JSON.parse(read(root, "out/rulesets/drugs.json"));
    assert.equal(drugs[0].id, 60_001);
    // The bundled fallback is the curated tier of the default-on categories
    // only; the fragments keep both tiers. Optional lists are never in it.
    const fallback = JSON.parse(read(root, "out/safari/blockerList.default.json"));
    assert.deepEqual(
      fallback.map((rule: { trigger: Record<string, string> }) => rule.trigger["url-filter"]),
      ["adult-one.example", "shared.example", "bet.example"].map(safariUrlFilter),
    );
    assert.match(read(root, "out/safari/adult.safari.json"), /adult-two/);
    assert.match(r.stdout, /Safari bundled fallback blockerList\.default\.json: 3 rules/);
    // The budget still counts the full lists (adult 3 + gambling 1 + drugs 1 + media).
    const media = Object.values(SITE_MEDIA_HOSTS).reduce((n, h) => n + h.length, 0);
    assert.match(r.stdout, new RegExp(`Safari worst case: ${5 + media} list rules`));

    // Checksums cover every artifact, new ones included.
    for (const dir of ["rulesets", "safari", "android"]) {
      const sums = JSON.parse(read(root, `out/${dir}/checksums.json`));
      const names = files(root, `out/${dir}`).filter((f) => f !== "checksums.json");
      assert.deepEqual(Object.keys(sums).sort(), names);
      for (const n of names) {
        assert.equal(sums[n], createHash("sha256").update(read(root, `out/${dir}/${n}`)).digest("hex"), n);
      }
    }
  });
});

function assertDomainsArtifact(name: string, body: string): void {
  assert.ok(body.endsWith("\n") && !body.endsWith("\n\n"), `${name}: exactly one trailing LF`);
  const lines = body.slice(0, -1).split("\n");
  for (let i = 0; i < lines.length; i++) {
    assert.notEqual(lines[i], "", `${name}: blank line ${i + 1}`);
    // Strictly increasing in code-point order = sorted and duplicate-free.
    if (i > 0) assert.ok(lines[i - 1]! < lines[i]!, `${name}: line ${i + 1} out of order or duplicate`);
  }
}

test("every .domains artifact is strictly sorted, no blanks, one trailing LF", () => {
  withTree({ "optional/doh/domains.txt": "z.resolver.example\ndns.resolver.example\nz.resolver.example\n" }, (root) => {
    assert.equal(compile(root).status, 0);
    const names = files(root, "out/android").filter((f) => f.endsWith(".domains"));
    assert.ok(names.includes("x-media.domains") && names.includes("doh.domains"));
    for (const n of names) assertDomainsArtifact(n, read(root, `out/android/${n}`));
  });
  // The committed artifacts too.
  const dir = join(ROOT, "apps/shared/blocklists/android");
  for (const n of readdirSync(dir).filter((f) => f.endsWith(".domains"))) {
    assertDomainsArtifact(n, readFileSync(join(dir, n), "utf8"));
  }
});

test("deterministic: two compiles give identical bytes", () => {
  withTree({}, (root) => {
    assert.equal(compile(root, "a").status, 0);
    assert.equal(compile(root, "b").status, 0);
    for (const dir of ["rulesets", "safari", "android"]) {
      assert.deepEqual(files(root, `a/${dir}`), files(root, `b/${dir}`));
      for (const f of files(root, `a/${dir}`)) {
        assert.equal(read(root, `a/${dir}/${f}`), read(root, `b/${dir}/${f}`), `${dir}/${f}`);
      }
    }
  });
});

test("--notice-out writes the notice from imports/ATTRIBUTION.md, outside every checksummed dir", () => {
  const attribution = "# Attribution\r\n\nSome list, MIT.\n";
  withTree({ "imports/ATTRIBUTION.md": attribution }, (root) => {
    const r = compile(root, "out", true, ["--notice-out", join(root, "out/NOTICE.txt")]);
    assert.equal(r.status, 0, r.stderr);
    const notice = read(root, "out/NOTICE.txt");
    assert.equal(notice, renderNotice(attribution));
    assert.ok(notice.includes("# Attribution\n\nSome list, MIT.\n") && !notice.includes("\r"));
    assert.match(notice, /MPL-2\.0/);
    assert.match(notice, /CC BY-SA 4\.0/);
  });
  withTree({}, (root) => {
    const r = compile(root, "out", true, ["--notice-out", join(root, "out/NOTICE.txt")]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /error\(io-error\).*ATTRIBUTION\.md/);
  });
});

function expectFailure(changes: Tree, pattern: RegExp): void {
  withTree(changes, (root) => {
    const r = compile(root);
    assert.equal(r.status, 1, `expected failure, got: ${r.stdout}`);
    assert.match(r.stderr, pattern);
  });
}

test("guard: a public suffix in the imported tier fails with file and line", () => {
  expectFailure(
    { "sources/adult/imported.txt": "# h\nok.example\nblogspot.com\n" },
    /error\(public-suffix\): .*sources\/adult\/imported\.txt:3: "blogspot\.com"/,
  );
});

test("guard: a curated entry above a wildcard public suffix, or an IP address, fails", () => {
  expectFailure(
    { "sources/gambling/domains.txt": "bet.example\nkawasaki.jp\n" },
    /error\(public-suffix\): .*gambling\/domains\.txt:2: "kawasaki\.jp" has a public suffix beneath it/,
  );
  expectFailure(
    { "sources/gambling/domains.txt": "bet.example\n1.2.3.4\n" },
    /error\(invalid-domain\): .*gambling\/domains\.txt:2: "1\.2\.3\.4" is an IP address/,
  );
});

test("guard: a category entry that would block a never-block name fails", () => {
  expectFailure(
    { "sources/gambling/domains.txt": "bet.example\nmedia.platform.example\n" },
    /error\(never-block\): .*gambling\/domains\.txt:2: "media\.platform\.example" would block never-block name "cdn\.media\.platform\.example"/,
  );
});

test("guard: a stale imported entry under a never-block name fails; curated may name one", () => {
  expectFailure(
    { "sources/adult/imported.txt": "# h\nok.example\nboards.safe.example\n" },
    /error\(never-block\): .*adult\/imported\.txt:3: "boards\.safe\.example" sits under never-block name "safe\.example"/,
  );
  withTree({ "sources/adult/domains.txt": "adult-one.example\nboards.safe.example\n" }, (root) => {
    const r = compile(root);
    assert.equal(r.status, 0, r.stderr);
  });
});

test("guard: the exempt doh list still may not list a platform apex", () => {
  expectFailure(
    { "optional/doh/domains.txt": "dns.resolver.example\nplatform.example\n" },
    /error\(never-block\): .*optional\/doh\/domains\.txt:2:/,
  );
});

test("guard: an exact duplicate across categories fails", () => {
  expectFailure(
    { "sources/gambling/domains.txt": "bet.example\nadult-two.example\n" },
    /error\(duplicate-entry\): .*gambling\/domains\.txt:2: "adult-two\.example" is in both "adult"/,
  );
});

test("guard: a stale imported entry matching an exclusion fails", () => {
  expectFailure(
    { "policy/import-exclusions.txt": "# appeals\nadult-two.example\n" },
    /error\(excluded-entry\): .*adult\/imported\.txt:3:/,
  );
});

test("declaration: an undeclared optional directory fails", () => {
  expectFailure(
    { "optional/violence/domains.txt": "gore.example\n" },
    /error\(invalid-declaration\): .*lists\.json: "violence": directory optional\/violence is not declared/,
  );
});

test("never-block list is required", () => {
  expectFailure({ "policy/never-block.txt": "" }, /missing .*never-block\.txt/);
});

test("budget: one rule over the combined Safari budget fails the compile", () => {
  const media = Object.values(SITE_MEDIA_HOSTS).reduce((n, h) => n + h.length, 0);
  // gambling 1 + drugs 1 + media; adult fills the rest, plus one.
  const adultCount = SAFARI_RULE_BUDGET - SAFARI_RULE_RESERVE - media - 2 + 1;
  const adult = Array.from({ length: adultCount }, (_, i) => `d${i}.example`).join("\n") + "\n";
  expectFailure(
    { "sources/adult/domains.txt": adult, "sources/adult/imported.txt": "" },
    /error\(rule-limit-exceeded\): Safari rule budget exceeded: lists 140001 \+ reserve 5000 = 145001 > 145000/,
  );
});
