import assert from "node:assert/strict";
import { test } from "node:test";

import { badgeFor, deriveStatus } from "../../extension/dist/lib/status.js";
import {
  ALWAYS_ON_RULESETS,
  requiredRulesets,
  sanitizeDisabled,
} from "../../extension/dist/lib/categories.js";

const ALL = requiredRulesets([]);

test("all required rulesets enabled -> active, no badge", () => {
  const s = deriveStatus([...ALL], ALL);
  assert.equal(s.state, "active");
  assert.equal(badgeFor(s).text, "");
});

test("missing ruleset -> inactive with the missing id named", () => {
  const s = deriveStatus(
    ALL.filter((id) => id !== "sitr_safesearch"),
    ALL,
  );
  assert.equal(s.state, "inactive");
  assert.ok(s.state === "inactive" && s.missingRulesets.includes("sitr_safesearch"));
  const badge = badgeFor(s);
  assert.equal(badge.text, "!");
  assert.match(badge.title, /INACTIVE/);
});

test("no rulesets at all -> inactive, never optimistic", () => {
  const s = deriveStatus([], ALL);
  assert.equal(s.state, "inactive");
});

test("a category the user disabled is not a protection failure", () => {
  const required = requiredRulesets(["sitr_gambling"]);
  assert.ok(!required.includes("sitr_gambling"));
  const s = deriveStatus(required, required);
  assert.equal(s.state, "active");
});

test("always-on rulesets cannot be removed via disabled prefs", () => {
  const required = requiredRulesets(
    sanitizeDisabled(["sitr_adult", "sitr_safesearch", "sitr_gambling", 42, "junk"]),
  );
  for (const id of ALWAYS_ON_RULESETS) {
    assert.ok(required.includes(id), `${id} must stay required`);
  }
  assert.ok(!required.includes("sitr_gambling"));
});

test("sanitizeDisabled tolerates garbage stored values", () => {
  assert.deepEqual(sanitizeDisabled(undefined), []);
  assert.deepEqual(sanitizeDisabled("nope"), []);
  assert.deepEqual(sanitizeDisabled(["sitr_dating", "sitr_dating"]), ["sitr_dating"]);
});

test("unknown state renders as a visible error badge", () => {
  const badge = badgeFor({ state: "unknown", reason: "query failed" });
  assert.equal(badge.text, "?");
  assert.match(badge.title, /unknown/);
});
