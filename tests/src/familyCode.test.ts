/**
 * The options page's Sitr Family code (full channel): the three code
 * actions behind the gate (FAMILY_CODE_GATED_AS), creating a household
 * with a code, leaving with the code's keys, and the state texts. The real
 * options-page functions run against an in-memory chrome.*, scripted
 * dialogs and a scripted claim service.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { EMPTY_MANAGED_POLICY } from "../../extension/dist/lib/managed.js";
import {
  HOUSEHOLD_ROLE_KEY,
  HOUSEHOLD_SECRET_KEY,
  HOUSEHOLD_STATE_KEY,
  emptyHouseholdState,
} from "../../extension/dist/lib/household.js";
import { PIN_ATTEMPTS_KEY, PIN_KEY, createPinRecord } from "../../extension/dist/lib/pin.js";
import { DAY, WAITING_TEXT } from "../../extension/dist/lib/householdEnd.js";
import { TEXTS, emptyClaimState, type ClaimState } from "../../extension/dist/lib/entitlement.js";
import { HOUSEHOLD_END_KEY } from "../../extension/dist/background/memberChannel.js";
import {
  CLAIM_SECRET_KEY,
  CLAIM_STATE_KEY,
  SUBSCRIPTION_CODE_KEY,
} from "../../extension/dist/background/fullChannel.js";
import { encodePairingCode, generateRootSecret } from "../../extension/dist/lib/sync/crypto.js";
import {
  endLine,
  joinHousehold,
  leaveHousehold,
  type GateUi,
  type HouseholdContext,
} from "../../extension/dist/options/household.js";
import {
  LEAVE_QUESTION,
  MOVE_QUESTION,
  NEEDS_CLAIM_ACCESS,
  REMOVE_QUESTION,
  familyLines,
  removeCode,
  renewHere,
  submitCode,
  wireFullChannel,
} from "../../extension/dist/options/fullChannel.js";

/* ----------------------- in-memory chrome and dialogs ---------------------- */

const T = Date.UTC(2026, 10, 20);
let store: Record<string, unknown>;
let prompts: string[];
let errors: string[];
let requested: string[][];
let alarms: number;
let claims: Array<Record<string, unknown>>;
let granted: boolean;
Date.now = () => T;

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
  permissions: {
    request: async (p: { origins: string[] }) => (requested.push(p.origins), granted),
    contains: async () => granted,
  },
  alarms: { create: async () => void alarms++ },
  declarativeNetRequest: {
    getDynamicRules: async () => [],
    updateDynamicRules: async () => {},
    updateEnabledRulesets: async () => {},
  },
};

function ui(answers: Array<string | null>): GateUi {
  return {
    prompt: async (message: string) => {
      prompts.push(message);
      return answers.shift() ?? null;
    },
    hold: async () => {},
  };
}

function ctx(
  role: HouseholdContext["role"],
  managed = EMPTY_MANAGED_POLICY,
  inHousehold = role !== undefined,
): HouseholdContext {
  return {
    role,
    state: inHousehold ? { ...emptyHouseholdState("me", T - DAY), rev: 3 } : undefined,
    managed,
    showError: (m) => void (m !== "" && errors.push(m)),
    onChanged: async () => {},
  };
}

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const token = (plan = "family") =>
  `sitr-ent-v2.${b64url({ v: 2, plan, term: "month", per: T - DAY, exp: T + 14 * DAY })}.sig`;

