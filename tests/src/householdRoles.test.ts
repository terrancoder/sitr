/**
 * C1: a child device leaves only with the household's guardian PIN (the
 * pairing-code route is gone). C2: "Refresh device list" — guardians only,
 * gated like changing the PIN — leaves this device alone on the list, and
 * every device still using the household enrols again at its next sync.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  REFRESH_DEVICE_LIST_GATED_AS,
  gateMutation,
} from "../../extension/dist/lib/gate.js";
import { DELAY_MINUTES_KEY, decideMutation } from "../../extension/dist/lib/delay.js";
import { EMPTY_MANAGED_POLICY, sanitizeManagedPolicy } from "../../extension/dist/lib/managed.js";
import {
  DEVICE_ID_KEY,
  HOUSEHOLD_ROLE_KEY,
  HOUSEHOLD_SECRET_KEY,
  HOUSEHOLD_STATE_KEY,
  MAX_HOUSEHOLD_DEVICES,
  emptyHouseholdState,
  enrolDevice,
  refreshDevices,
  sanitizeHouseholdState,
  type HouseholdState,
} from "../../extension/dist/lib/household.js";
import { PIN_KEY, createPinRecord, toB64 } from "../../extension/dist/lib/pin.js";
import { syncOnce } from "../../extension/dist/lib/sync/client.js";
import { generateRootSecret } from "../../extension/dist/lib/sync/crypto.js";
import {
  LEAVE_NEEDS_PIN,
  WAITING_FOR_FIRST_SYNC,
  leaveHousehold,
  refreshDeviceList,
  withGate,
  type GateUi,
  type HouseholdContext,
} from "../../extension/dist/options/household.js";
import { SyncStore } from "../../server/sync/dist/store.js";
import { SyncHandler } from "../../server/sync/dist/http.js";
import { configFromEnv } from "../../server/sync/dist/config.js";

const LOCKED = sanitizeManagedPolicy({ lockOptions: true });
const ctxOf = (role: "guardian" | "child" | undefined, hasPin: boolean) => ({
  managed: EMPTY_MANAGED_POLICY,
  role,
  hasPin,
});

/* --------------------------------- gate ---------------------------------- */

test("C1 gate: a child leaves with the household PIN, is refused without one; a guardian is unchanged", () => {
  assert.deepEqual(gateMutation("leaveHousehold", ctxOf("child", true)), { allowed: true, requiresPin: true });
  assert.deepEqual(gateMutation("leaveHousehold", ctxOf("child", false)), { allowed: false, reason: "child-device" });
  assert.deepEqual(gateMutation("leaveHousehold", ctxOf("guardian", true)), { allowed: true, requiresPin: true });
  assert.deepEqual(gateMutation("leaveHousehold", ctxOf("guardian", false)), { allowed: true, requiresPin: false });
  assert.deepEqual(gateMutation("leaveHousehold", { ...ctxOf("child", true), managed: LOCKED }), {
    allowed: false,
    reason: "managed-locked",
  });
  // The wait before loosening still applies to a child's leave, before the PIN.
  assert.deepEqual(decideMutation("leaveHousehold", ctxOf("child", true), "idle"), { step: "wait" });
  assert.deepEqual(decideMutation("leaveHousehold", ctxOf("child", true), "open"), { step: "pin" });
  assert.deepEqual(decideMutation("leaveHousehold", ctxOf("child", false), "open"), {
    step: "refused",
    reason: "child-device",
  });
});

test("C3: every other loosening stays refused on a child device", () => {
  for (const kind of ["disableCategory", "removeDeviceBlockRule", "addDeviceAllowRule", "removeHouseholdRule",
    "loosenMediaMode", "addImageAllowRule", "addHouseholdRule", "changePin"] as const) {
    assert.deepEqual(gateMutation(kind, ctxOf("child", true)), { allowed: false, reason: "child-device" }, kind);
  }
});

test("C2 gate: refresh is gated like changing the PIN — child refused, guardian PIN when set, no wait", () => {
  assert.equal(REFRESH_DEVICE_LIST_GATED_AS, "changePin");
  const k = REFRESH_DEVICE_LIST_GATED_AS;
  assert.deepEqual(gateMutation(k, ctxOf("child", true)), { allowed: false, reason: "child-device" });
  assert.deepEqual(gateMutation(k, ctxOf("child", false)), { allowed: false, reason: "child-device" });
  assert.deepEqual(gateMutation(k, ctxOf("guardian", true)), { allowed: true, requiresPin: true });
  assert.deepEqual(gateMutation(k, ctxOf("guardian", false)), { allowed: true, requiresPin: false });
  assert.deepEqual(decideMutation(k, ctxOf("guardian", true), "idle"), { step: "pin" });
});

