import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DELAY_MINUTES,
  WINDOW_MS,
  decideMutation,
  delayChangeAction,
  evaluate,
  needsWait,
  sanitizeDelayMinutes,
  sanitizeDelayRequest,
} from "../../extension/dist/lib/delay.js";
import {
  EMPTY_MANAGED_POLICY,
  effectiveRequiredRulesets,
} from "../../extension/dist/lib/managed.js";
import {
  ENABLED_OPTIONAL_KEY,
  OPTIONAL_LISTS,
  TOGGLEABLE_CATEGORIES,
  sanitizeEnabledOptional,
} from "../../extension/dist/lib/categories.js";
import { deriveStatus } from "../../extension/dist/lib/status.js";

const MIN = 60_000;
const T = 1_700_000_000_000;

test("evaluate walks off -> idle -> waiting -> open -> idle", () => {
  assert.deepEqual(evaluate(0, { at: T }, T), { phase: "off", remainingMs: 0, request: null });
  assert.deepEqual(evaluate(5, null, T), { phase: "idle", remainingMs: 0, request: null });
  assert.deepEqual(evaluate(5, { at: T }, T + MIN), {
    phase: "waiting", remainingMs: 4 * MIN, request: { at: T },
  });
  assert.deepEqual(evaluate(5, { at: T }, T + 5 * MIN), {
    phase: "open", remainingMs: WINDOW_MS, request: { at: T },
  });
  assert.equal(evaluate(5, { at: T }, T + 5 * MIN + WINDOW_MS - 1).phase, "open");
  assert.deepEqual(evaluate(5, { at: T }, T + 5 * MIN + WINDOW_MS), {
    phase: "idle", remainingMs: 0, request: null,
  });
});

test("evaluate never opens early when the clock goes backwards: the wait restarts", () => {
  for (const minutes of DELAY_MINUTES.filter((m) => m > 0)) {
    for (const now of [T - 1, 0]) {
      assert.deepEqual(evaluate(minutes, { at: T }, now), {
        phase: "waiting", remainingMs: minutes * MIN, request: { at: now },
      });
    }
  }
});

test("needsWait: only loosening kinds and shortenDelay, only outside the window", () => {
  for (const phase of ["off", "open"] as const) {
    assert.equal(needsWait("disableCategory", phase), false);
    assert.equal(needsWait("shortenDelay", phase), false);
  }
  for (const phase of ["idle", "waiting"] as const) {
    assert.equal(needsWait("disableCategory", phase), true);
    assert.equal(needsWait("addDeviceAllowRule", phase), true);
    assert.equal(needsWait("shortenDelay", phase), true);
    assert.equal(needsWait("enableCategory", phase), false);
    assert.equal(needsWait("addDeviceBlockRule", phase), false);
    assert.equal(needsWait("changePin", phase), false);
  }
  assert.equal(delayChangeAction(60, 5), "shortenDelay");
  assert.equal(delayChangeAction(60, 0), "shortenDelay");
  assert.equal(delayChangeAction(5, 60), null);
  assert.equal(delayChangeAction(0, 5), null);
});

test("decideMutation order: gate refusal beats the delay, the delay beats the PIN", () => {
  const ctx = (o: { lock?: boolean; role?: "guardian" | "child"; pin?: boolean }) => ({
    managed: { ...EMPTY_MANAGED_POLICY, lockOptions: o.lock === true },
    role: o.role,
    hasPin: o.pin === true,
  });
  // Refused stays refused whatever the delay says.
  assert.deepEqual(decideMutation("disableCategory", ctx({ lock: true }), "open"), {
    step: "refused", reason: "managed-locked",
  });
  assert.deepEqual(decideMutation("disableCategory", ctx({ role: "child" }), "idle"), {
    step: "refused", reason: "child-device",
  });
  assert.deepEqual(decideMutation("shortenDelay", ctx({ role: "child" }), "open"), {
    step: "refused", reason: "child-device",
  });
  // Delay before PIN: held without ever asking for the PIN.
  assert.deepEqual(decideMutation("disableCategory", ctx({ pin: true }), "waiting"), { step: "wait" });
  // Inside the window the PIN still applies: both ceremonies, in order.
  assert.deepEqual(decideMutation("disableCategory", ctx({ pin: true }), "open"), { step: "pin" });
  assert.deepEqual(decideMutation("shortenDelay", ctx({ pin: true }), "open"), { step: "pin" });
  assert.deepEqual(decideMutation("disableCategory", ctx({}), "open"), { step: "go" });
  assert.deepEqual(decideMutation("disableCategory", ctx({}), "off"), { step: "go" });
  // Tightening is never held; the category toggle's ON side is enableCategory.
  assert.deepEqual(decideMutation("enableCategory", ctx({ pin: true }), "idle"), { step: "go" });
  assert.deepEqual(decideMutation("enableCategory", ctx({ role: "child" }), "idle"), { step: "go" });
});

test("delay storage sanitizers degrade to off / no request", () => {
  assert.equal(sanitizeDelayMinutes(30), 30);
  assert.equal(sanitizeDelayMinutes(7), 0);
  assert.equal(sanitizeDelayMinutes("30"), 0);
  assert.deepEqual(sanitizeDelayRequest({ at: 5 }), { at: 5 });
  assert.equal(sanitizeDelayRequest({ at: -1 }), null);
  assert.equal(sanitizeDelayRequest({ at: 1.5 }), null);
  assert.equal(sanitizeDelayRequest(null), null);
});

test("opt-in lists: sanitized, separate from categories, required only when on", () => {
  assert.equal(ENABLED_OPTIONAL_KEY, "enabledOptionalLists");
  assert.deepEqual(sanitizeEnabledOptional(["sitr_violence", "sitr_violence", "sitr_gambling", 3]), [
    "sitr_violence",
  ]);
  assert.deepEqual(sanitizeEnabledOptional("nope"), []);
  const optionalIds = OPTIONAL_LISTS.map((l) => l.rulesetId) as string[];
  for (const c of TOGGLEABLE_CATEGORIES) assert.ok(!optionalIds.includes(c.rulesetId));
  // Default: never required, so a disabled violence ruleset is not a failure.
  const base = effectiveRequiredRulesets([], [], []);
  assert.ok(!base.includes("sitr_violence"));
  assert.deepEqual(deriveStatus(["sitr_adult", "sitr_safesearch", "sitr_gambling", "sitr_dating"], base), {
    state: "active",
  });
  // On: required, so enabled -> green, failed to enable -> red.
  const on = [...base, ...sanitizeEnabledOptional(["sitr_violence"])];
  assert.equal(deriveStatus([...base, "sitr_violence"], on).state, "active");
  assert.deepEqual(deriveStatus(base, on), { state: "inactive", missingRulesets: ["sitr_violence"] });
});