/** The claim service: answers in turn, each a status and a body. */
function claimService(...answers: Array<[number, unknown]>): typeof fetch {
  return (async (_url: string, init: { body: string }) => {
    claims.push(JSON.parse(init.body) as Record<string, unknown>);
    const [status, body] = answers.shift() ?? [503, {}];
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

const CODE = "6f1c2a3b-1d2e-4f50-8a9b-0c1d2e3f4a5b";
const locked = { ...EMPTY_MANAGED_POLICY, lockOptions: true };
const pin = await createPinRecord("1234");
assert.ok(pin.ok);

beforeEach(() => {
  store = {};
  prompts = [];
  errors = [];
  requested = [];
  alarms = 0;
  claims = [];
  granted = true;
});

/* ------------------------------ the three actions -------------------------- */

const REFUSED_CHILD = "This setting can only be changed from a guardian device.";
const REFUSED_LOCK = "Settings are locked by your organization's administrator.";

test("enter a code on a guardian device: stored with a new claim secret, claims forgotten, a round started", async () => {
  store[CLAIM_STATE_KEY] = { ...emptyClaimState(), stopped: true, lastRefusal: "unknown-code", entExp: T + DAY };
  assert.equal(await submitCode(ctx("guardian"), ` ${CODE.toUpperCase()} `, ui([])), true);
  assert.deepEqual(requested, [["https://sync.sitrshield.com/*", "https://claim.sitrshield.com/*"]]);
  assert.equal(store[SUBSCRIPTION_CODE_KEY], CODE);
  assert.match(store[CLAIM_SECRET_KEY] as string, /^[A-Za-z0-9_-]{43}$/);
  const s = store[CLAIM_STATE_KEY] as ClaimState;
  assert.deepEqual([s.stopped, s.lastRefusal, s.entExp], [false, null, T + DAY]);
  assert.equal(alarms, 1);
  assert.deepEqual([prompts, errors, claims], [[], [], []]);
  // The same code again keeps its secret.
  const secret = store[CLAIM_SECRET_KEY];
  await submitCode(ctx("guardian"), CODE, ui([]));
  assert.equal(store[CLAIM_SECRET_KEY], secret);
});

test("enter a code: the guardian PIN when set; a wrong one stores nothing", async () => {
  store[PIN_KEY] = pin.value;
  assert.equal(await submitCode(ctx("guardian"), CODE, ui(["0000"])), false);
  assert.equal(store[SUBSCRIPTION_CODE_KEY], undefined);
  assert.deepEqual(errors, ["Wrong PIN."]);
  errors = [];
  delete store[PIN_ATTEMPTS_KEY]; // past the failure backoff
  assert.equal(await submitCode(ctx("guardian"), CODE, ui(["1234"])), true);
  assert.deepEqual(prompts, ["Enter the guardian PIN:", "Enter the guardian PIN:"]);
  assert.equal(store[SUBSCRIPTION_CODE_KEY], CODE);
});

test("enter a code: refused on a child device and under a managed lock", async () => {
  assert.equal(await submitCode(ctx("child"), CODE, ui([])), false);
  assert.equal(await submitCode(ctx("guardian", locked), CODE, ui([])), false);
  assert.deepEqual(errors, [REFUSED_CHILD, REFUSED_LOCK]);
  assert.equal(store[SUBSCRIPTION_CODE_KEY], undefined);
});

test("anything that is neither a code nor a token is refused on the device and sends nothing", async () => {
  assert.equal(await submitCode(ctx("guardian"), "hello", ui([])), false);
  assert.deepEqual([errors, requested], [[TEXTS["input-invalid"]], []]);
});

const holding = () => {
  store[SUBSCRIPTION_CODE_KEY] = CODE;
  store[CLAIM_SECRET_KEY] = "s".repeat(43);
  store[CLAIM_STATE_KEY] = { ...emptyClaimState(), entExp: T + 20 * DAY, lastRefusal: "unknown-code", stopped: true };
};

test("remove the code: asked first, then the gate; code and secret go together, E stays", async () => {
  holding();
  assert.equal(await removeCode(ctx("guardian"), ui([null])), null);
  assert.equal(store[SUBSCRIPTION_CODE_KEY], CODE); // cancelled
  const said = await removeCode(ctx("guardian"), ui([""]));
  assert.equal(said, "This device no longer renews the subscription. The household runs until 10 December 2026.");
  assert.deepEqual(prompts, [REMOVE_QUESTION, REMOVE_QUESTION]);
  assert.equal(store[SUBSCRIPTION_CODE_KEY], undefined);
  assert.equal(store[CLAIM_SECRET_KEY], undefined);
  const s = store[CLAIM_STATE_KEY] as ClaimState;
  assert.deepEqual([s.entExp, s.stopped, s.lastRefusal], [T + 20 * DAY, false, null]);
});

test("remove the code: PIN when set; refused on a child device and under a managed lock", async () => {
  holding();
  assert.equal(await removeCode(ctx("child"), ui([""])), null);
  assert.equal(await removeCode(ctx("guardian", locked), ui([""])), null);
  assert.deepEqual(errors, [REFUSED_CHILD, REFUSED_LOCK]);
  assert.equal(store[SUBSCRIPTION_CODE_KEY], CODE);
  store[PIN_KEY] = pin.value;
  assert.notEqual(await removeCode(ctx("guardian"), ui(["", "1234"])), null);
  assert.equal(prompts.at(-1), "Enter the guardian PIN:");
  assert.equal(store[SUBSCRIPTION_CODE_KEY], undefined);
});

test("renew on this browser: permission first, then the question, then the gate; replace: true, current when lapsed", async () => {
  holding();
  store[CLAIM_STATE_KEY] = { ...emptyClaimState(), entExp: T - DAY, lastRefusal: "bound-to-other-device", lapseRefused: true };
  const f = claimService([200, { token: token() }]);
  assert.equal(await renewHere(ctx("guardian"), ui([""]), f), true);
  assert.deepEqual(requested, [["https://claim.sitrshield.com/*"]]);
  assert.deepEqual(prompts, [MOVE_QUESTION]);
  assert.deepEqual([claims[0]?.["replace"], claims[0]?.["current"], claims[0]?.["credential"]], [true, true, CODE]);
  const s = store[CLAIM_STATE_KEY] as ClaimState;
  assert.deepEqual([s.lastRefusal, s.tokens.length], [null, 1]);
  assert.equal(alarms, 1);
});

test("renew on this browser: PIN when set; refused on a child device and under a managed lock", async () => {
  holding();
  assert.equal(await renewHere(ctx("child"), ui([""]), claimService()), false);
  assert.equal(await renewHere(ctx("guardian", locked), ui([""]), claimService()), false);
  assert.deepEqual(errors, [REFUSED_CHILD, REFUSED_LOCK]);
  assert.equal(claims.length, 0);
  store[PIN_KEY] = pin.value;
  assert.equal(await renewHere(ctx("guardian"), ui(["", "1234"]), claimService([200, { token: token() }])), true);
  assert.deepEqual(prompts.slice(-2), [MOVE_QUESTION, "Enter the guardian PIN:"]);
  assert.equal(claims.length, 1);
});

/* --------------------------------- creation -------------------------------- */

test("create with a code: claim, then the household; the token waits in the claim state for the creating write", async () => {
  const c = ctx(undefined);
  assert.equal(await submitCode(c, CODE, ui([null]), claimService([200, { token: token() }])), true);
  assert.deepEqual(claims.map((b) => [b["source"], b["replace"], b["current"]]), [["polar", false, false]]);
  assert.equal(store[SUBSCRIPTION_CODE_KEY], CODE);
  assert.equal(claims[0]?.["claim_secret"], store[CLAIM_SECRET_KEY]);
  assert.equal((store[CLAIM_STATE_KEY] as ClaimState).tokens.length, 1);
  assert.equal(store[HOUSEHOLD_ROLE_KEY], "guardian");
  assert.equal(typeof store[HOUSEHOLD_SECRET_KEY], "string");
  assert.deepEqual(prompts, ["Set a guardian PIN (4–32 characters). It will be required to loosen protection:"]);
});

test("create with a code bound elsewhere: asked to move it (also right for this browser's own earlier household), then replace: true", async () => {
  const f = claimService([409, { error: "bound-to-other-device" }], [200, { token: token() }]);
  assert.equal(await submitCode(ctx(undefined), CODE, ui(["", null]), f), true);
  assert.equal(prompts[0], MOVE_QUESTION);
  assert.equal(MOVE_QUESTION, "Renew on this browser? This can be moved once every 180 days.");
  assert.deepEqual(claims.map((b) => b["replace"]), [false, true]);
  assert.equal(store[HOUSEHOLD_ROLE_KEY], "guardian");
  // Declined: nothing created, the code and secret kept for the next try.
  store = {};
  claims = [];
  assert.equal(await submitCode(ctx(undefined), CODE, ui([null]), claimService([409, { error: "bound-to-other-device" }])), false);
  assert.equal(claims.length, 1);
  assert.equal(store[HOUSEHOLD_SECRET_KEY], undefined);
  assert.equal(store[SUBSCRIPTION_CODE_KEY], CODE);
});

test("create with an Institutions code: its text, code and secret deleted, nothing created", async () => {
  assert.equal(await submitCode(ctx(undefined), CODE, ui([]), claimService([200, { token: token("inst-starter") }])), false);
  assert.deepEqual(errors, ["This is a code for Sitr for Institutions."]);
  assert.deepEqual([store[SUBSCRIPTION_CODE_KEY], store[CLAIM_SECRET_KEY], store[HOUSEHOLD_SECRET_KEY]], [undefined, undefined, undefined]);
});

test("create: a refusal or no answer creates nothing and says why", async () => {
  await submitCode(ctx(undefined), CODE, ui([]), claimService([403, { error: "replacement-used", retry_after: T + 30 * DAY }]));
  await submitCode(ctx(undefined), CODE, ui([]), claimService([503, {}]));
  assert.deepEqual(errors, [
    "The renewing device was moved recently. It can be moved again on 20 December 2026.",
    "The subscription service could not be reached. Nothing was set up; try again in a moment.",
  ]);
  assert.equal(store[HOUSEHOLD_SECRET_KEY], undefined);
});

test("create with a code: refused under a managed lock; the claim host is asked for with the sync host", async () => {
  assert.equal(await submitCode(ctx(undefined, locked), CODE, ui([]), claimService()), false);
  assert.deepEqual([errors, claims], [[REFUSED_LOCK], []]);
  assert.deepEqual(requested, [["https://sync.sitrshield.com/*", "https://claim.sitrshield.com/*"]]);
});

test("a version 1 token creates as before: no claim, no claim host, not gated", async () => {
  const v1 = "sitr-ent-v1.abc.def";
  assert.equal(await submitCode(ctx(undefined, locked), v1, ui([null]), claimService()), true);
  assert.deepEqual([requested, claims, errors], [[["https://sync.sitrshield.com/*"]], [], []]);
  assert.equal(store["entitlementToken"], v1);
  assert.equal(store[HOUSEHOLD_ROLE_KEY], "guardian");
});

/* ---------------------------------- leaving -------------------------------- */

test("leaving removes the code, the claim secret, the claim state and the end date", async () => {
  const c = ctx("guardian");
  await wireFullChannelHooks(c);
  holding();
  store[HOUSEHOLD_END_KEY] = { entExp: T, lapsed: false, testHousehold: false };
  store[HOUSEHOLD_STATE_KEY] = c.state;
  store["entitlementToken"] = "kept";
  assert.equal(await c.family!.confirmLeave(ui([null])), false);
  assert.deepEqual(prompts, [LEAVE_QUESTION]);
  await leaveHousehold(c, { fetch: claimService(), now: () => T });
  for (const k of [SUBSCRIPTION_CODE_KEY, CLAIM_SECRET_KEY, CLAIM_STATE_KEY, HOUSEHOLD_END_KEY, HOUSEHOLD_STATE_KEY]) {
    assert.equal(store[k], undefined, k);
  }
  assert.equal(store["entitlementToken"], "kept");
  // Without the full channel (the Mac App Store build) the end date still goes.
  store[HOUSEHOLD_END_KEY] = { entExp: T, lapsed: false, testHousehold: false };
  await leaveHousehold(ctx("guardian"), { fetch: claimService(), now: () => T });
  assert.equal(store[HOUSEHOLD_END_KEY], undefined);
});

test("a child join drops a code kept from a creation that did not happen", async () => {
  const c = ctx(undefined);
  await wireFullChannelHooks(c);
  holding();
  const pairing = encodePairingCode(generateRootSecret());
  assert.equal(await joinHousehold(c, pairing, "child", ui([])), true);
  for (const k of [SUBSCRIPTION_CODE_KEY, CLAIM_SECRET_KEY, CLAIM_STATE_KEY]) assert.equal(store[k], undefined, k);
});

test("no code on this browser: leaving asks nothing extra", async () => {
  const c = ctx("guardian");
  await wireFullChannelHooks(c);
  assert.equal(await c.family!.confirmLeave(ui([])), true);
  assert.deepEqual(prompts, []);
});

/** wireFullChannel with a stand-in page: just enough elements. */
async function wireFullChannelHooks(c: HouseholdContext): Promise<void> {
  const fake = () => ({ hidden: false, textContent: "", value: "", addEventListener: () => {} });
  const els = new Map<string, unknown>();
  (globalThis as Record<string, unknown>)["document"] = {
    getElementById: (id: string) => (els.has(id) ? els.get(id) : (els.set(id, fake()), els.get(id))),
  };
  await wireFullChannel(c);
}

/* ---------------------------------- texts ---------------------------------- */

const st = (o: Partial<ClaimState>): ClaimState => ({ ...emptyClaimState(), ...o });
const far = T + 20 * DAY;

test("texts: covered, the window notice, lapsed", () => {
  assert.deepEqual(familyLines(st({ entExp: far }), T, true, true), ["Covered until 10 December 2026."]);
  assert.deepEqual(familyLines(st({ entExp: T + DAY }), T, true, true), [WAITING_TEXT]);
  assert.deepEqual(familyLines(st({ entExp: T - DAY }), T, false, true), [WAITING_TEXT]);
  assert.deepEqual(familyLines(st({ entExp: far, lapsed: true }), T, false, true), [WAITING_TEXT]);
  assert.deepEqual(familyLines(st({}), T, true, true), [], "a version 1 household: nothing");
});

test("texts: bound elsewhere, and replacement-used with its date", () => {
  assert.deepEqual(familyLines(st({ entExp: far, lastRefusal: "bound-to-other-device" }), T, true, true), [
    "Covered until 10 December 2026.",
    "Another device renews this subscription.",
  ]);
  const used = st({ entExp: far, lastRefusal: "replacement-used", retryAfter: T + 40 * DAY });
  assert.deepEqual(familyLines(used, T, true, true), [
    "Covered until 10 December 2026.",
    "The renewing device was moved recently. It can be moved again on 30 December 2026.",
  ]);
  assert.deepEqual(familyLines({ ...used, entExp: T + DAY }, T, true, true), [
    "The renewing device was moved recently. It can be moved again on 30 December 2026.",
  ]);
});

test("texts: payment pending and inactive, before and inside the window", () => {
  assert.deepEqual(familyLines(st({ entExp: far, lastRefusal: "payment-pending" }), T, true, true), [
    "Covered until 10 December 2026.",
    TEXTS["payment-pending"],
  ]);
  assert.deepEqual(familyLines(st({ entExp: T + DAY, lastRefusal: "payment-pending" }), T, true, true), [TEXTS["payment-problem"]]);
  assert.deepEqual(familyLines(st({ entExp: far, lastRefusal: "inactive" }), T, true, true), [
    "Covered until 10 December 2026.",
    TEXTS.inactive,
  ]);
  assert.deepEqual(familyLines(st({ entExp: T - DAY, lastRefusal: "inactive" }), T, true, true), [TEXTS.ended]);
});

test("texts: a legacy household on a device with no code; no claim permission", () => {
  assert.deepEqual(familyLines(st({ entExp: T + 60 * DAY }), T, false, true), [
    "Enter your subscription code on one guardian device before 19 January 2027.",
  ]);
  assert.deepEqual(familyLines(st({ entExp: far }), T, true, false), ["Covered until 10 December 2026.", NEEDS_CLAIM_ACCESS]);
});

test("member texts (every build): the date, the neutral sentence, nothing for version 1", () => {
  const end = (entExp: number | null, lapsed = false) => ({ entExp, lapsed, testHousehold: false });
  assert.equal(endLine(end(far), T), "Covered until 10 December 2026.");
  assert.equal(endLine(end(T + DAY), T), WAITING_TEXT);
  assert.equal(endLine(end(far, true), T), WAITING_TEXT);
  assert.equal(endLine(end(null), T), "");
});
