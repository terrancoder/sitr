/**
 * Leaving a household frees this device's place on the sync server:
 * unenroll (lib/sync/client.ts), mirroring iOS UnenrollTests, against the
 * real sync server handler in memory. Then the options page's leave and a
 * worker round that is on the network while the user leaves.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { coalesced, syncOnce, unenroll } from "../../extension/dist/lib/sync/client.js";
import { applySyncOutcome } from "../../extension/dist/lib/sync/apply.js";
import { deriveKeys, generateRootSecret, openState } from "../../extension/dist/lib/sync/crypto.js";
import {
  DEVICE_ID_KEY,
  HOUSEHOLD_ROLE_KEY,
  HOUSEHOLD_SECRET_KEY,
  HOUSEHOLD_STATE_KEY,
  emptyHouseholdState,
  sanitizeHouseholdState,
  type HouseholdState,
} from "../../extension/dist/lib/household.js";
import { DISABLED_CATEGORIES_KEY } from "../../extension/dist/lib/categories.js";
import { EMPTY_MANAGED_POLICY } from "../../extension/dist/lib/managed.js";
import { toB64 } from "../../extension/dist/lib/pin.js";
import { leaveHousehold, type HouseholdContext } from "../../extension/dist/options/household.js";
import { SyncStore } from "../../server/sync/dist/store.js";
import { SyncHandler } from "../../server/sync/dist/http.js";
import { configFromEnv } from "../../server/sync/dist/config.js";

const BASE = "https://sync.test";
const NOW = 1_700_000_000_000;

interface Call {
  method: string;
  headers: Headers;
}

/**
 * One in-memory server. `client()` gives a recording fetch into it; `before`
 * runs before each request of that client (n = its index), so a test can
 * slip another device's write in between.
 */
function makeServer() {
  const handler = new SyncHandler(new SyncStore(":memory:"), configFromEnv({}), () => 1_000_000);
  const client = (before: (n: number) => Promise<void> | void = () => {}) => {
    const calls: Call[] = [];
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      assert.equal(url.origin, BASE, "never the live server");
      await before(calls.length);
      const headers = new Headers(init?.headers);
      calls.push({ method: init?.method ?? "GET", headers });
      const res = handler.handle({
        method: init?.method ?? "GET",
        path: url.pathname,
        ip: "192.0.2.1",
        headers: {
          authorization: headers.get("authorization") ?? undefined,
          "if-match": headers.get("if-match") ?? undefined,
          "if-none-match": headers.get("if-none-match") ?? undefined,
          "x-sitr-entitlement": undefined, // recorded above; not verified here
        },
        body:
          init?.body === undefined
            ? new Uint8Array(0)
            : new Uint8Array(init.body as ArrayBufferLike & Uint8Array),
      });
      return new Response(res.body.length > 0 ? (res.body as unknown as BodyInit) : null, {
        status: res.status,
        headers: res.headers,
      });
    }) as typeof fetch;
    return { fetch: f, calls, methods: () => calls.map((c) => c.method) };
  };
  return { client };
}

type Server = ReturnType<typeof makeServer>;

function state(rev: number, devices: string[], by = "device-a"): HouseholdState {
  const s = sanitizeHouseholdState({ ...emptyHouseholdState(by, 0), rev, updatedAt: rev * 1000, devices });
  assert.ok(s.ok);
  return s.value;
}

/** Another device writes `s` (a newer rev) to the server. */
async function write(server: Server, secret: Uint8Array, s: HouseholdState, maxSeenRev = 0) {
  const out = await syncOnce(
    { rootSecret: secret, local: s, maxSeenRev, deviceId: s.updatedBy },
    { fetch: server.client().fetch, now: () => 1000, baseUrl: BASE },
  );
  assert.equal(out.status.state, "ok");
}

/** The server's copy, decrypted; undefined when it has none. */
async function onServer(server: Server, secret: Uint8Array): Promise<HouseholdState | undefined> {
  const keys = await deriveKeys(secret);
  assert.ok(keys.ok);
  const res = await server.client().fetch(`${BASE}/v1/blob/${keys.value.householdId}`, {
    headers: { Authorization: `Bearer ${keys.value.authToken}` },
  });
  if (res.status === 404) return undefined;
  const opened = await openState(new Uint8Array(await res.arrayBuffer()), keys.value.encKey);
  assert.ok(opened.ok);
  return opened.value;
}

function leave(f: typeof fetch, secret: Uint8Array, local: HouseholdState, maxSeenRev: number, entitlement?: string) {
  return unenroll(
    { rootSecret: secret, local, maxSeenRev, deviceId: "me", entitlement },
    { fetch: f, now: () => NOW, baseUrl: BASE },
  );
}

