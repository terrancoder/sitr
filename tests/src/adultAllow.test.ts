/**
 * No allow entry opens an adult-listed name or switches SafeSearch off
 * (R1, R2); other categories and the layer order stay as they were (R3);
 * the add screens refuse an adult allow and say why (R4). The shared
 * decision fixture (apps/shared/fixtures/decision.json) is replayed here
 * against the SHIPPED ruleset priorities, under DNR precedence.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { readFileSync } from "node:fs";

import {
  IMAGE_ALLOW_PRIORITY,
  LAYER_PRIORITIES,
  buildLayerRule,
  type RuleLayer,
} from "../../extension/dist/lib/ruleLayers.js";
import {
  ADULT_LISTED_ERROR,
  listedUnder,
  rulesetDomains,
} from "../../extension/dist/lib/userRules.js";
import { EMPTY_MANAGED_POLICY } from "../../extension/dist/lib/managed.js";
import { HOUSEHOLD_STATE_KEY, emptyHouseholdState } from "../../extension/dist/lib/household.js";
import {
  addHouseholdDomain,
  refusedAsAdult,
  type HouseholdContext,
} from "../../extension/dist/options/household.js";
import { STATIC_CATEGORY_PRIORITY, UNALLOWABLE_PRIORITY } from "../../tools/compiler/dist/compile.js";
import { winningRule, type MatchableRule } from "../../tools/compiler/dist/dnrMatch.js";

const ruleset = (file: string): MatchableRule[] =>
  JSON.parse(readFileSync(new URL(`../../extension/rulesets/${file}`, import.meta.url), "utf8"));

/* ------------------------------ priorities ------------------------------- */

test("shipped rulesets: adult and SafeSearch outrank every allow layer; the other lists stay below them", () => {
  const allows = Object.values(LAYER_PRIORITIES).map((p) => p.allow);
  for (const file of ["adult.json", "safesearch.json"]) {
    const rules = ruleset(file);
    assert.ok(rules.length > 0);
    for (const r of rules) {
      assert.equal(r.priority, UNALLOWABLE_PRIORITY, `${file} ${r.id}`);
      assert.ok(allows.every((a) => r.priority! > a), `${file} ${r.id}`);
    }
  }
  for (const file of ["gambling.json", "dating.json", "violence.json"]) {
    for (const r of ruleset(file)) {
      assert.equal(r.priority, STATIC_CATEGORY_PRIORITY, `${file} ${r.id}`);
      assert.ok(r.priority! < LAYER_PRIORITIES.user.allow, `${file} ${r.id}`);
    }
  }
  assert.ok(IMAGE_ALLOW_PRIORITY < STATIC_CATEGORY_PRIORITY);
});

/* --------------------------- the shared fixture -------------------------- */

interface DecisionCase {
  name: string;
  rule: string;
  host: string;
  expected: string;
  managed?: { allow?: string[]; block?: string[] };
  household?: { allow?: string[]; block?: string[] };
  user?: { allow?: string[]; block?: string[] };
}
const decision = JSON.parse(
  readFileSync(new URL("../../apps/shared/fixtures/decision.json", import.meta.url), "utf8"),
) as { lists: Record<string, string[]>; cases: DecisionCase[] };

/** The fixture's lists as the shipped rulesets would carry them (same priority, action, types). */
function staticRules(): MatchableRule[] {
  const rules: MatchableRule[] = ruleset("safesearch.json");
  for (const [category, domains] of Object.entries(decision.lists)) {
    const shipped = ruleset(`${category}.json`)[0]!;
    rules.push({ ...shipped, condition: { ...shipped.condition, requestDomains: domains } });
  }
  return rules;
}

