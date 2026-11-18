import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

import {
  matchesName,
  normalizeName,
  parseUpstream,
  renderAttribution,
  runImport,
  type Declaration,
} from "../../tools/import/dist/importer.js";
import { indexNeverBlock } from "../../tools/compiler/dist/guards.js";
import { loadPublicSuffixList } from "../../tools/compiler/dist/psl.js";

const ROOT = resolve(import.meta.dirname, "../..");
const enc = (s: string) => new TextEncoder().encode(s);

const DECL: Declaration = {
  priority: ["sources/adult", "sources/gambling"],
  sources: [
    { id: "a", target: "sources/adult", url: "https://example.test/a", format: "hosts", license: "MIT", attribution: "A list (MIT)" },
    { id: "g", target: "sources/gambling", url: "https://example.test/g", format: "domains", license: "CC-BY-4.0", attribution: "G list (CC BY 4.0)",
      upstreams: [{ name: "G upstream", url: "https://example.test/gu", license: "CC-BY-4.0" }] },
  ],
};

const ADULT_HOSTS = [
  "# header",
  "127.0.0.1 localhost",
  "::1 ip6-localhost ip6-loopback",
  "0.0.0.0 0.0.0.0",
  "0.0.0.0 Porn-One.example.",
  "0.0.0.0 www.porn-one.example   # dup after www strip",
  "0.0.0.0\tcdn.porn-two.example sub.cdn.porn-two.example",
  "0.0.0.0 co.uk",
  "0.0.0.0 www.safe.example",
  "0.0.0.0 boards.safe.example   # under a never-block name: imported tier may not",
  "0.0.0.0 bad_name.example",
  "0.0.0.0 appealed.example",
  "0.0.0.0 x.curated.example",
  "0.0.0.0 shared.example",
  "0.0.0.0 dating-site.example",
  "0.0.0.0 1.2.3.4",
  "",
].join("\r\n");

const GAMBLING_DOMAINS = "casino.example\nshared.example\nwww.casino.example\nbet.blogspot.com\n";

function ctx() {
  return {
    psl: loadPublicSuffixList(),
    neverBlock: indexNeverBlock(["safe.example"]),
    exclusions: ["appealed.example"],
    curated: new Map([
      ["sources/adult", new Set(["curated.example"])],
      ["sources/gambling", new Set<string>()],
      ["sources/dating", new Set(["dating-site.example"])],
    ]),
  };
}

function snapshots(date = "2026-11-18") {
  return new Map([
    ["a", { bytes: enc(ADULT_HOSTS), retrieved: date }],
    ["g", { bytes: enc(GAMBLING_DOMAINS), retrieved: date }],
  ]);
}

test("parseUpstream: hosts lines, several names per line, tabs, CRLF, comments", () => {
  const [names, lines] = parseUpstream("# c\r\n0.0.0.0 a.example b.example\r\n\r\n127.0.0.1\tc.example # x\r\n", "hosts");
  assert.deepEqual(names, ["a.example", "b.example", "c.example"]);
  assert.equal(lines, 4);
});

test("normalizeName strips one www. and a trailing dot, never more", () => {
  assert.equal(normalizeName("WWW.Example.COM."), "example.com");
  assert.equal(normalizeName("www.com"), "www.com");
  assert.equal(normalizeName("cdn.example.com"), "cdn.example.com");
  assert.equal(normalizeName("www.www.example.com"), "www.example.com");
});

test("runImport filters with a counted reason for each rejection", () => {
  const [adult, gambling] = runImport(DECL, snapshots(), ctx());
  assert.ok(adult && gambling);
  assert.deepEqual(adult.domains, ["cdn.porn-two.example", "porn-one.example", "shared.example"]);
  const r = adult.sources[0]!;
  assert.equal(r.kept, 3);
  assert.deepEqual(
    Object.fromEntries(Object.entries(r.rejected).filter(([, n]) => n > 0)),
    {
      localhost: 3,
      "ip-address": 2,
      invalid: 1,
      "public-suffix": 1,
      "never-block": 2,
      excluded: 1,
      "covered-by-curated": 1,
      "in-other-list": 1,
      duplicate: 1,
      redundant: 1,
    },
  );
  assert.deepEqual(r.examples["never-block"], ["safe.example", "boards.safe.example"]);

  // Priority: shared.example went to adult (earlier), so gambling drops it.
  assert.deepEqual(gambling.domains, ["bet.blogspot.com", "casino.example"]);
  assert.equal(gambling.sources[0]!.rejected["in-other-list"], 1);
  assert.equal(gambling.sources[0]!.rejected.duplicate, 1);
});

