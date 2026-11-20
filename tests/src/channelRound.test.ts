/**
 * The full channel's background round (background/fullChannel.ts) and the
 * worker's storage listener: a page-side write of the code or the claim
 * state starts exactly one round, a round's own writes start none, a claim
 * state written during a round is not overwritten, and a code of another
 * plan leaves the marker the options page reads. The worst-case storage
 * here fires onChanged on every set, as syncNoLoop.test.ts assumes.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { coalesced } from "../../extension/dist/lib/sync/client.js";
import { generateRootSecret } from "../../extension/dist/lib/sync/crypto.js";
import { emptyHouseholdState, HOUSEHOLD_STATE_KEY } from "../../extension/dist/lib/household.js";
import { emptyClaimState, sanitizeClaimState } from "../../extension/dist/lib/entitlement.js";
import {
  CLAIM_STATE_KEY,
  OTHER_PLAN_KEY,
  SUBSCRIPTION_CODE_KEY,
  channelRound,
  startsRound,
} from "../../extension/dist/background/fullChannel.js";
import { startsRound as memberStartsRound } from "../../extension/dist/background/memberChannel.js";
import { SyncStore } from "../../server/sync/dist/store.js";
import { SyncHandler } from "../../server/sync/dist/http.js";
import { configFromEnv } from "../../server/sync/dist/config.js";

const BASE = "https://sync.test";
const CODE = "6f1c2a3b-1d2e-4f50-8a9b-0c1d2e3f4a5b";
let store: Record<string, unknown>;
let permitted: boolean;
let rounds: number;
let queued: Promise<void>[];
/** Runs inside the next request, once (a page write during a round). */
let midRound: (() => void) | undefined;

const set = (items: Record<string, unknown>) => {
  const changes = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { oldValue: store[k], newValue: v }]));
  Object.assign(store, items);
  // The worker's listener (service-worker.ts), on every set.
  if (HOUSEHOLD_STATE_KEY in changes || startsRound(changes)) queued.push(trigger());
};
(globalThis as Record<string, unknown>)["chrome"] = {
  storage: {
    local: {
      get: async (keys: string | string[]) =>
        Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]])),
      set: async (items: Record<string, unknown>) => set(items),
      remove: async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
      },
    },
  },
  permissions: { contains: async () => permitted },
};

const local = (globalThis as unknown as { chrome: { storage: { local: { set(i: Record<string, unknown>): Promise<void> } } } })
  .chrome.storage.local;

function makeFetch(): typeof fetch {
  const handler = new SyncHandler(new SyncStore(":memory:"), configFromEnv({}), () => 1_000_000);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const hook = midRound;
    midRound = undefined;
    hook?.();
    if (url.host === "claim.sitrshield.com") {
      const payload = Buffer.from(JSON.stringify({ v: 2, plan: "inst-starter", term: "year", per: 0, exp: 9e15 })).toString("base64url");
      return Response.json({ token: `sitr-ent-v2.${payload}.sig` });
    }
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
    return new Response(res.body.length > 0 ? (res.body as unknown as BodyInit) : null, { status: res.status, headers: res.headers });
  }) as typeof fetch;
}

const secret = generateRootSecret();
let deps: { fetch: typeof fetch; now: () => number; baseUrl: string };
const trigger = coalesced(async () => {
  rounds++;
  if (rounds > 10) return; // a loop would never end
  await channelRound(
    { rootSecret: secret, local: emptyHouseholdState("dev-a", 1000), maxSeenRev: 0, deviceId: "dev-a" },
    deps,
    async () => true,
  );
});
const settle = async () => {
  while (queued.length > 0) await queued.shift();
};

beforeEach(() => {
  store = {};
  permitted = false;
  rounds = 0;
  queued = [];
  midRound = undefined;
  deps = { fetch: makeFetch(), now: () => 2000, baseUrl: BASE };
});

test("a page-side claim state write starts exactly one round; the round's own write starts none", async () => {
  await trigger(); // the first round: creates the server copy
  await settle();
  rounds = 0;
  // The page writes (e.g. Try again); the round then changes it again
  // (a version 1 household: entExp back to null) and writes that.
  await local.set({ [CLAIM_STATE_KEY]: { ...emptyClaimState(), entExp: 5000 } });
  await settle();
  assert.equal(rounds, 1);
  assert.equal(sanitizeClaimState(store[CLAIM_STATE_KEY]).entExp, null, "the round wrote its own state");
});

test("entering a code starts one round; the worker removing a code starts none", async () => {
  await local.set({ [SUBSCRIPTION_CODE_KEY]: CODE });
  await settle();
  assert.equal(rounds, 1);
  assert.equal(startsRound({ [SUBSCRIPTION_CODE_KEY]: { newValue: undefined } }), false);
  assert.equal(memberStartsRound({ [SUBSCRIPTION_CODE_KEY]: { newValue: CODE } }), false, "the member build never");
});

test("Renew on this browser during a round: the round's claim state is dropped and one more round runs from the page's", async () => {
  await trigger();
  await settle();
  rounds = 0;
  const pages = { ...emptyClaimState(), lastRefusal: "payment-pending" as const, notBefore: 9e15 };
  midRound = () => void local.set({ [CLAIM_STATE_KEY]: pages });
  await trigger();
  await settle();
  assert.equal(rounds, 2);
  const s = sanitizeClaimState(store[CLAIM_STATE_KEY]);
  assert.deepEqual([s.lastRefusal, s.notBefore], ["payment-pending", 9e15], "built on the page's write, never the stale one");
});

test("a code of another plan met by a round: code and secret gone, the marker left, no further round", async () => {
  permitted = true;
  store[SUBSCRIPTION_CODE_KEY] = CODE;
  store["claimSecret"] = "s".repeat(43);
  await trigger();
  await settle();
  assert.equal(rounds, 1);
  assert.equal(store[SUBSCRIPTION_CODE_KEY], undefined);
  assert.equal(store["claimSecret"], undefined);
  assert.equal(store[OTHER_PLAN_KEY], true);
});
