import assert from "node:assert/strict";
import { test } from "node:test";

import {
  backoffAfterFailure,
  createPinRecord,
  fromB64,
  hashPin,
  isLockedOut,
  isValidPinInput,
  NO_ATTEMPTS,
  sanitizeAttempts,
  sanitizePinRecord,
  toB64,
  verifyPin,
} from "../../extension/dist/lib/pin.js";

test("base64 round-trip", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  const r = fromB64(toB64(bytes));
  assert.ok(r.ok);
  assert.deepEqual([...r.value], [...bytes]);
  assert.ok(!fromB64("!!!not base64!!!").ok);
});

test("PIN length bounds", () => {
  assert.ok(!isValidPinInput("123").ok);
  assert.ok(isValidPinInput("1234").ok);
  assert.ok(!isValidPinInput("x".repeat(33)).ok);
});

test("PBKDF2 is deterministic for same inputs, distinct for different salt", async () => {
  const salt = new Uint8Array(16).fill(7);
  const a = await hashPin("4821", salt, 1000);
  const b = await hashPin("4821", salt, 1000);
  const c = await hashPin("4821", new Uint8Array(16).fill(8), 1000);
  assert.deepEqual([...a], [...b]);
  assert.notDeepEqual([...a], [...c]);
  assert.equal(a.length, 32);
});

test("create + verify round-trip; wrong PIN rejected", async () => {
  const rec = await createPinRecord("7391");
  assert.ok(rec.ok);
  assert.equal(await verifyPin("7391", rec.value), true);
  assert.equal(await verifyPin("7390", rec.value), false);
});

test("sanitizePinRecord accepts a real record and rejects garbage", async () => {
  const rec = await createPinRecord("7391");
  assert.ok(rec.ok);
  assert.deepEqual(sanitizePinRecord(rec.value), rec.value);
  for (const bad of [undefined, null, {}, { v: 2 }, { ...rec.value, hashB64: "!!" }]) {
    assert.equal(sanitizePinRecord(bad), undefined);
  }
});

test("backoff: free attempts first, then exponential, capped at 15 min", () => {
  const now = 1_000_000;
  let a = NO_ATTEMPTS;
  for (let i = 0; i < 4; i++) {
    a = backoffAfterFailure(a.count, now);
    assert.equal(a.lockedUntil, 0, `attempt ${i + 1} should be free`);
  }
  a = backoffAfterFailure(a.count, now); // 5th
  assert.equal(a.lockedUntil, now + 30_000);
  a = backoffAfterFailure(a.count, now); // 6th
  assert.equal(a.lockedUntil, now + 60_000);
  for (let i = 0; i < 20; i++) a = backoffAfterFailure(a.count, now);
  assert.equal(a.lockedUntil, now + 15 * 60_000, "capped");
});

test("lockout gate honors lockedUntil", () => {
  assert.ok(isLockedOut({ count: 5, lockedUntil: 2000 }, 1000).ok === false);
  assert.ok(isLockedOut({ count: 5, lockedUntil: 2000 }, 2001).ok);
  assert.ok(isLockedOut(NO_ATTEMPTS, 0).ok);
});

test("sanitizeAttempts degrades garbage to no-attempts", () => {
  assert.deepEqual(sanitizeAttempts(null), NO_ATTEMPTS);
  assert.deepEqual(sanitizeAttempts({ count: -1, lockedUntil: "x" }), NO_ATTEMPTS);
  assert.deepEqual(
    sanitizeAttempts({ count: 3, lockedUntil: 99 }),
    { count: 3, lockedUntil: 99 },
  );
});
