import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EMPTY_MANAGED_POLICY,
  effectiveRequiredRulesets,
  isCategoryLocked,
  isManaged,
  sanitizeManagedPolicy,
} from "../../extension/dist/lib/managed.js";

test("absent or garbage policy degrades to the empty policy, never throws", () => {
  for (const raw of [undefined, null, 42, "x", [], {}, { unknownKey: 1 }]) {
    assert.deepEqual(sanitizeManagedPolicy(raw), EMPTY_MANAGED_POLICY);
  }
});

test("empty policy means the device is not managed", () => {
  assert.equal(isManaged(EMPTY_MANAGED_POLICY), false);
  assert.equal(isManaged(sanitizeManagedPolicy({ lockOptions: true })), true);
  assert.equal(
    isManaged(sanitizeManagedPolicy({ organizationName: "Al-Noor Academy" })),
    true,
  );
});

test("sanitize keeps only known toggleable categories", () => {
  const p = sanitizeManagedPolicy({
    forcedCategories: ["sitr_gambling", "sitr_adult", "bogus", 7, "sitr_dating"],
  });
  assert.deepEqual(p.forcedCategories.sort(), ["sitr_dating", "sitr_gambling"]);
});

test("sanitize drops invalid domains and dedupes/sorts the rest", () => {
  const p = sanitizeManagedPolicy({
    managedBlockDomains: ["b.example", "not a domain", "a.example", "b.example", "*.x.com"],
    managedAllowDomains: 3,
  });
  assert.deepEqual(p.managedBlockDomains, ["a.example", "b.example"]);
  assert.deepEqual(p.managedAllowDomains, []);
});

test("sanitize trims and bounds organizationName, treats blank as unset", () => {
  assert.equal(
    sanitizeManagedPolicy({ organizationName: "  Masjid An-Noor  " })
      .organizationName,
    "Masjid An-Noor",
  );
  assert.equal(
    sanitizeManagedPolicy({ organizationName: "   " }).organizationName,
    undefined,
  );
  assert.equal(
    sanitizeManagedPolicy({ organizationName: "x".repeat(500) })
      .organizationName?.length,
    200,
  );
});

test("forced categories override device and household disables", () => {
  const required = effectiveRequiredRulesets(
    ["sitr_gambling"],
    ["sitr_dating"],
    ["sitr_gambling", "sitr_dating"],
  );
  assert.ok(required.includes("sitr_gambling"));
  assert.ok(required.includes("sitr_dating"));
});

test("without force, device and household disables both apply", () => {
  const required = effectiveRequiredRulesets(["sitr_gambling"], ["sitr_dating"], []);
  assert.ok(!required.includes("sitr_gambling"));
  assert.ok(!required.includes("sitr_dating"));
  assert.ok(required.includes("sitr_adult"));
  assert.ok(required.includes("sitr_safesearch"));
});

test("category lock: forced or lockOptions", () => {
  const forced = sanitizeManagedPolicy({ forcedCategories: ["sitr_gambling"] });
  assert.equal(isCategoryLocked("sitr_gambling", forced), true);
  assert.equal(isCategoryLocked("sitr_dating", forced), false);
  const locked = sanitizeManagedPolicy({ lockOptions: true });
  assert.equal(isCategoryLocked("sitr_dating", locked), true);
});
