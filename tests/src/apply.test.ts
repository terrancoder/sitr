import assert from "node:assert/strict";
import { test } from "node:test";

import { applyHouseholdState } from "../../extension/dist/lib/sync/apply.js";
import { emptyHouseholdState } from "../../extension/dist/lib/household.js";
import { LAYER_BASES } from "../../extension/dist/lib/ruleLayers.js";

function stubDeps(calls: string[], failOn?: string) {
  return {
    live: [] as Array<{ id: number; condition?: { requestDomains?: string[] } }>,
    async getDynamicRules() {
      calls.push("get");
      if (failOn === "get") throw new Error("get failed");
      return this.live;
    },
    async updateDynamicRules(u: { addRules?: unknown[]; removeRuleIds?: number[] }) {
      calls.push(`update:${u.addRules?.length ?? 0}+/${u.removeRuleIds?.length ?? 0}-`);
      if (failOn === "update") throw new Error("update failed");
    },
    async updateEnabledRulesets() {
      calls.push("rulesets");
      if (failOn === "rulesets") throw new Error("rulesets failed");
    },
    async persist() {
      calls.push("persist");
      if (failOn === "persist") throw new Error("persist failed");
    },
  };
}

test("applies rules and categories to the engine BEFORE persisting", async () => {
  const calls: string[] = [];
  const deps = stubDeps(calls);
  const state = {
    ...emptyHouseholdState("dev", 1),
    blockDomains: ["blocked.example"],
  };
  const r = await applyHouseholdState(state, [], deps);
  assert.ok(r.ok);
  assert.equal(calls[calls.length - 1], "persist", "persist must be last");
  assert.ok(calls.includes("update:1+/0-"), `calls: ${calls.join(",")}`);
  assert.ok(calls.indexOf("rulesets") < calls.indexOf("persist"));
});

test("no dynamic-rule update call when nothing changed (idempotent)", async () => {
  const calls: string[] = [];
  const deps = stubDeps(calls);
  deps.live = [
    {
      id: LAYER_BASES.household.block,
      condition: { requestDomains: ["blocked.example"] },
    },
  ];
  const state = {
    ...emptyHouseholdState("dev", 1),
    blockDomains: ["blocked.example"],
  };
  const r = await applyHouseholdState(state, [], deps);
  assert.ok(r.ok);
  assert.ok(!calls.some((c) => c.startsWith("update:")), calls.join(","));
});

test("engine failure surfaces as an error and nothing is persisted", async () => {
  const calls: string[] = [];
  const deps = stubDeps(calls, "update");
  const state = {
    ...emptyHouseholdState("dev", 1),
    allowDomains: ["ok.example"],
  };
  const r = await applyHouseholdState(state, [], deps);
  assert.ok(!r.ok);
  assert.ok(!calls.includes("persist"));
});

test("managed-forced categories are never disabled by household state", async () => {
  const calls: string[] = [];
  const disables: string[][] = [];
  const deps = {
    ...stubDeps(calls),
    async updateEnabledRulesets(u: { disableRulesetIds?: string[] }) {
      disables.push(u.disableRulesetIds ?? []);
    },
  };
  const state = {
    ...emptyHouseholdState("dev", 1),
    disabledCategories: ["sitr_gambling" as const, "sitr_dating" as const],
  };
  const r = await applyHouseholdState(state, ["sitr_gambling"], deps);
  assert.ok(r.ok);
  assert.deepEqual(disables, [["sitr_dating"]]);
});