/* --------------------------- the options page ---------------------------- */

let store: Record<string, unknown>;
let prompts: string[];
let errors: string[];
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
  declarativeNetRequest: {
    getDynamicRules: async () => [],
    updateDynamicRules: async () => {},
    updateEnabledRulesets: async () => {},
  },
};

const ui = (answers: Array<string | null>): GateUi => ({
  prompt: async (message: string) => {
    prompts.push(message);
    return answers.shift() ?? null;
  },
  hold: async () => {},
});

function ctx(role: "guardian" | "child", state?: HouseholdState): HouseholdContext {
  return {
    role,
    state,
    managed: EMPTY_MANAGED_POLICY,
    showError: (m) => void errors.push(m),
    onChanged: async () => {},
  };
}

const offline = {
  fetch: (async () => {
    throw new TypeError("offline");
  }) as typeof fetch,
  now: () => 1,
  baseUrl: "https://sync.test",
};

const pin = await createPinRecord("1234");
assert.ok(pin.ok);

/** A child browser in a household (synced: not the join placeholder). */
function childIn(householdPin: boolean): HouseholdContext {
  const s = sanitizeHouseholdState({
    ...emptyHouseholdState("guardian-1", 1000),
    rev: 4,
    devices: ["guardian-1", "me"],
    ...(householdPin ? { pin: pin.ok ? pin.value : undefined } : {}),
  });
  assert.ok(s.ok);
  store[HOUSEHOLD_SECRET_KEY] = toB64(generateRootSecret());
  store[HOUSEHOLD_ROLE_KEY] = "child";
  store[HOUSEHOLD_STATE_KEY] = s.value;
  store[DEVICE_ID_KEY] = "me";
  return ctx("child", s.value);
}

const leave = (c: HouseholdContext, answers: Array<string | null>) =>
  withGate("leaveHousehold", c, () => leaveHousehold(c, offline), ui(answers));

beforeEach(() => {
  store = {};
  prompts = [];
  errors = [];
});

test("C1: a child leaves with the household PIN, as any device leaves", async () => {
  assert.equal(await leave(childIn(true), ["1234"]), true);
  assert.deepEqual(prompts, ["Enter the guardian PIN:"]);
  for (const k of [HOUSEHOLD_SECRET_KEY, HOUSEHOLD_ROLE_KEY, HOUSEHOLD_STATE_KEY]) assert.ok(!(k in store), k);
});

test("C1: a wrong PIN does not leave; the wait applies before the PIN", async () => {
  assert.equal(await leave(childIn(true), ["0000"]), false);
  assert.deepEqual(errors, ["Wrong PIN."]);
  assert.equal(store[HOUSEHOLD_ROLE_KEY], "child");

  errors = [];
  prompts = [];
  store[DELAY_MINUTES_KEY] = 5; // wait on, not requested: held
  assert.equal(await leave(childIn(true), ["1234"]), false);
  assert.deepEqual(prompts, []);
  assert.equal(store[HOUSEHOLD_ROLE_KEY], "child");
});

test("C1: no household PIN — refused with the text, even with this browser's own PIN", async () => {
  const c = childIn(false);
  store[PIN_KEY] = pin.ok ? pin.value : undefined; // kept from before joining
  assert.equal(await leave(c, ["1234"]), false);
  assert.deepEqual(errors, [LEAVE_NEEDS_PIN]);
  assert.equal(LEAVE_NEEDS_PIN, "Leaving needs the guardian PIN. Ask your guardian to set one in the household.");
  assert.deepEqual(prompts, []);
  assert.equal(store[HOUSEHOLD_ROLE_KEY], "child");
});

test("C2: refreshDevices keeps only this device as a new revision; nothing else changes", () => {
  const s = sanitizeHouseholdState({
    ...emptyHouseholdState("a", 1000),
    rev: 7,
    devices: ["a", "b", "gone"],
    blockDomains: ["x.example"],
  });
  assert.ok(s.ok);
  const r = refreshDevices(s.value, "a", 5000);
  assert.deepEqual(r, { ...s.value, devices: ["a"], rev: 8, updatedAt: 5000, updatedBy: "a" });
  // A browser that was not on the list puts itself on it.
  assert.deepEqual(refreshDevices(s.value, "new", 5000).devices, ["new"]);
});

