import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";

import { SyncStore } from "../../server/sync/dist/store.js";
import { SyncHandler, type SyncRequest } from "../../server/sync/dist/http.js";
import { configFromEnv } from "../../server/sync/dist/config.js";

const ID = "0123456789abcdef0123456789abcdef";
const TOKEN = "a".repeat(64);

function makeHandler(nowRef: { t: number }) {
  const store = new SyncStore(":memory:");
  const config = configFromEnv({});
  return new SyncHandler(store, config, () => nowRef.t);
}

function req(overrides: Partial<SyncRequest>): SyncRequest {
  return {
    method: "GET",
    path: `/v1/blob/${ID}`,
    ip: "203.0.113.7",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: new Uint8Array(0),
    ...overrides,
  };
}

function put(
  body: Uint8Array,
  extra: Record<string, string | undefined> = { "if-none-match": "*" },
  ip = "203.0.113.7",
): SyncRequest {
  return req({
    method: "PUT",
    body,
    ip,
    headers: { authorization: `Bearer ${TOKEN}`, ...extra },
  });
}

test("full lifecycle: create → get → conditional update → delete", () => {
  const now = { t: 1_000_000 };
  const h = makeHandler(now);

  // GET before create
  assert.equal(h.handle(req({})).status, 404);

  // Create
  const created = h.handle(put(new Uint8Array([1, 2, 3])));
  assert.equal(created.status, 201);
  assert.equal(created.headers["ETag"], '"1"');

  // Get
  const got = h.handle(req({}));
  assert.equal(got.status, 200);
  assert.deepEqual([...got.body], [1, 2, 3]);
  assert.equal(got.headers["ETag"], '"1"');

  // Conditional update with correct etag
  const updated = h.handle(put(new Uint8Array([9]), { "if-match": '"1"' }));
  assert.equal(updated.status, 200);
  assert.equal(updated.headers["ETag"], '"2"');

  // Stale etag → 409 with current etag
  const conflict = h.handle(put(new Uint8Array([7]), { "if-match": '"1"' }));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.headers["ETag"], '"2"');

  // Delete, then 404
  assert.equal(h.handle(req({ method: "DELETE" })).status, 204);
  assert.equal(h.handle(req({})).status, 404);
});

test("auth: wrong credential is rejected on every route, right one binds at create", () => {
  const now = { t: 1_000_000 };
  const h = makeHandler(now);
  h.handle(put(new Uint8Array([1])));
  const wrong = { authorization: `Bearer ${"b".repeat(64)}` };
  assert.equal(h.handle(req({ headers: wrong })).status, 401);
  assert.equal(
    h.handle(req({ method: "PUT", body: new Uint8Array([2]), headers: { ...wrong, "if-match": '"1"' } })).status,
    401,
  );
  assert.equal(h.handle(req({ method: "DELETE", headers: wrong })).status, 401);
  // Malformed tokens never reach the store.
  assert.equal(h.handle(req({ headers: { authorization: "Bearer short" } })).status, 401);
  assert.equal(h.handle(req({ headers: {} })).status, 401);
});

test("PUT without any precondition is refused (no blind overwrites)", () => {
  const h = makeHandler({ t: 0 });
  const r = h.handle(put(new Uint8Array([1]), {}));
  assert.equal(r.status, 428);
});

test("oversize blob → 413; empty body → 400; bad path → 404; bad method → 405", () => {
  const h = makeHandler({ t: 0 });
  assert.equal(h.handle(put(new Uint8Array(64 * 1024 + 1))).status, 413);
  assert.equal(h.handle(put(new Uint8Array(0))).status, 400);
  assert.equal(h.handle(req({ path: "/v1/blob/short" })).status, 404);
  assert.equal(h.handle(req({ path: "/other" })).status, 404);
  assert.equal(h.handle(req({ method: "PATCH" })).status, 405);
});

test("per-id rate limit: 429 inside the minute, resets after", () => {
  const now = { t: 1_000_000 };
  const h = makeHandler(now);
  const limit = configFromEnv({}).requestsPerIdPerMinute;
  for (let i = 0; i < limit; i++) {
    assert.notEqual(h.handle(req({})).status, 429, `request ${i}`);
  }
  assert.equal(h.handle(req({})).status, 429);
  now.t += 61_000;
  assert.notEqual(h.handle(req({})).status, 429);
});

test("create rate limit is per-IP and hourly", () => {
  const now = { t: 1_000_000 };
  const h = makeHandler(now);
  const limit = configFromEnv({}).createsPerIpPerHour;
  for (let i = 0; i < limit; i++) {
    const id = createHash("sha256").update(`h${i}`).digest("hex").slice(0, 32);
    const r = h.handle(put(new Uint8Array([1]), { "if-none-match": "*" }, "198.51.100.9"));
    void id; // ids can repeat — create limiter counts attempts per IP
    assert.notEqual(r.status, 429, `create ${i}`);
    now.t += 500; // stay inside the hour, avoid per-id minute limit
  }
  const blocked = h.handle(
    put(new Uint8Array([1]), { "if-none-match": "*" }, "198.51.100.9"),
  );
  assert.equal(blocked.status, 429);
  // A different IP is unaffected.
  const other = h.handle(
    put(new Uint8Array([1]), { "if-none-match": "*" }, "198.51.100.10"),
  );
  assert.notEqual(other.status, 429);
});

test("GC removes idle blobs and keeps fresh ones", () => {
  const store = new SyncStore(":memory:");
  const auth = new Uint8Array(createHash("sha256").update("x").digest());
  const day = 24 * 60 * 60 * 1000;
  store.put("a".repeat(32), auth, new Uint8Array([1]), null, 0);
  store.put("b".repeat(32), auth, new Uint8Array([1]), null, 600 * day);
  const removed = store.gc(600 * day, 540 * day);
  assert.equal(removed, 1);
  assert.equal(store.get("a".repeat(32), auth).kind, "not-found");
  assert.equal(store.get("b".repeat(32), auth).kind, "ok");
});

test("responses are marked no-store", () => {
  const h = makeHandler({ t: 0 });
  const r = h.handle(req({}));
  assert.equal(r.headers["Cache-Control"], "no-store");
});
