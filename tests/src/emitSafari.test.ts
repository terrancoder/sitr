import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildDefaultBlockerList,
  compileSafariRuleset,
  serializeSafariRuleset,
  MAX_SAFARI_RULES,
} from "../../tools/compiler/dist/emitSafari.js";
import { DOMAINS_PER_RULE } from "../../tools/compiler/dist/compile.js";

test("golden: two domains compile to one block rule, byte-identically", () => {
  const r = compileSafariRuleset("adult", ["a.example", "b.example"]);
  assert.ok(r.ok);
  const expected = `[
  {
    "trigger": {
      "url-filter": ".*",
      "if-domain": [
        "*a.example",
        "*b.example"
      ]
    },
    "action": {
      "type": "block"
    }
  }
]
`;
  assert.equal(serializeSafariRuleset(r.value), expected);
});

test("if-domain entries carry the subdomain-matching * prefix", () => {
  const r = compileSafariRuleset("dating", ["site.example"]);
  assert.ok(r.ok);
  assert.deepEqual(r.value[0]?.trigger["if-domain"], ["*site.example"]);
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

test("batches domains at the shared batch size", () => {
  const domains = Array.from(
    { length: DOMAINS_PER_RULE + 1 },
    (_, i) => `d${String(i).padStart(6, "0")}.example`,
  );
  const r = compileSafariRuleset("adult", domains);
  assert.ok(r.ok);
  assert.equal(r.value.length, 2);
  assert.equal(r.value[0]?.trigger["if-domain"]?.length, DOMAINS_PER_RULE);
  assert.equal(r.value[1]?.trigger["if-domain"]?.length, 1);
});

test("rule-limit overflow is a surfaced error, not a truncation", () => {
  const domains: string[] = new Array(
    MAX_SAFARI_RULES * DOMAINS_PER_RULE + 1,
  ).fill("x.example");
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
    all.map((rule) => rule.trigger["if-domain"]?.[0]),
    ["*a.example", "*d.example", "*g.example"],
  );
});
