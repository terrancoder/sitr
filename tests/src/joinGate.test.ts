/**
 * Joining a household and a child device leaving one are loosening
 * actions: held by "wait before loosening", and joining asks for this
 * browser's own PIN. Pure rules via decideMutation; the real options-page
 * functions run against an in-memory chrome.* and scripted dialogs.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  DELAY_MINUTES_KEY,
  DELAY_REQUEST_KEY,
  JOIN_HOUSEHOLD_WAITS_AS,
  WINDOW_MS,
  decideMutation,
  needsWait,
  type DelayPhase,
} from "../../extension/dist/lib/delay.js";
import { EMPTY_MANAGED_POLICY } from "../../extension/dist/lib/managed.js";
import { HOUSEHOLD_ROLE_KEY, HOUSEHOLD_SECRET_KEY } from "../../extension/dist/lib/household.js";
import { PIN_KEY, createPinRecord, toB64 } from "../../extension/dist/lib/pin.js";
import { encodePairingCode, generateRootSecret } from "../../extension/dist/lib/sync/crypto.js";
import {
  joinHousehold,
  leaveAsChild,
  withGate,
  type GateUi,
  type HouseholdContext,
} from "../../extension/dist/options/household.js";

const PHASES: DelayPhase[] = ["off", "idle", "waiting", "open"];
const locked = { ...EMPTY_MANAGED_POLICY, lockOptions: true };

test("join rules: waits like disableCategory, PIN when set, never refused", () => {
  assert.equal(JOIN_HOUSEHOLD_WAITS_AS, "disableCategory");
  for (const phase of PHASES) {
    assert.equal(needsWait("joinHousehold", phase), needsWait("disableCategory", phase), phase);
  }
  for (const managed of [EMPTY_MANAGED_POLICY, locked]) {
    for (const role of [undefined, "child", "guardian"] as const) {
      const ctx = (hasPin: boolean) => ({ managed, role, hasPin });
      assert.deepEqual(decideMutation("joinHousehold", ctx(false), "off"), { step: "go" });
      assert.deepEqual(decideMutation("joinHousehold", ctx(false), "open"), { step: "go" });
      assert.deepEqual(decideMutation("joinHousehold", ctx(false), "idle"), { step: "wait" });
      assert.deepEqual(decideMutation("joinHousehold", ctx(true), "waiting"), { step: "wait" });
      assert.deepEqual(decideMutation("joinHousehold", ctx(true), "off"), { step: "pin" });
      assert.deepEqual(decideMutation("joinHousehold", ctx(true), "open"), { step: "pin" });
    }
  }
});

/* ----------------------- in-memory chrome and dialogs ---------------------- */

const MIN = 60_000;
let store: Record<string, unknown>;
let clock: number;
let prompts: string[];
let holds: DelayPhase[];
let errors: string[];
Date.now = () => clock;

(globalThis as Record<string, unknown>)["chrome"] = {
  storage: {
    local: {
      get: async (keys: string | string[]) =>
        Object.fromEntries(
          (Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]]),
        ),
      set: async (items: Record<string, unknown>) => void Object.assign(store, items),
      remove: async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
      },
    },
  },
  permissions: { request: async () => true },
  declarativeNetRequest: {
    getDynamicRules: async () => [],
    updateDynamicRules: async () => {},
    updateEnabledRulesets: async () => {},
  },
};

/** Dialogs: answer each prompt in turn; `during` runs while it is open. */
function ui(answers: Array<string | null>, during: () => void = () => {}): GateUi {
  return {
    prompt: async (message: string) => {
      prompts.push(message);
      during();
      return answers.shift() ?? null;
    },
    hold: async (d) => void holds.push(d.phase),
  };
}

function ctx(role: HouseholdContext["role"] = undefined, managed = EMPTY_MANAGED_POLICY): HouseholdContext {
  return {
    role,
    state: undefined,
    managed,
    showError: (m) => void (m !== "" && errors.push(m)),
    onChanged: async () => {},
  };
}

const secret = generateRootSecret();
const code = encodePairingCode(secret);
const T = 1_700_000_000_000;
/** Wait of 5 minutes, request made at T: open from T+5min to T+15min. */
const waitOn = (request: boolean) => {
  store[DELAY_MINUTES_KEY] = 5;
  if (request) store[DELAY_REQUEST_KEY] = { at: T };
};
const pin = (await createPinRecord("1234"));
assert.ok(pin.ok);

beforeEach(() => {
  store = {};
  clock = T;
  prompts = [];
  holds = [];
  errors = [];
});

