import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  ancestors,
  blocks,
  checkCrossListDuplicates,
  checkExclusions,
  checkIpAddresses,
  checkNeverBlock,
  checkPublicSuffixes,
  indexNeverBlock,
  mergeTiers,
  neverBlockHit,
  importedNeverBlockHit,
} from "../../tools/compiler/dist/guards.js";
import {
  loadPublicSuffixList,
  parsePublicSuffixList,
  PSL_PATH,
  PSL_SNAPSHOT,
} from "../../tools/compiler/dist/psl.js";
import { parseEntries } from "../../tools/compiler/dist/parse.js";
import { CATEGORY_ID_BASE, DOMAINS_PER_RULE } from "../../tools/compiler/dist/compile.js";

const at = (domain: string, line = 1, file = "t.txt") => ({ domain, file, line });

test("PSL snapshot matches its recorded hash", () => {
  const sha = createHash("sha256").update(readFileSync(PSL_PATH)).digest("hex");
  assert.equal(sha, PSL_SNAPSHOT.sha256);
  assert.match(PSL_SNAPSHOT.retrieved, /^\d{4}-\d{2}-\d{2}$/);
});

test("PSL: ICANN, PRIVATE, wildcard, exception and IDN rules", () => {
  const psl = loadPublicSuffixList();
  for (const s of ["com", "co.uk", "github.io", "blogspot.com", "anything.ck", "xn--55qx5d.cn"]) {
    assert.ok(psl.isPublicSuffix(s), s);
  }
  for (const s of ["www.ck", "example.co.uk", "user.github.io", "something.blogspot.com", "a.b.ck"]) {
    assert.ok(!psl.isPublicSuffix(s), s);
  }
});

test("PSL parser handles the rule forms on a tiny list", () => {
  const psl = parsePublicSuffixList("// c\n\nuk\nco.uk\n*.ck\n!www.ck\n公司.cn extra-ignored\n");
  assert.ok(psl.isPublicSuffix("co.uk"));
  assert.ok(psl.isPublicSuffix("foo.ck"));
  assert.ok(!psl.isPublicSuffix("www.ck"));
  assert.ok(!psl.isPublicSuffix("foo.co.uk"));
  assert.ok(psl.isPublicSuffix("xn--55qx5d.cn"));
});

test("public-suffix guard reports file and line", () => {
  const issues = checkPublicSuffixes(
    [at("ok.example", 1), at("co.uk", 2), at("x.blogspot.com", 3), at("github.io", 4)],
    loadPublicSuffixList(),
  );
  assert.deepEqual(issues.map((i) => [i.kind, i.line]), [["public-suffix", 2], ["public-suffix", 4]]);
});

test("public-suffix guard: wildcard parents and names above a deeper suffix fail, exceptions pass", () => {
  const tiny = parsePublicSuffixList("jp\n*.kawasaki.jp\n!city.kawasaki.jp\ncom\ns3.amazonaws.com\n");
  for (const s of ["kawasaki.jp", "foo.kawasaki.jp", "amazonaws.com", "s3.amazonaws.com", "jp"]) {
    assert.ok(tiny.blocksPublicSuffix(s), s);
  }
  for (const s of ["city.kawasaki.jp", "a.city.kawasaki.jp", "x.foo.kawasaki.jp", "example.com", "b.s3.amazonaws.com"]) {
    assert.ok(!tiny.blocksPublicSuffix(s), s);
  }
  const psl = loadPublicSuffixList();
  const issues = checkPublicSuffixes(
    [at("kawasaki.jp", 1), at("city.kawasaki.jp", 2), at("amazonaws.com", 3), at("example.jp", 4)],
    psl,
  );
  assert.deepEqual(issues.map((i) => i.line), [1, 3]);
  assert.match(issues[0]!.message, /public suffix beneath it/);
});

test("IP address guard: four numeric labels fail in any tier", () => {
  const issues = checkIpAddresses([at("1.2.3.4", 1), at("1.2.3.example", 2), at("10.0.0.1", 3), at("1.2.3", 4)]);
  assert.deepEqual(issues.map((i) => [i.kind, i.line]), [["invalid-domain", 1], ["invalid-domain", 3]]);
});

test("blocks and ancestors", () => {
  assert.ok(blocks("example.com", "example.com"));
  assert.ok(blocks("example.com", "a.example.com"));
  assert.ok(!blocks("example.com", "badexample.com"));
  assert.ok(!blocks("a.example.com", "example.com"));
  assert.deepEqual(ancestors("a.b.c"), ["b.c", "c"]);
});

