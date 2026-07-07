import assert from "node:assert/strict";
import { test } from "node:test";

import {
  badgeFor,
  deriveStatus,
  REQUIRED_RULESETS,
} from "../../extension/dist/lib/status.js";

test("all required rulesets enabled -> active, no badge", () => {
  const s = deriveStatus([...REQUIRED_RULESETS]);
  assert.equal(s.state, "active");
  assert.equal(badgeFor(s).text, "");
});

test("missing ruleset -> inactive with the missing id named", () => {
  const s = deriveStatus(
    REQUIRED_RULESETS.filter((id) => id !== "sitr_safesearch"),
  );
  assert.equal(s.state, "inactive");
  assert.ok(s.state === "inactive" && s.missingRulesets.includes("sitr_safesearch"));
  const badge = badgeFor(s);
  assert.equal(badge.text, "!");
  assert.match(badge.title, /INACTIVE/);
});

test("no rulesets at all -> inactive, never optimistic", () => {
  const s = deriveStatus([]);
  assert.equal(s.state, "inactive");
});

test("unknown state renders as a visible error badge", () => {
  const badge = badgeFor({ state: "unknown", reason: "query failed" });
  assert.equal(badge.text, "?");
  assert.match(badge.title, /unknown/);
});