test("unenroll pushes the latest state without this device, with the entitlement token", async () => {
  const secret = generateRootSecret();
  const server = makeServer();
  const remote = state(5, ["device-a", "me"]);
  await write(server, secret, remote);
  const c = server.client();

  const outcome = await leave(c.fetch, secret, remote, 5, "token-1");

  assert.equal(outcome.status.state, "ok");
  assert.deepEqual(outcome.state.devices, ["device-a"]);
  assert.deepEqual(c.methods(), ["GET", "GET", "PUT"]);
  const put = c.calls[2]!.headers;
  assert.match(put.get("if-match") ?? "", /^"\d+"$/);
  assert.equal(put.get("x-sitr-entitlement"), "token-1");
  const after = await onServer(server, secret);
  assert.deepEqual(after?.devices, ["device-a"]);
  assert.equal(after?.rev, 6);
  assert.equal(after?.updatedBy, "me");
});

test("the last device leaves an empty list and never deletes", async () => {
  const secret = generateRootSecret();
  const server = makeServer();
  const remote = state(3, ["me"]);
  await write(server, secret, remote);
  const c = server.client();

  const outcome = await leave(c.fetch, secret, remote, 3);

  assert.equal(outcome.status.state, "ok");
  assert.ok(!c.methods().includes("DELETE"));
  assert.deepEqual((await onServer(server, secret))?.devices, []);
});

test("offline leaves the place taken", async () => {
  let calls = 0;
  const offline = (async () => {
    calls++;
    throw new TypeError("network down");
  }) as typeof fetch;
  const outcome = await leave(offline, generateRootSecret(), state(5, ["device-a", "me"]), 5);
  assert.equal(outcome.status.state, "offline");
  assert.equal(calls, 1);
});

test("leaving a join placeholder sends nothing to the server", async () => {
  const secret = generateRootSecret();
  const server = makeServer();
  const c = server.client();
  await leave(c.fetch, secret, emptyHouseholdState("me", 0), 0);
  assert.deepEqual(c.calls, []);
  assert.equal(await onServer(server, secret), undefined);
});

test("not listed pushes nothing", async () => {
  const secret = generateRootSecret();
  const server = makeServer();
  const remote = state(5, ["device-a"]);
  await write(server, secret, remote);
  const c = server.client();

  const outcome = await leave(c.fetch, secret, remote, 5);
  assert.equal(outcome.status.state, "ok");
  assert.deepEqual(c.methods(), ["GET"]);
});

test("a conflict on the removal retries once; the newer leave state wins", async () => {
  const secret = generateRootSecret();
  const server = makeServer();
  const remote = state(5, ["device-a", "me"]);
  await write(server, secret, remote);
  // device-c enrols just before the removal PUT lands.
  const c = server.client(async (n) => {
    if (n === 2) await write(server, secret, state(6, ["device-a", "device-c", "me"], "device-c"), 5);
  });

  const outcome = await leave(c.fetch, secret, remote, 5);

  assert.equal(outcome.status.state, "ok");
  assert.deepEqual(c.methods(), ["GET", "GET", "PUT", "GET", "PUT"]);
  const after = await onServer(server, secret);
  assert.deepEqual(after?.devices, ["device-a"]); // device-c re-enrols on its own next sync
  assert.equal(after?.updatedBy, "me");
});

test("a second pass when a concurrent write put the device back", async () => {
  const secret = generateRootSecret();
  const server = makeServer();
  const remote = state(5, ["device-a", "me"]);
  await write(server, secret, remote);
  const c = server.client(async (n) => {
    if (n === 1) await write(server, secret, state(9, ["device-a", "me"], "device-b"), 5);
  });

  const outcome = await leave(c.fetch, secret, remote, 5);

  assert.equal(outcome.status.state, "ok");
  assert.deepEqual(c.methods(), ["GET", "GET", "GET", "PUT"]);
  const after = await onServer(server, secret);
  assert.deepEqual(after?.devices, ["device-a"]);
  assert.equal(after?.rev, 10);
});

/* ------------------- the options page and the worker round ------------------ */

let store: Record<string, unknown>;
let stateWrites: number;
let enabledUpdates: Array<{ enableRulesetIds?: string[]; disableRulesetIds?: string[] }>;

(globalThis as Record<string, unknown>)["chrome"] = {
  storage: {
    local: {
      get: async (keys: string | string[]) =>
        Object.fromEntries(
          (Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]]),
        ),
      set: async (items: Record<string, unknown>) => {
        if (HOUSEHOLD_STATE_KEY in items) stateWrites++;
        Object.assign(store, items);
      },
      remove: async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
      },
    },
  },
  declarativeNetRequest: {
    getDynamicRules: async () => [],
    updateDynamicRules: async () => {},
    updateEnabledRulesets: async (u: { enableRulesetIds?: string[]; disableRulesetIds?: string[] }) =>
      void enabledUpdates.push(u),
  },
};

function ctx(): HouseholdContext {
  return {
    role: "guardian",
    state: undefined,
    managed: EMPTY_MANAGED_POLICY,
    showError: (m) => assert.fail(m),
    onChanged: async () => {},
  };
}

