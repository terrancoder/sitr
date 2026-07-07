import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildUserRule,
  domainsOf,
  kindOf,
  MAX_USER_RULES_PER_KIND,
  nextRuleId,
  normalizeDomainInput,
  USER_RULE_ID_BASE,
  USER_RULE_PRIORITY,
} from "../../extension/dist/lib/userRules.js";

test("normalizes messy user input to a bare domain", () => {
  for (const input of [
    "Example.com",
    "https://example.com/some/path?q=1#frag",
    "  www.example.com:8443  ",
    "http://WWW.EXAMPLE.COM/",
  ]) {
    const r = normalizeDomainInput(input);
    assert.ok(r.ok, `should accept: ${input}`);
    assert.equal(r.value, "example.com");
  }
});

test("rejects input that is not a domain", () => {
  for (const input of ["", "not a domain", "example", "*.example.com"]) {
    assert.ok(!normalizeDomainInput(input).ok, `should reject: ${input}`);
  }
});

test("allow rules outrank block rules outrank static (priority 1)", () => {
  assert.ok(USER_RULE_PRIORITY.allow > USER_RULE_PRIORITY.block);
  assert.ok(USER_RULE_PRIORITY.block > 1);
});

test("built rules include main_frame so top-level navigation is covered", () => {
  const rule = buildUserRule("allow", "example.com", USER_RULE_ID_BASE.allow);
  assert.ok(rule.condition.resourceTypes.includes("main_frame"));
  assert.deepEqual(rule.condition.requestDomains, ["example.com"]);
});

test("kindOf classifies ids by reserved range", () => {
  assert.equal(kindOf({ id: USER_RULE_ID_BASE.allow }), "allow");
  assert.equal(kindOf({ id: USER_RULE_ID_BASE.block + 7 }), "block");
  assert.equal(kindOf({ id: 10_001 }), undefined); // static-ruleset range
});

test("nextRuleId fills gaps and errors at the limit", () => {
  const base = USER_RULE_ID_BASE.block;
  const r = nextRuleId([base, base + 1, base + 3], "block");
  assert.ok(r.ok);
  assert.equal(r.value, base + 2);

  const full = Array.from(
    { length: MAX_USER_RULES_PER_KIND },
    (_, i) => base + i,
  );
  const overflow = nextRuleId(full, "block");
  assert.ok(!overflow.ok);
  assert.match(overflow.error, /limit/);
});

test("domainsOf reads only its kind and sorts", () => {
  const rules = [
    {
      id: USER_RULE_ID_BASE.allow,
      condition: { requestDomains: ["z.example"] },
    },
    {
      id: USER_RULE_ID_BASE.allow + 1,
      condition: { requestDomains: ["a.example"] },
    },
    {
      id: USER_RULE_ID_BASE.block,
      condition: { requestDomains: ["blocked.example"] },
    },
  ];
  assert.deepEqual(
    domainsOf(rules, "allow").map((e) => e.domain),
    ["a.example", "z.example"],
  );
  assert.deepEqual(
    domainsOf(rules, "block").map((e) => e.domain),
    ["blocked.example"],
  );
});
