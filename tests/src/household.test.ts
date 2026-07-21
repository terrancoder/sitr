import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bumpRev,
  emptyHouseholdState,
  MAX_HOUSEHOLD_DEVICES,
  MAX_HOUSEHOLD_DOMAINS,
  mergeStates,
  sanitizeHouseholdState,
} from "../../extension/dist/lib/household.js";

test("empty state is valid and child-locked by default", () => {
  const s = emptyHouseholdState("dev-a", 1000);
  const r = sanitizeHouseholdState(s);
  assert.ok(r.ok);
  assert.deepEqual(r.value, s);
  assert.equal(s.policy.childLockOptions, true);
});

test("sanitize rejects non-objects and unknown versions, keeps rev sacred", () => {
  for (const bad of [null, 42, "x", [], { v: 2, rev: 1 }, { v: 1 }, { v: 1, rev: 0 }]) {
    assert.ok(!sanitizeHouseholdState(bad).ok, JSON.stringify(bad));
  }
});

test("sanitize scrubs invalid domains and categories, dedupes and sorts", () => {
  const r = sanitizeHouseholdState({
    v: 1,
    rev: 3,
    updatedAt: 5,
    updatedBy: "dev",
    allowDomains: ["b.example", "b.example", "not valid", "a.example"],
    blockDomains: "nope",
    disabledCategories: ["sitr_gambling", "sitr_adult", "junk"],
    policy: {},
  });
  assert.ok(r.ok);
  assert.deepEqual(r.value.allowDomains, ["a.example", "b.example"]);
  assert.deepEqual(r.value.blockDomains, []);
  assert.deepEqual(r.value.disabledCategories, ["sitr_gambling"]);
  assert.equal(r.value.policy.childLockOptions, true);
});

test("sanitize enforces the household domain cap as an error", () => {
  const r = sanitizeHouseholdState({
    v: 1,
    rev: 1,
    allowDomains: Array.from(
      { length: MAX_HOUSEHOLD_DOMAINS + 1 },
      (_, i) => `d${i}.example`,
    ),
  });
  assert.ok(!r.ok);
  assert.match(r.error, /exceeds/);
});

test("creator device is enrolled; device list is capped at the fair-use limit", () => {
  const s = emptyHouseholdState("dev-a", 1);
  assert.deepEqual(s.devices, ["dev-a"]);
  const atCap = {
    ...s,
    devices: Array.from({ length: MAX_HOUSEHOLD_DEVICES }, (_, i) => `d${i}`),
  };
  assert.ok(sanitizeHouseholdState(atCap).ok);
  const overCap = {
    ...s,
    devices: Array.from({ length: MAX_HOUSEHOLD_DEVICES + 1 }, (_, i) => `d${i}`),
  };
  const r = sanitizeHouseholdState(overCap);
  assert.ok(!r.ok);
  assert.match(r.error, /fair-use/);
});

test("merge is last-writer-wins with total tie-breaking", () => {
  const base = emptyHouseholdState("a", 100);
  const newer = bumpRev(base, "b", 200);
  assert.equal(mergeStates(base, newer), newer);
  assert.equal(mergeStates(newer, base), newer);
  // Same rev: later updatedAt wins.
  const x = { ...base, rev: 5, updatedAt: 10, updatedBy: "a" };
  const y = { ...base, rev: 5, updatedAt: 20, updatedBy: "b" };
  assert.equal(mergeStates(x, y), y);
  // Same rev+time: updatedBy tiebreak is symmetric and deterministic.
  const z = { ...y, updatedAt: 10 };
  assert.equal(mergeStates(x, z), mergeStates(z, x));
});

test("bumpRev increments and re-stamps authorship", () => {
  const s = emptyHouseholdState("a", 100);
  const b = bumpRev(s, "b", 500);
  assert.equal(b.rev, s.rev + 1);
  assert.equal(b.updatedBy, "b");
  assert.equal(b.updatedAt, 500);
  assert.equal(s.rev, 1, "original untouched");
});