test("never-block guard: equal name and ancestors fail, subdomains do not", () => {
  const index = indexNeverBlock(["google.com", "forcesafesearch.google.com"]);
  const issues = checkNeverBlock(
    [at("google.com", 1), at("com", 2), at("mail.google.com", 3), at("forcesafesearch.google.com", 4), at("notgoogle.com", 5)],
    index,
    false,
  );
  assert.deepEqual(issues.map((i) => i.line), [1, 2, 4]);
  assert.match(issues[0]!.message, /never-block name "forcesafesearch.google.com"|never-block name "google.com"/);
});

test("never-block exemption is narrow: only strict subdomains of a never-block name", () => {
  const index = indexNeverBlock(["platform.example", "cdn.media.platform.example"]);
  // A host under a never-block platform that would block a listed deeper host:
  assert.equal(neverBlockHit("media.platform.example", index, true), undefined); // exempt list passes
  assert.equal(neverBlockHit("media.platform.example", index, false), "cdn.media.platform.example"); // category fails
  // The apex and a never-block name itself still fail even when exempt:
  assert.equal(neverBlockHit("platform.example", index, true), "cdn.media.platform.example");
  assert.equal(neverBlockHit("cdn.media.platform.example", index, true), "cdn.media.platform.example");
});

test("imported tier: never-block names, their ancestors and their subdomains all hit", () => {
  const index = indexNeverBlock(["4chan.org", "cdn.media.platform.example"]);
  assert.equal(importedNeverBlockHit("4chan.org", index), "4chan.org");
  assert.equal(importedNeverBlockHit("boards.4chan.org", index), "4chan.org");
  assert.equal(importedNeverBlockHit("media.platform.example", index), "cdn.media.platform.example");
  assert.equal(importedNeverBlockHit("x.cdn.media.platform.example", index), "cdn.media.platform.example");
  assert.equal(importedNeverBlockHit("not4chan.org", index), undefined);
  const issues = checkNeverBlock([at("boards.4chan.org", 7)], index, true, true);
  assert.match(issues[0]!.message, /"boards\.4chan\.org" sits under never-block name "4chan\.org"/);
  // The curated rule is unchanged: a subdomain of a platform passes.
  assert.deepEqual(checkNeverBlock([at("boards.4chan.org", 7)], index, false), []);
});

test("seed never-block list parses and contains the SafeSearch targets", () => {
  const parsed = parseEntries(readFileSync(resolve(import.meta.dirname, "../../blocklist/policy/never-block.txt"), "utf8"), "never-block.txt");
  assert.ok(parsed.ok);
  const names = new Set(parsed.value.map((e) => e.domain));
  assert.ok(names.size >= 500 && names.size <= 1500, `size ${names.size}`);
  for (const n of ["forcesafesearch.google.com", "strict.bing.com", "safe.duckduckgo.com", "restrict.youtube.com", "sitrshield.com", "github.com", "booking.com", "msn.com", "lemonde.fr"]) {
    assert.ok(names.has(n), n);
  }
});

test("tiers: union, curated wins on overlap, redundant subdomains dropped", () => {
  const m = mergeTiers({
    curated: [at("a.example"), at("cdn.b.example")],
    imported: [at("a.example"), at("b.example"), at("x.a.example"), at("c.example")],
  });
  assert.deepEqual(m.domains, ["a.example", "b.example", "c.example"]);
  assert.equal(m.inBothTiers, 1);
  assert.equal(m.redundant, 2); // x.a.example, cdn.b.example
});

test("cross-list duplicates are errors naming both places", () => {
  const issues = checkCrossListDuplicates([
    { id: "adult", entries: [at("x.example", 3, "adult/domains.txt"), at("x.example", 9, "adult/imported.txt")] },
    { id: "dating", entries: [at("x.example", 7, "dating/domains.txt"), at("y.example", 8, "dating/domains.txt")] },
  ]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.kind, "duplicate-entry");
  assert.equal(issues[0]!.line, 7);
  assert.match(issues[0]!.message, /"adult" \(adult\/domains.txt:3\) and "dating"/);
});

test("import exclusions match same name, ancestor or subdomain", () => {
  const issues = checkExclusions(
    [at("site.example", 1), at("a.site.example", 2), at("example", 3), at("other.example", 4)],
    ["site.example"],
  );
  assert.deepEqual(issues.map((i) => i.line), [1, 2, 3]);
});

test("optional-list id bases leave room for 150,000 domains", () => {
  const bases = Object.values(CATEGORY_ID_BASE).sort((a, b) => a - b);
  const needed = Math.ceil(150_000 / DOMAINS_PER_RULE);
  for (let i = 1; i < bases.length; i++) assert.ok(bases[i]! - bases[i - 1]! > needed);
  for (const id of ["drugs", "violence", "doh"]) assert.ok(CATEGORY_ID_BASE[id]! >= 60_000, id);
  // Nothing lands on the greylist (40k) or media-all (50k) ranges.
  for (const b of bases) assert.ok(b !== 40_000 && b !== 50_000);
});