/** A household joined and synced on this browser: as the worker leaves storage. */
function joined(secret: Uint8Array, s: HouseholdState, maxSeenRev: number) {
  store[HOUSEHOLD_SECRET_KEY] = toB64(secret);
  store[HOUSEHOLD_ROLE_KEY] = "guardian";
  store[HOUSEHOLD_STATE_KEY] = s;
  store[DEVICE_ID_KEY] = "me";
  store["syncMaxSeenRev"] = maxSeenRev;
}

beforeEach(() => {
  store = {};
  stateWrites = 0;
  enabledUpdates = [];
});

test("leaving from the options page takes this device off the list, writes no household state, keeps device-disabled categories off", async () => {
  const secret = generateRootSecret();
  const server = makeServer();
  const remote = state(5, ["device-a", "me"]);
  await write(server, secret, remote);
  joined(secret, remote, 5);
  store["entitlementToken"] = "token-2";
  store[DISABLED_CATEGORIES_KEY] = ["sitr_gambling"];
  store["syncStatus"] = { state: "not-found" }; // must not show under the next join
  const c = server.client();

  await leaveHousehold(ctx(), { fetch: c.fetch, now: () => NOW, baseUrl: BASE });

  assert.deepEqual((await onServer(server, secret))?.devices, ["device-a"]);
  assert.equal(c.calls.at(-1)?.headers.get("x-sitr-entitlement"), "token-2");
  for (const k of [HOUSEHOLD_SECRET_KEY, HOUSEHOLD_ROLE_KEY, HOUSEHOLD_STATE_KEY, "syncStatus"]) {
    assert.ok(!(k in store), k);
  }
  // A cleared state persisted while the secret is still stored would start a round.
  assert.equal(stateWrites, 0);
  assert.ok(enabledUpdates.at(-1)?.disableRulesetIds?.includes("sitr_gambling"));
});

test("leaving offline still leaves", async () => {
  const secret = generateRootSecret();
  joined(secret, state(5, ["device-a", "me"]), 5);
  const offline = (async () => {
    throw new TypeError("network down");
  }) as typeof fetch;

  await leaveHousehold(ctx(), { fetch: offline, now: () => NOW, baseUrl: BASE });
  assert.ok(!(HOUSEHOLD_SECRET_KEY in store));
  assert.ok(!(HOUSEHOLD_STATE_KEY in store));
});

test("a worker round in flight during the leave neither re-enrols the device nor brings the household back", async () => {
  const secret = generateRootSecret();
  const server = makeServer();
  const remote = state(5, ["device-a", "me"]);
  await write(server, secret, remote);
  joined(secret, remote, 5);

  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const worker = server.client(() => gate);
  const engineCalls: string[] = [];
  let runs = 0;
  // service-worker.ts syncRound, as far as it touches storage and the server.
  const round = coalesced(async () => {
    runs++;
    const started = store[HOUSEHOLD_SECRET_KEY];
    if (typeof started !== "string") return; // no household
    const local = sanitizeHouseholdState(store[HOUSEHOLD_STATE_KEY]);
    assert.ok(local.ok);
    const outcome = await syncOnce(
      { rootSecret: secret, local: local.value, maxSeenRev: store["syncMaxSeenRev"] as number, deviceId: "me" },
      { fetch: worker.fetch, now: () => NOW, baseUrl: BASE },
    );
    const householdKept = async () => store[HOUSEHOLD_SECRET_KEY] === started;
    const applied = await applySyncOutcome(outcome, local.value, [], {
      getDynamicRules: async () => (engineCalls.push("get"), []),
      updateDynamicRules: async () => void engineCalls.push("rules"),
      updateEnabledRulesets: async () => void engineCalls.push("rulesets"),
      persist: async (s) => {
        store[HOUSEHOLD_STATE_KEY] = s;
      },
      householdKept,
    });
    assert.ok(applied.ok);
    if (!applied.value) return;
    if (outcome.status.state === "ok" && !outcome.state.devices.includes("me") && (await householdKept())) {
      store[HOUSEHOLD_STATE_KEY] = { ...outcome.state, devices: [...outcome.state.devices, "me"].sort() };
    }
  });

  const inFlight = round(); // held on its GET
  await leaveHousehold(ctx(), { fetch: server.client().fetch, now: () => NOW, baseUrl: BASE });
  void round(); // storage.onChanged from the leave: folded into one follow-up
  release();
  await inFlight;

  assert.equal(runs, 2, "the round and its follow-up");
  assert.deepEqual(worker.methods(), ["GET"], "the round pulled; the follow-up sent nothing");
  assert.deepEqual(engineCalls, [], "the round applied nothing");
  assert.ok(!(HOUSEHOLD_STATE_KEY in store), "the household did not come back");
  assert.deepEqual((await onServer(server, secret))?.devices, ["device-a"]);
});