test("C2: the options page refreshes a synced household; a join placeholder is refused", async () => {
  const s = sanitizeHouseholdState({ ...emptyHouseholdState("a", 1000), rev: 3, devices: ["a", "b", "gone"] });
  assert.ok(s.ok);
  store[DEVICE_ID_KEY] = "me";
  const c = ctx("guardian", s.value);
  await refreshDeviceList(c);
  assert.deepEqual(errors, []);
  assert.deepEqual(c.state?.devices, ["me"]);
  assert.equal(c.state?.rev, 4);
  assert.deepEqual((store[HOUSEHOLD_STATE_KEY] as HouseholdState).devices, ["me"]); // the worker syncs it

  const placeholder = emptyHouseholdState("me", 0);
  const p = ctx("guardian", placeholder);
  store = { [DEVICE_ID_KEY]: "me" };
  await refreshDeviceList(p);
  assert.deepEqual(errors, [WAITING_FOR_FIRST_SYNC]);
  assert.equal(p.state, placeholder);
  assert.ok(!(HOUSEHOLD_STATE_KEY in store));
});

test("enrolDevice: adds a missing device in order, leaves a listed one, refuses at the cap", () => {
  const s = sanitizeHouseholdState({ ...emptyHouseholdState("a", 1000), rev: 2, devices: ["a", "c"] });
  assert.ok(s.ok);
  const added = enrolDevice(s.value, "b", 9);
  assert.ok(added.ok);
  assert.deepEqual(added.value?.devices, ["a", "b", "c"]);
  assert.equal(added.value?.rev, 3);
  assert.deepEqual(enrolDevice(s.value, "a", 9), { ok: true, value: undefined });
  const full = { ...s.value, devices: Array.from({ length: MAX_HOUSEHOLD_DEVICES }, (_, i) => `d${i}`) };
  const refused = enrolDevice(full, "late", 9);
  assert.ok(!refused.ok);
  assert.match(refused.error, /20 devices .*refresh the device list from a guardian device/);
});

test("C2 end to end: after a refresh, a device still in use enrols again at its next sync; a gone one stays gone", async () => {
  const handler = new SyncHandler(new SyncStore(":memory:"), configFromEnv({}), () => 1_000_000);
  const fetchIt = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const res = handler.handle({
      method: init?.method ?? "GET",
      path: url.pathname,
      ip: "192.0.2.1",
      headers: {
        authorization: headers.get("authorization") ?? undefined,
        "if-match": headers.get("if-match") ?? undefined,
        "if-none-match": headers.get("if-none-match") ?? undefined,
        "x-sitr-entitlement": undefined,
      },
      body: init?.body === undefined ? new Uint8Array(0) : new Uint8Array(init.body as ArrayBufferLike & Uint8Array),
    });
    return new Response(res.body.length > 0 ? (res.body as unknown as BodyInit) : null, {
      status: res.status,
      headers: res.headers,
    });
  }) as typeof fetch;
  const secret = generateRootSecret();
  let clock = 10_000;
  const deps = { fetch: fetchIt, now: () => ++clock, baseUrl: "https://sync.test" };
  /** One worker round: sync, then the enrolment (service-worker.ts syncRound). */
  const round = async (device: string, local: HouseholdState, maxSeenRev: number) => {
    let out = await syncOnce({ rootSecret: secret, local, maxSeenRev, deviceId: device }, deps);
    assert.equal(out.status.state, "ok");
    const enrolled = enrolDevice(out.state, device, ++clock);
    assert.ok(enrolled.ok);
    if (enrolled.value !== undefined) {
      out = await syncOnce({ rootSecret: secret, local: enrolled.value, maxSeenRev: out.maxSeenRev, deviceId: device }, deps);
      assert.equal(out.status.state, "ok");
    }
    return out;
  };

  const start = sanitizeHouseholdState({ ...emptyHouseholdState("guardian", 1000), rev: 5, devices: ["child", "gone", "guardian"] });
  assert.ok(start.ok);
  const g0 = await round("guardian", start.value, 0);
  const c0 = await round("child", start.value, 0);
  assert.deepEqual(c0.state.devices, ["child", "gone", "guardian"]);

  // The guardian refreshes: the list is the guardian alone, synced.
  const g1 = await round("guardian", refreshDevices(g0.state, "guardian", ++clock), g0.maxSeenRev);
  assert.deepEqual(g1.state.devices, ["guardian"]);

  // The child's next round finds itself missing and adds itself again.
  const c1 = await round("child", c0.state, c0.maxSeenRev);
  assert.deepEqual(c1.state.devices, ["child", "guardian"]);
  // The guardian sees it; "gone" never syncs again and its place stays free.
  const g2 = await round("guardian", g1.state, g1.maxSeenRev);
  assert.deepEqual(g2.state.devices, ["child", "guardian"]);
});