test("decision fixture: the extension's rules give every expected outcome", () => {
  const base = staticRules();
  const rules = new Set(decision.cases.map((c) => c.rule));
  assert.deepEqual([...rules].sort(), ["R1", "R2", "R3"]);
  for (const c of decision.cases) {
    const all = [...base];
    let id = 1;
    for (const layer of ["managed", "household", "user"] as RuleLayer[]) {
      for (const kind of ["allow", "block"] as const) {
        for (const d of c[layer]?.[kind] ?? []) all.push(buildLayerRule(layer, kind, d, id++));
      }
    }
    const won = winningRule(all, `https://${c.host}/search?q=x`);
    const outcome =
      won === undefined || won.action.type === "allow"
        ? "forward"
        : won.action.type === "redirect"
          ? "safesearch"
          : "block";
    assert.equal(outcome, c.expected, `${c.rule} ${c.name}`);
  }
});

/* ------------------------------ the lookup ------------------------------- */

test("listedUnder: the name or a listed parent; never a parent of a listed name", () => {
  const listed = rulesetDomains([
    { condition: { requestDomains: ["adult.example", "deep.host.example"] } },
    { condition: {} },
    "junk",
  ]);
  assert.deepEqual([...listed].sort(), ["adult.example", "deep.host.example"]);
  assert.ok(listedUnder("adult.example", listed));
  assert.ok(listedUnder("www.adult.example", listed));
  assert.ok(listedUnder("a.b.deep.host.example", listed));
  assert.ok(!listedUnder("host.example", listed));
  assert.ok(!listedUnder("other.host.example", listed));
  assert.ok(!listedUnder("notadult.example", listed));
  assert.ok(!listedUnder("example", listed));
});

/* ---------------------------- the add screens ---------------------------- */

// Real adult names, read from the shipped ruleset (none written here).
const adult = rulesetDomains(ruleset("adult.json"));
const adultName = [...adult][0]!;
/** An adult entry whose parent is not itself listed: the parent can be allowed. */
const nested = [...adult].find((d) => {
  const parent = d.slice(d.indexOf(".") + 1);
  return parent.split(".").length >= 2 && !listedUnder(parent, adult);
})!;
const gamblingName = ruleset("gambling.json")[0]!.condition.requestDomains![0]!;

let store: Record<string, unknown>;
let errors: string[];
(globalThis as Record<string, unknown>)["chrome"] = {
  storage: {
    local: {
      get: async (keys: string | string[]) =>
        Object.fromEntries(
          (Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]]),
        ),
      set: async (items: Record<string, unknown>) => void Object.assign(store, items),
      remove: async () => {},
    },
  },
  declarativeNetRequest: {
    getDynamicRules: async () => [],
    updateDynamicRules: async () => {},
    updateEnabledRulesets: async () => {},
  },
};

function ctx(): HouseholdContext {
  return {
    role: "guardian",
    state: emptyHouseholdState("me", 1000),
    managed: EMPTY_MANAGED_POLICY,
    showError: (m) => void errors.push(m),
    onChanged: async () => {},
  };
}

beforeEach(() => {
  store = {};
  errors = [];
});

test("refusedAsAdult reads the packaged adult list: refuses the name and its subdomains, says why", async () => {
  assert.ok(nested !== undefined);
  for (const d of [adultName, `m.${adultName}`, nested]) {
    errors = [];
    assert.equal(await refusedAsAdult(d, (m) => void errors.push(m)), true, d);
    assert.deepEqual(errors, [ADULT_LISTED_ERROR]);
  }
  for (const d of [nested.slice(nested.indexOf(".") + 1), gamblingName, "example.com"]) {
    errors = [];
    assert.equal(await refusedAsAdult(d, (m) => void errors.push(m)), false, d);
    assert.deepEqual(errors, []);
  }
});

test("household list: an adult allow is refused and nothing is saved; a gambling allow and an adult block go in", async () => {
  const c = ctx();
  await addHouseholdDomain(c, "allow", `https://www.${adultName}/x`);
  assert.deepEqual(errors, [ADULT_LISTED_ERROR]);
  assert.ok(!(HOUSEHOLD_STATE_KEY in store));
  assert.deepEqual(c.state?.allowDomains, []);

  errors = [];
  await addHouseholdDomain(c, "allow", gamblingName);
  await addHouseholdDomain(c, "block", adultName);
  assert.deepEqual(errors, []);
  assert.deepEqual(c.state?.allowDomains, [gamblingName]);
  assert.deepEqual(c.state?.blockDomains, [adultName]);
});