test("output header records provenance and counts; same bytes give same output", () => {
  const first = runImport(DECL, snapshots(), ctx());
  const second = runImport(DECL, snapshots(), ctx());
  assert.equal(first[0]!.body, second[0]!.body);
  const body = first[0]!.body;
  assert.match(body, /^# Sitr imported tier: sources\/adult\n/);
  assert.match(body, /# source: a\n#   url: https:\/\/example.test\/a\n#   licence: MIT\n#   retrieved: 2026-11-18\n#   sha256: [0-9a-f]{64}\n/);
  assert.match(body, /#   rejected: invalid 1, ip-address 2, localhost 3, public-suffix 1, never-block 2/);
  assert.ok(body.endsWith("\ncdn.porn-two.example\nporn-one.example\nshared.example\n"));
});

test("attribution lists every source and its upstreams", () => {
  const md = renderAttribution(DECL);
  assert.match(md, /## a\n\n- List: `sources\/adult`\n- Source: https:\/\/example.test\/a\n- Licence: MIT \(https:\/\/opensource.org\/license\/mit\)\n- Modified: yes/);
  assert.match(md, /A list \(MIT\)/);
  assert.match(md, /- G upstream — https:\/\/example.test\/gu \(CC-BY-4.0 \(https:\/\/creativecommons.org\/licenses\/by\/4.0\/\)\)/);
  // CC BY / BY-SA: say the material was changed, and carry the MIT notice.
  assert.match(md, /modified: filtered,\nmerged and de-duplicated/);
  assert.match(md, /## MIT licence terms[\s\S]*copies or substantial portions of the Software/);
});

test("only MIT, CC BY 4.0 and CC BY-SA 4.0 sources may be imported", () => {
  const gpl: Declaration = { ...DECL, sources: [{ ...DECL.sources[0]!, license: "GPL-3.0" }, DECL.sources[1]!] };
  assert.throws(() => runImport(gpl, snapshots(), ctx()), /licence "GPL-3.0" is not one of MIT, CC-BY-4.0, CC-BY-SA-4.0/);
});

test("requireNameMatch keeps only names with a term, after deleting ignored words", () => {
  const rule = { terms: ["bet", "casino"], ignore: ["alphabet", "better"] };
  assert.ok(matchesName("1xbet.com", rule));
  assert.ok(matchesName("alphabetcasino.com", rule));
  assert.ok(!matchesName("alphabet-film.nl", rule));
  assert.ok(!matchesName("a-better-self.net", rule));
  const decl: Declaration = { ...DECL, sources: [DECL.sources[0]!, { ...DECL.sources[1]!, requireNameMatch: { terms: ["casino"] } }] };
  const [, gambling] = runImport(decl, snapshots(), ctx());
  assert.deepEqual(gambling!.domains, ["casino.example"]);
  assert.equal(gambling!.sources[0]!.rejected["no-name-match"], 2); // bet.blogspot.com, shared.example
  assert.match(gambling!.body, /#   name rule: /);
});

test("claimFirst: a later list's source wins names over an earlier list", () => {
  // gambling's upstream lists shared.example; claiming it first moves it out of adult.
  const decl: Declaration = { ...DECL, claimFirst: ["g"] };
  const [adult, gambling] = runImport(decl, snapshots(), ctx());
  assert.ok(!adult!.domains.includes("shared.example"));
  assert.ok(gambling!.domains.includes("shared.example"));
  assert.equal(adult!.sources[0]!.rejected["in-other-list"], 2);
});

test("CLI: local inputs, writes imported.txt and ATTRIBUTION.md; output passes the compiler", () => {
  const root = mkdtempSync(join(tmpdir(), "sitr-import-"));
  try {
    const bl = join(root, "blocklist");
    const put = (p: string, body: string) => {
      mkdirSync(dirname(join(bl, p)), { recursive: true });
      writeFileSync(join(bl, p), body);
    };
    put("sources/adult/domains.txt", "curated.example\n");
    put("sources/gambling/domains.txt", "bet.example\n");
    put("sources/dating/domains.txt", "dating-site.example\n");
    put("policy/never-block.txt", "safe.example\n");
    put("policy/import-exclusions.txt", "# none\nappealed.example\n");
    put("imports/sources.json", JSON.stringify(DECL));
    put("../a.hosts", ADULT_HOSTS);
    put("../g.txt", GAMBLING_DOMAINS);

    const run = (extra: string[]) =>
      spawnSync("node", [join(ROOT, "tools/import/dist/cli.js"), "--blocklist", bl,
        "--input", `a=${join(root, "a.hosts")}`, "--input", `g=${join(root, "g.txt")}`, ...extra], { encoding: "utf8" });
    const r = run(["--date", "2026-01-02"]);
    assert.equal(r.status, 0, r.stderr);
    const imported = readFileSync(join(bl, "sources/adult/imported.txt"), "utf8");
    assert.match(imported, /retrieved: 2026-01-02/);
    assert.ok(existsSync(join(bl, "imports/ATTRIBUTION.md")));

    // Same upstream bytes on a later day: the recorded date is kept.
    assert.equal(run([]).status, 0);
    assert.equal(readFileSync(join(bl, "sources/adult/imported.txt"), "utf8"), imported);

    // Re-pinned URL, same bytes, dry run into a scratch --out: only the url
    // line changes; the date still comes from the blocklist's copy.
    put("imports/sources.json", JSON.stringify({
      ...DECL,
      sources: DECL.sources.map((s) => (s.id === "a" ? { ...s, url: "https://example.test/a@pinned" } : s)),
    }));
    assert.equal(run(["--out", join(root, "dry")]).status, 0);
    assert.equal(
      readFileSync(join(root, "dry/sources/adult/imported.txt"), "utf8"),
      imported.replace("https://example.test/a\n", "https://example.test/a@pinned\n"),
    );

    const c = spawnSync("node", [join(ROOT, "tools/compiler/dist/cli.js"), "--blocklist", join(bl, "sources"),
      "--out", join(root, "out")], { encoding: "utf8" });
    assert.equal(c.status, 0, c.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
