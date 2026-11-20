import assert from "node:assert/strict";
import { test } from "node:test";

import { coalesced, syncOnce } from "../../extension/dist/lib/sync/client.js";
import { applySyncOutcome } from "../../extension/dist/lib/sync/apply.js";
import { generateRootSecret } from "../../extension/dist/lib/sync/crypto.js";
import {
  bumpRev,
  emptyHouseholdState,
  sanitizeHouseholdState,
} from "../../extension/dist/lib/household.js";
import { SyncStore } from "../../server/sync/dist/store.js";
import { SyncHandler } from "../../server/sync/dist/http.js";
import { configFromEnv } from "../../server/sync/dist/config.js";

const BASE = "https://sync.test";

function makeFetch(): typeof fetch {
  const store = new SyncStore(":memory:");
  const handler = new SyncHandler(store, configFromEnv({}), () => 1_000_000);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
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
}

test("an unchanged sync round writes nothing, so it cannot loop even if every write fires onChanged", async () => {
  const secret = generateRootSecret();
  const deps = { fetch: makeFetch(), now: () => 2000, baseUrl: BASE };
  // Worst-case storage: onChanged fires on EVERY set, even an unchanged value
  // (unverified on Safari and Firefox), and queues a round as the worker does.
  let stored: unknown = emptyHouseholdState("device-a", 1000);
  let maxSeenRev = 0;
  let runs = 0;
  const queued: Promise<void>[] = [];
  const set = (state: unknown) => {
    stored = state;
    queued.push(trigger());
  };
  const trigger = coalesced(async () => {
    runs++;
    if (runs > 10) return; // without the fix this would never end
    const local = sanitizeHouseholdState(stored); // the worker sanitizes on read
    assert.ok(local.ok);
    const out = await syncOnce({ rootSecret: secret, local: local.value, maxSeenRev, deviceId: "device-a" }, deps);
    assert.equal(out.status.state, "ok");
    maxSeenRev = out.maxSeenRev;
    const engine = {
      getDynamicRules: async () => [],
      updateDynamicRules: async () => {},
      updateEnabledRulesets: async () => {},
      persist: async (state: unknown) => set(state),
    };
    assert.ok((await applySyncOutcome(out, local.value, [], engine)).ok); // service-worker.ts syncRound
  });
  const settle = () => Promise.all(queued);

  await trigger(); // first sync: creates the server copy
  await settle();
  // A user's change saved after it still goes out (one round).
  const edited = sanitizeHouseholdState(stored);
  assert.ok(edited.ok);
  set(bumpRev({ ...edited.value, blockDomains: ["blocked.example"] }, "device-a", 1500));
  await settle();
  await trigger(); // the alarm: local and server now tie
  await settle();

  assert.equal(runs, 3, "first sync + the edit's round + the alarm's round, no follow-ups");
});

test("a tie round re-asserts the household's rules from the stored state and writes nothing", async () => {
  const secret = generateRootSecret();
  const deps = { fetch: makeFetch(), now: () => 2000, baseUrl: BASE };
  const stored = sanitizeHouseholdState({ ...emptyHouseholdState("device-a", 1000), blockDomains: ["blocked.example"] });
  assert.ok(stored.ok);
  const input = { rootSecret: secret, local: stored.value, maxSeenRev: 0, deviceId: "device-a" };
  const first = await syncOnce(input, deps); // creates the server copy
  const tie = await syncOnce({ ...input, maxSeenRev: first.maxSeenRev }, deps);
  assert.equal(tie.state, stored.value, "a tie hands back the stored object");

  // As service-worker.ts syncRound does on every ok round.
  const calls: string[] = [];
  const engine = {
    getDynamicRules: async () => (calls.push("get"), []), // the household rules were lost
    updateDynamicRules: async (u: { addRules?: unknown[] }) => void calls.push(`add:${u.addRules?.length ?? 0}`),
    updateEnabledRulesets: async () => void calls.push("rulesets"),
    persist: async () => void calls.push("persist"),
  };
  const r = await applySyncOutcome(tie, stored.value, [], engine);
  assert.ok(r.ok);
  assert.deepEqual(calls, ["get", "add:1", "rulesets"], "rules re-asserted, nothing written to storage");

  // A changed state is still persisted.
  calls.length = 0;
  const changed = await applySyncOutcome({ ...tie, state: { ...tie.state } }, stored.value, [], engine);
  assert.ok(changed.ok);
  assert.equal(calls.at(-1), "persist");
});
