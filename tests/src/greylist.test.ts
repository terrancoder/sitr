import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compileGreylistRuleset,
  GREYLIST_ID_BASE,
  MEDIA_FILTER_PRIORITY,
  mediaAllRules,
} from "../../tools/compiler/dist/greylist.js";
import {
  DOMAINS_PER_RULE,
  MAX_RULES_PER_RULESET,
  STATIC_CATEGORY_PRIORITY,
  serializeRuleset,
} from "../../tools/compiler/dist/compile.js";

test("golden: greylist compiles to initiator-scoped image+media blocks", () => {
  const r = compileGreylistRuleset(["reddit.com", "x.com"]);
  assert.ok(r.ok);
  const expected = `[
  {
    "id": 40001,
    "priority": 1,
    "action": {
      "type": "block"
    },
    "condition": {
      "initiatorDomains": [
        "reddit.com",
        "x.com"
      ],
      "resourceTypes": [
        "image",
        "media"
      ]
    }
  }
]
`;
  assert.equal(serializeRuleset(r.value), expected);
});

test("golden: media-all is a single blanket image+media block", () => {
  const expected = `[
  {
    "id": 50001,
    "priority": 1,
    "action": {
      "type": "block"
    },
    "condition": {
      "resourceTypes": [
        "image",
        "media"
      ]
    }
  }
]
`;
  assert.equal(serializeRuleset(mediaAllRules()), expected);
});

test("media-filter blocks sit BELOW static category blocks in priority", () => {
  // The image-allowlist band (priority 2) must beat these blocks but never
  // the category blocks — the ladder in architecture.md depends on it.
  assert.ok(MEDIA_FILTER_PRIORITY < STATIC_CATEGORY_PRIORITY);
  const r = compileGreylistRuleset(["a.example"]);
  assert.ok(r.ok);
  assert.equal(r.value[0]?.priority, MEDIA_FILTER_PRIORITY);
  assert.equal(mediaAllRules()[0]?.priority, MEDIA_FILTER_PRIORITY);
});

test("greylist never touches request domains, only initiators", () => {
  const r = compileGreylistRuleset(["a.example"]);
  assert.ok(r.ok);
  assert.equal(r.value[0]?.condition.requestDomains, undefined);
  assert.deepEqual(r.value[0]?.condition.initiatorDomains, ["a.example"]);
});

test("greylist batches with stable ids", () => {
  const hosts = Array.from(
    { length: DOMAINS_PER_RULE + 1 },
    (_, i) => `d${String(i).padStart(6, "0")}.example`,
  );
  const r = compileGreylistRuleset(hosts);
  assert.ok(r.ok);
  assert.equal(r.value.length, 2);
  assert.equal(r.value[0]?.id, GREYLIST_ID_BASE + 1);
  assert.equal(r.value[1]?.id, GREYLIST_ID_BASE + 2);
});

test("greylist overflow is a surfaced error, not a truncation", () => {
  const hosts: string[] = new Array(
    MAX_RULES_PER_RULESET * DOMAINS_PER_RULE + 1,
  ).fill("x.example");
  const r = compileGreylistRuleset(hosts);
  assert.ok(!r.ok);
  assert.equal(r.error.kind, "rule-limit-exceeded");
});

test("deterministic: same greylist twice gives identical output", () => {
  const hosts = ["z.example", "a.example"].sort();
  const r1 = compileGreylistRuleset(hosts);
  const r2 = compileGreylistRuleset(hosts);
  assert.ok(r1.ok && r2.ok);
  assert.equal(serializeRuleset(r1.value), serializeRuleset(r2.value));
});
