import assert from "node:assert/strict";
import { test } from "node:test";

import { coalesced, syncOnce } from "../../extension/dist/lib/sync/client.js";
import { deriveKeys, generateRootSecret, openState } from "../../extension/dist/lib/sync/crypto.js";
import {
  bumpRev,
  emptyHouseholdState,
  type HouseholdState,
} from "../../extension/dist/lib/household.js";
import { SyncStore } from "../../server/sync/dist/store.js";
import { SyncHandler } from "../../server/sync/dist/http.js";
import { configFromEnv } from "../../server/sync/dist/config.js";

const BASE = "https://sync.test";

/** fetch into the real server handler; `gate` lets a test hold a request in flight. */
function makeServer(gate: { wait?: Promise<void> } = {}) {
  const store = new SyncStore(":memory:");
  const handler = new SyncHandler(store, configFromEnv({}), () => 1_000_000);
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (gate.wait !== undefined) await gate.wait;
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
  return { fetch: f };
}

test("a change saved while a sync is in flight reaches the server (one follow-up)", async () => {
  const secret = generateRootSecret();
  let release!: () => void;
  const gate: { wait?: Promise<void> } = { wait: new Promise((r) => (release = r)) };
  const server = makeServer(gate);
  const deps = { fetch: server.fetch, now: () => 2000, baseUrl: BASE };

  // "storage": what the service worker reads at the start of each run.
  let local: HouseholdState = emptyHouseholdState("device-a", 1000);
  let maxSeenRev = 0;
  let runs = 0;
  const trigger = coalesced(async () => {
    runs++;
    const out = await syncOnce({ rootSecret: secret, local, maxSeenRev, deviceId: "device-a" }, deps);
    assert.equal(out.status.state, "ok");
    maxSeenRev = out.maxSeenRev;
  });

  const first = trigger(); // household created → first sync, held in flight
  await new Promise((r) => setImmediate(r));
  // The PIN (then a block rule) is saved during that sync, as in the create flow.
  local = bumpRev({ ...local, pin: { v: 1, algo: "PBKDF2-SHA256", iterations: 1, saltB64: "AA==", hashB64: "AA==" } }, "device-a", 1500);
  const second = trigger();
  local = bumpRev({ ...local, blockDomains: ["blocked.example"] }, "device-a", 1600);
  const third = trigger();
  release();
  gate.wait = undefined;
  await Promise.all([first, second, third]);

  assert.equal(runs, 2, "two changes during one sync → exactly one follow-up run");
  // A second client reads the server copy.
  const keys = await deriveKeys(secret);
  assert.ok(keys.ok);
  const res = await server.fetch(`${BASE}/v1/blob/${keys.value.householdId}`, {
    headers: { Authorization: `Bearer ${keys.value.authToken}` },
  });
  const opened = await openState(new Uint8Array(await res.arrayBuffer()), keys.value.encKey);
  assert.ok(opened.ok);
  assert.notEqual(opened.value.pin, undefined, "PIN reached the server");
  assert.deepEqual(opened.value.blockDomains, ["blocked.example"]);
});

test("a failing run is not retried in a loop; the next trigger runs again", async () => {
  let runs = 0;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const trigger = coalesced(async () => {
    runs++;
    if (runs === 1) await held;
    throw new Error("offline");
  });
  const first = trigger();
  await new Promise((r) => setImmediate(r));
  const second = trigger();
  release();
  await assert.rejects(first);
  await second;
  assert.equal(runs, 1, "a run that throws ends the round; nothing loops");
  await assert.rejects(trigger());
  assert.equal(runs, 2, "the next trigger (e.g. the alarm) runs normally");
});