test("join: no wait and no PIN joins as before, also on a managed install", async () => {
  const c = ctx(undefined, locked);
  assert.equal(await joinHousehold(c, code, "child", ui([])), true);
  assert.deepEqual([prompts, holds, errors], [[], [], []]);
  assert.equal(store[HOUSEHOLD_ROLE_KEY], "child");
  assert.equal(store[HOUSEHOLD_SECRET_KEY], toB64(secret));
  assert.equal(c.role, "child");
});

test("join: wait on and not open -> held, nothing joined", async () => {
  waitOn(false);
  assert.equal(await joinHousehold(ctx(), code, "guardian", ui([])), false);
  waitOn(true); // requested, still waiting
  assert.equal(await joinHousehold(ctx(), code, "guardian", ui([])), false);
  assert.deepEqual(holds, ["idle", "waiting"]);
  assert.deepEqual(prompts, []);
  assert.equal(store[HOUSEHOLD_SECRET_KEY], undefined);
});

test("join: a local PIN is asked first; wrong PIN does not join", async () => {
  store[PIN_KEY] = pin.value;
  assert.equal(await joinHousehold(ctx(), code, "guardian", ui(["0000"])), false);
  assert.deepEqual(errors, ["Wrong PIN."]);
  assert.equal(store[HOUSEHOLD_SECRET_KEY], undefined);
  clock = T + 60 * MIN; // past the failure backoff
  assert.equal(await joinHousehold(ctx(), code, "guardian", ui(["1234"])), true);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /this browser's PIN/);
  assert.equal(store[HOUSEHOLD_ROLE_KEY], "guardian");
});

test("join: wait and PIN -> the wait first, then the PIN, then the wait again", async () => {
  store[PIN_KEY] = pin.value;
  waitOn(false);
  assert.equal(await joinHousehold(ctx(), code, "child", ui(["1234"])), false);
  assert.deepEqual([holds, prompts], [["idle"], []]); // no PIN asked while held
  waitOn(true);
  clock = T + 5 * MIN + 1000; // open
  // The window closes while the PIN prompt is open: held after a correct PIN.
  const closes = () => void (clock = T + 5 * MIN + WINDOW_MS);
  assert.equal(await joinHousehold(ctx(), code, "child", ui(["1234"], closes)), false);
  assert.equal(prompts.length, 1);
  assert.deepEqual(holds, ["idle", "idle"]);
  assert.equal(store[HOUSEHOLD_SECRET_KEY], undefined);
  // Inside the window with the right PIN it goes through.
  store[DELAY_REQUEST_KEY] = { at: T };
  clock = T + 5 * MIN + 1000;
  assert.equal(await joinHousehold(ctx(), code, "child", ui(["1234"])), true);
});

test("withGate re-checks the wait AFTER a correct PIN", async () => {
  store[PIN_KEY] = pin.value;
  waitOn(true);
  clock = T + 5 * MIN + 1000;
  let ran = false;
  const closes = () => void (clock = T + 5 * MIN + WINDOW_MS + 1);
  const done = await withGate("disableCategory", ctx("guardian"), async () => void (ran = true), ui(["1234"], closes));
  assert.deepEqual([done, ran, holds, errors], [false, false, ["idle"], []]);
  assert.equal(prompts.length, 1);
});

test("child leave: the pairing code, and the wait on top", async () => {
  const child = () => {
    store[HOUSEHOLD_SECRET_KEY] = toB64(secret);
    store[HOUSEHOLD_ROLE_KEY] = "child";
    return ctx("child");
  };
  // No wait: the right code leaves, a wrong one does not.
  assert.equal(await leaveAsChild(child(), ui([encodePairingCode(generateRootSecret())])), false);
  assert.deepEqual(errors, ["That pairing code does not match this household."]);
  assert.equal(await leaveAsChild(child(), ui([code])), true);
  assert.equal(store[HOUSEHOLD_SECRET_KEY], undefined);
  // Wait on, not open: held before the code is even asked.
  prompts = [];
  waitOn(false);
  assert.equal(await leaveAsChild(child(), ui([code])), false);
  assert.deepEqual([holds, prompts], [["idle"], []]);
  // Open, but the window closes while the code prompt is open: held.
  waitOn(true);
  clock = T + 5 * MIN + 1000;
  const closes = () => void (clock = T + 5 * MIN + WINDOW_MS);
  assert.equal(await leaveAsChild(child(), ui([code], closes)), false);
  assert.deepEqual(holds, ["idle", "idle"]);
  assert.equal(store[HOUSEHOLD_ROLE_KEY], "child");
  // Inside the window with the code: leaves.
  store[DELAY_REQUEST_KEY] = { at: T };
  clock = T + 5 * MIN + 1000;
  assert.equal(await leaveAsChild(child(), ui([code])), true);
});
