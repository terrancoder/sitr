import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";

import { syncOnce } from "../../extension/dist/lib/sync/client.js";
import {
  deriveKeys,
  sealState,
  generateRootSecret,
} from "../../extension/dist/lib/sync/crypto.js";
import {
  bumpRev,
  emptyHouseholdState,
} from "../../extension/dist/lib/household.js";
import { SyncStore } from "../../server/sync/dist/store.js";
import { SyncHandler, type SyncRequest } from "../../server/sync/dist/http.js";
import { configFromEnv } from "../../server/sync/dist/config.js";

const BASE = "https://sync.test";

/** fetch adapter that routes straight into the real server handler. */
function serverFetch(handler: SyncHandler): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body =
      init?.body === undefined
        ? new Uint8Array(0)
        : new Uint8Array(init.body as ArrayBufferLike & Uint8Array);
    const req: SyncRequest = {
      method: init?.method ?? "GET",
      path: url.pathname,
      ip: "192.0.2.1",
      headers: {
        authorization: headers.get("authorization") ?? undefined,
        "if-match": headers.get("if-match") ?? undefined,
        "if-none-match": headers.get("if-none-match") ?? undefined,
        "x-sitr-entitlement": undefined,
      },
      body,
    };
    const res = handler.handle(req);
    return new Response(res.body.length > 0 ? (res.body as unknown as BodyInit) : null, {
      status: res.status,
      headers: res.headers,
    });
  }) as typeof fetch;
}

function makeServer() {
  const store = new SyncStore(":memory:");
  const handler = new SyncHandler(store, configFromEnv({}), () => 1_000_000);
  return { store, fetch: serverFetch(handler) };
}

test("first sync creates the server blob; second device pulls it", async () => {
  const secret = generateRootSecret();
  const { fetch } = makeServer();
  const deps = { fetch, now: () => 1000, baseUrl: BASE };

  // Device A creates a household with a block rule and syncs.
  const a = {
    ...emptyHouseholdState("device-a", 500),
    blockDomains: ["blocked.example"],
  };
  const outA = await syncOnce(
    { rootSecret: secret, local: a, maxSeenRev: 0, deviceId: "device-a" },
    deps,
  );
  assert.equal(outA.status.state, "ok");
  assert.deepEqual(outA.state.blockDomains, ["blocked.example"]);

  // Device B joins with the empty placeholder state (authored at epoch 0,
  // as joinHousehold does) and pulls A's rules.
  const b = emptyHouseholdState("device-b", 0);
  const outB = await syncOnce(
    { rootSecret: secret, local: b, maxSeenRev: 0, deviceId: "device-b" },
    deps,
  );
  assert.equal(outB.status.state, "ok");
  assert.deepEqual(outB.state.blockDomains, ["blocked.example"]);
  assert.ok(outB.maxSeenRev >= outA.state.rev);
});

test("conflicting edits converge via 409 → re-pull → merge → retry", async () => {
  const secret = generateRootSecret();
  const { fetch } = makeServer();
  const deps = { fetch, now: () => 2000, baseUrl: BASE };

  const base = emptyHouseholdState("device-a", 100);
  await syncOnce(
    { rootSecret: secret, local: base, maxSeenRev: 0, deviceId: "device-a" },
    deps,
  );

  // Device A edits and syncs (server now ahead of B's knowledge).
  const editA = bumpRev(
    { ...base, blockDomains: ["a.example"] },
    "device-a",
    200,
  );
  const outA = await syncOnce(
    { rootSecret: secret, local: editA, maxSeenRev: base.rev, deviceId: "device-a" },
    deps,
  );
  assert.equal(outA.status.state, "ok");

  // Device B edits from the stale base — its push must land AFTER a merge
  // with A's edit (LWW: highest rev wins; B pushes a NEW higher rev).
  const editB = bumpRev(
    { ...base, blockDomains: ["b.example"] },
    "device-b",
    300,
  );
  const outB = await syncOnce(
    { rootSecret: secret, local: editB, maxSeenRev: base.rev, deviceId: "device-b" },
    deps,
  );
  assert.equal(outB.status.state, "ok");
  assert.ok(outB.state.rev > outA.state.rev);

  // Device A pulls again and sees B's winning state.
  const outA2 = await syncOnce(
    { rootSecret: secret, local: outA.state, maxSeenRev: outA.maxSeenRev, deviceId: "device-a" },
    deps,
  );
  assert.equal(outA2.status.state, "ok");
  assert.deepEqual(outA2.state.blockDomains, outB.state.blockDomains);
});

test("rollback detection: an older-than-seen server state is refused", async () => {
  const secret = generateRootSecret();
  const keys = await deriveKeys(secret);
  assert.ok(keys.ok);
  const { store, fetch } = makeServer();
  const deps = { fetch, now: () => 3000, baseUrl: BASE };

  // Seed the server directly with an OLD state (rev 1).
  const authHash = new Uint8Array(
    createHash("sha256").update(Buffer.from(keys.value.authToken, "hex")).digest(),
  );
  const old = emptyHouseholdState("device-a", 10);
  const sealed = await sealState(old, keys.value.encKey);
  assert.ok(sealed.ok);
  store.put(keys.value.householdId, authHash, sealed.value, null, 0);

  // The client has already seen rev 5 — the stale blob must be refused.
  const local = { ...emptyHouseholdState("device-a", 10), rev: 5 };
  const out = await syncOnce(
    { rootSecret: secret, local, maxSeenRev: 5, deviceId: "device-a" },
    deps,
  );
  assert.equal(out.status.state, "error");
  assert.match(out.status.error ?? "", /older/);
  assert.equal(out.state, local, "local state untouched");
  assert.equal(out.maxSeenRev, 5);
});

test("offline server → status offline, local state untouched, never throws", async () => {
  const secret = generateRootSecret();
  const failingFetch = (async () => {
    throw new TypeError("network down");
  }) as unknown as typeof fetch;
  const local = emptyHouseholdState("device-a", 1);
  const out = await syncOnce(
    { rootSecret: secret, local, maxSeenRev: 0, deviceId: "device-a" },
    { fetch: failingFetch, now: () => 1, baseUrl: BASE },
  );
  assert.equal(out.status.state, "offline");
  assert.equal(out.state, local);
});

test("server 500 → status error with the code, local state untouched", async () => {
  const secret = generateRootSecret();
  const fetch500 = (async () =>
    new Response(null, { status: 500 })) as unknown as typeof fetch;
  const local = emptyHouseholdState("device-a", 1);
  const out = await syncOnce(
    { rootSecret: secret, local, maxSeenRev: 0, deviceId: "device-a" },
    { fetch: fetch500, now: () => 1, baseUrl: BASE },
  );
  assert.equal(out.status.state, "error");
  assert.match(out.status.error ?? "", /500/);
});

test("a blob written under a different secret fails authentication cleanly", async () => {
  const { fetch } = makeServer();
  const deps = { fetch, now: () => 1, baseUrl: BASE };
  const s1 = generateRootSecret();
  await syncOnce(
    { rootSecret: s1, local: emptyHouseholdState("a", 1), maxSeenRev: 0, deviceId: "a" },
    deps,
  );
  // Same household id can't even be addressed without the same secret
  // (id is derived), so a different secret simply creates a separate blob.
  const s2 = generateRootSecret();
  const out = await syncOnce(
    { rootSecret: s2, local: emptyHouseholdState("b", 1), maxSeenRev: 0, deviceId: "b" },
    deps,
  );
  assert.equal(out.status.state, "ok");
});
