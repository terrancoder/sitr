import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compileBlockRuleset,
  DOMAINS_PER_RULE,
  MAX_RULES_PER_RULESET,
  serializeRuleset,
} from "../../tools/compiler/dist/compile.js";

test("golden: adult category with two domains compiles byte-identically", () => {
  const r = compileBlockRuleset("adult", ["a.example", "b.example"]);
  assert.ok(r.ok);
  const expected = `[
  {
    "id": 10001,
    "priority": 1,
    "action": {
      "type": "block"
    },
    "condition": {
      "requestDomains": [
        "a.example",
        "b.example"
      ],
      "resourceTypes": [
        "main_frame",
        "sub_frame",
        "stylesheet",
        "script",
        "image",
        "font",
        "object",
        "xmlhttprequest",
        "ping",
        "csp_report",
        "media",
        "websocket",
        "other"
      ]
    }
  }
]
`;
  assert.equal(serializeRuleset(r.value), expected);
});

test("block rules cover main_frame (DNR default excludes it)", () => {
  const r = compileBlockRuleset("adult", ["a.example"]);
  assert.ok(r.ok);
  assert.ok(r.value[0]?.condition.resourceTypes?.includes("main_frame"));
});

test("deterministic: same input twice gives identical output", () => {
  const domains = ["z.example", "a.example", "m.example"].sort();
  const r1 = compileBlockRuleset("gambling", domains);
  const r2 = compileBlockRuleset("gambling", domains);
  assert.ok(r1.ok && r2.ok);
  assert.equal(serializeRuleset(r1.value), serializeRuleset(r2.value));
});

test("batches domains into multiple rules with stable ids", () => {
  const domains = Array.from(
    { length: DOMAINS_PER_RULE + 1 },
    (_, i) => `d${String(i).padStart(6, "0")}.example`,
  );
  const r = compileBlockRuleset("dating", domains);
  assert.ok(r.ok);
  assert.equal(r.value.length, 2);
  assert.equal(r.value[0]?.id, 30001);
  assert.equal(r.value[1]?.id, 30002);
  assert.equal(r.value[1]?.condition.requestDomains?.length, 1);
});

test("unknown category is a surfaced error", () => {
  const r = compileBlockRuleset("mystery", ["a.example"]);
  assert.ok(!r.ok);
});

test("rule-limit overflow is a surfaced error, not a truncation", () => {
  // One domain past the batch boundary of the last allowed rule. The compiler
  // doesn't dedupe (parse does), so a filled array keeps the test cheap.
  const domains: string[] = new Array(
    MAX_RULES_PER_RULESET * DOMAINS_PER_RULE + 1,
  ).fill("x.example");
  const r = compileBlockRuleset("adult", domains);
  assert.ok(!r.ok);
  assert.equal(r.error.kind, "rule-limit-exceeded");
});
