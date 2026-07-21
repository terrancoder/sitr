import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LAYER_BASES,
  LAYER_PRIORITIES,
  MAX_RULES_PER_LAYER_KIND,
  buildLayerRule,
  layerDomainsOf,
  layerKindOf,
  planLayerUpdate,
} from "../../extension/dist/lib/ruleLayers.js";

const LAYERS = ["user", "household", "managed"] as const;
const KINDS = ["allow", "block"] as const;

test("id ranges never overlap and stay within Chrome's 30k ceiling", () => {
  const ranges = LAYERS.flatMap((layer) =>
    KINDS.map((kind) => ({
      layer,
      kind,
      lo: LAYER_BASES[layer][kind],
      hi: LAYER_BASES[layer][kind] + MAX_RULES_PER_LAYER_KIND,
    })),
  );
  for (const a of ranges) {
    for (const b of ranges) {
      if (a === b) continue;
      assert.ok(
        a.hi <= b.lo || b.hi <= a.lo,
        `ranges overlap: ${a.layer}/${a.kind} and ${b.layer}/${b.kind}`,
      );
    }
  }
  assert.ok(ranges.length * MAX_RULES_PER_LAYER_KIND <= 30_000);
});

test("layerKindOf round-trips every range boundary", () => {
  for (const layer of LAYERS) {
    for (const kind of KINDS) {
      const base = LAYER_BASES[layer][kind];
      assert.deepEqual(layerKindOf(base), { layer, kind });
      assert.deepEqual(layerKindOf(base + MAX_RULES_PER_LAYER_KIND - 1), {
        layer,
        kind,
      });
      assert.equal(layerKindOf(base - 1)?.layer === layer &&
        layerKindOf(base - 1)?.kind === kind, false);
    }
  }
  assert.equal(layerKindOf(1), undefined); // static range
  assert.equal(layerKindOf(999_999), undefined);
});

test("precedence ladder: every higher layer beats every lower layer", () => {
  // Full pairwise matrix: for any two (layer, kind) cells, the one higher in
  // the documented ladder must carry the strictly greater DNR priority.
  const ladder: Array<[(typeof LAYERS)[number], (typeof KINDS)[number]]> = [
    ["user", "block"],
    ["user", "allow"],
    ["household", "block"],
    ["household", "allow"],
    ["managed", "block"],
    ["managed", "allow"],
  ];
  for (let i = 0; i < ladder.length; i++) {
    for (let j = i + 1; j < ladder.length; j++) {
      const [loL, loK] = ladder[i]!;
      const [hiL, hiK] = ladder[j]!;
      assert.ok(
        LAYER_PRIORITIES[hiL][hiK] > LAYER_PRIORITIES[loL][loK],
        `${hiL}/${hiK} must outrank ${loL}/${loK}`,
      );
    }
  }
  // And everything outranks the static rulesets (priority 1).
  assert.ok(LAYER_PRIORITIES.user.block > 1);
});

test("household block beats device allow; managed block beats household allow", () => {
  assert.ok(LAYER_PRIORITIES.household.block > LAYER_PRIORITIES.user.allow);
  assert.ok(LAYER_PRIORITIES.managed.block > LAYER_PRIORITIES.household.allow);
});

test("built rules include main_frame and a single domain", () => {
  for (const layer of LAYERS) {
    for (const kind of KINDS) {
      const rule = buildLayerRule(layer, kind, "example.com", LAYER_BASES[layer][kind]);
      assert.ok(rule.condition.resourceTypes.includes("main_frame"));
      assert.deepEqual(rule.condition.requestDomains, ["example.com"]);
      assert.equal(rule.priority, LAYER_PRIORITIES[layer][kind]);
      assert.equal(rule.action.type, kind);
    }
  }
});

test("planLayerUpdate reconciles adds and removes, leaving other layers alone", () => {
  const live = [
    buildLayerRule("household", "block", "old.example", LAYER_BASES.household.block),
    buildLayerRule("household", "block", "keep.example", LAYER_BASES.household.block + 1),
    buildLayerRule("user", "block", "user.example", LAYER_BASES.user.block),
    buildLayerRule("managed", "allow", "corp.example", LAYER_BASES.managed.allow),
  ];
  const r = planLayerUpdate(live, "household", "block", [
    "keep.example",
    "new.example",
  ]);
  assert.ok(r.ok);
  assert.deepEqual(r.value.removeRuleIds, [LAYER_BASES.household.block]);
  assert.equal(r.value.addRules.length, 1);
  assert.equal(r.value.addRules[0]!.condition.requestDomains[0], "new.example");
  // New rule reuses the freed slot's range but not the kept id.
  assert.equal(r.value.addRules[0]!.id, LAYER_BASES.household.block);
});

test("planLayerUpdate is idempotent when live already matches desired", () => {
  const live = [
    buildLayerRule("managed", "block", "a.example", LAYER_BASES.managed.block),
    buildLayerRule("managed", "block", "b.example", LAYER_BASES.managed.block + 1),
  ];
  const r = planLayerUpdate(live, "managed", "block", ["b.example", "a.example", "a.example"]);
  assert.ok(r.ok);
  assert.deepEqual(r.value, { addRules: [], removeRuleIds: [] });
});

test("planLayerUpdate surfaces cap overflow instead of truncating", () => {
  const tooMany = Array.from(
    { length: MAX_RULES_PER_LAYER_KIND + 1 },
    (_, i) => `d${i}.example`,
  );
  const r = planLayerUpdate([], "household", "allow", tooMany);
  assert.ok(!r.ok);
  assert.match(r.error, /limit/);
});

test("layerDomainsOf returns sorted domains for exactly one layer+kind", () => {
  const live = [
    buildLayerRule("household", "allow", "zeta.example", LAYER_BASES.household.allow),
    buildLayerRule("household", "allow", "alpha.example", LAYER_BASES.household.allow + 1),
    buildLayerRule("household", "block", "other.example", LAYER_BASES.household.block),
  ];
  const got = layerDomainsOf(live, "household", "allow");
  assert.deepEqual(
    got.map((g) => g.domain),
    ["alpha.example", "zeta.example"],
  );
});
