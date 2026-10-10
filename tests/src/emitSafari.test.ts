import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildDefaultBlockerList,
  compileSafariRuleset,
  safariUrlFilter,
  serializeSafariRuleset,
  MAX_SAFARI_RULES,
} from "../../tools/compiler/dist/emitSafari.js";

test("golden: one host-anchored block rule per domain, byte-identically", () => {
  const r = compileSafariRuleset("adult", ["a.example", "b-c.example"]);
  assert.ok(r.ok);
  const expected = String.raw`[
  {
    "trigger": {
      "url-filter": "^[^:]+://+([^/]*@)?([^:/]+\\.)?a\\.example\\.?[:/]"
    },
    "action": {
      "type": "block"
    }
  },
  {
    "trigger": {
      "url-filter": "^[^:]+://+([^/]*@)?([^:/]+\\.)?b-c\\.example\\.?[:/]"
    },
    "action": {
      "type": "block"
    }
  }
]
`;
  assert.equal(serializeSafariRuleset(r.value), expected);
});

test("the url-filter matches requests to the domain and its subdomains only", () => {
  // WebKit's regex subset is a subset of JavaScript's, so the same pattern
  // can be exercised here (case-insensitively, as WebKit matches).
  const filter = new RegExp(safariUrlFilter("site.example"), "i");
  for (const url of [
    "https://site.example/",
    "http://site.example/path?q=1",
    "https://www.site.example/",
    "https://a.b.site.example:8443/x",
    "wss://site.example/socket",
    "https://SITE.example/",
    "https://user@site.example/", // userinfo is not part of the host
    "https://user:pw@www.site.example/",
    "https://site.example./", // root dot is the same host
  ]) {
    assert.ok(filter.test(url), `should match ${url}`);
  }
  for (const url of [
    "https://notsite.example/",
    "https://site.example.evil.test/",
    "https://evil.test/site.example/",
    "https://evil.test/?u=https://site.example/",
    "https://evil.test/@site.example/",
    "https://siteXexample/",
  ]) {
    assert.ok(!filter.test(url), `should not match ${url}`);
  }
});

test("rules carry no if-domain: that would scope them to the top-level page", () => {
  const r = compileSafariRuleset("dating", ["site.example"]);
  assert.ok(r.ok);
  assert.deepEqual(Object.keys(r.value[0]!.trigger), ["url-filter"]);
});

test("deterministic: same input twice gives identical output", () => {
  const domains = ["z.example", "a.example", "m.example"].sort();
  const r1 = compileSafariRuleset("gambling", domains);
  const r2 = compileSafariRuleset("gambling", domains);
  assert.ok(r1.ok && r2.ok);
  assert.equal(
    serializeSafariRuleset(r1.value),
    serializeSafariRuleset(r2.value),
  );
});

test("rule-limit overflow is a surfaced error, not a truncation", () => {
  const domains: string[] = new Array(MAX_SAFARI_RULES + 1).fill("x.example");
  const r = compileSafariRuleset("adult", domains);
  assert.ok(!r.ok);
  assert.equal(r.error.kind, "rule-limit-exceeded");
});

test("default blocker list concatenates categories in sorted order", () => {
  const adult = compileSafariRuleset("adult", ["a.example"]);
  const gambling = compileSafariRuleset("gambling", ["g.example"]);
  const dating = compileSafariRuleset("dating", ["d.example"]);
  assert.ok(adult.ok && gambling.ok && dating.ok);
  // Insertion order deliberately differs from sorted order.
  const byCategory = new Map([
    ["gambling", gambling.value],
    ["adult", adult.value],
    ["dating", dating.value],
  ]);
  const all = buildDefaultBlockerList(byCategory);
  assert.deepEqual(
    all.map((rule) => rule.trigger["url-filter"]),
    ["a.example", "d.example", "g.example"].map(safariUrlFilter),
  );
});
