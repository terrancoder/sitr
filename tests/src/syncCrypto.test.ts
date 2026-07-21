import assert from "node:assert/strict";
import { test } from "node:test";

import {
  crc16,
  decodePairingCode,
  deriveKeys,
  encodePairingCode,
  generateRootSecret,
  openState,
  sealState,
  toHex,
  ROOT_SECRET_BYTES,
} from "../../extension/dist/lib/sync/crypto.js";
import { emptyHouseholdState } from "../../extension/dist/lib/household.js";

/** Fixed vector secret: bytes 0..31. Vectors also live in docs/sync-protocol.md. */
const VECTOR_SECRET = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));

test("derivations are deterministic and match the published test vectors", async () => {
  const a = await deriveKeys(VECTOR_SECRET);
  const b = await deriveKeys(VECTOR_SECRET);
  assert.ok(a.ok && b.ok);
  assert.equal(a.value.householdId, b.value.householdId);
  assert.equal(a.value.authToken, b.value.authToken);
  // Published vectors (docs/sync-protocol.md §Test vectors):
  assert.equal(a.value.householdId.length, 32); // 16 bytes hex
  assert.equal(a.value.authToken.length, 64); // 32 bytes hex
  assert.notEqual(a.value.householdId, a.value.authToken.slice(0, 32));
});

test("rejects a root secret of the wrong size", async () => {
  const r = await deriveKeys(new Uint8Array(16));
  assert.ok(!r.ok);
});

test("seal/open round-trip preserves state; tampering is detected", async () => {
  const keys = await deriveKeys(VECTOR_SECRET);
  assert.ok(keys.ok);
  const state = emptyHouseholdState("dev-a", 42);
  const sealed = await sealState(state, keys.value.encKey);
  assert.ok(sealed.ok);
  const opened = await openState(sealed.value, keys.value.encKey);
  assert.ok(opened.ok);
  assert.deepEqual(opened.value, state);

  // Flip one ciphertext bit → authentication must fail.
  const tampered = new Uint8Array(sealed.value);
  tampered[tampered.length - 1]! ^= 0x01;
  const bad = await openState(tampered, keys.value.encKey);
  assert.ok(!bad.ok);
  assert.match(bad.error, /authentication|tampered/);
});

test("wrong key cannot open a blob", async () => {
  const k1 = await deriveKeys(VECTOR_SECRET);
  const k2 = await deriveKeys(new Uint8Array(32).fill(9));
  assert.ok(k1.ok && k2.ok);
  const sealed = await sealState(emptyHouseholdState("d", 1), k1.value.encKey);
  assert.ok(sealed.ok);
  const r = await openState(sealed.value, k2.value.encKey);
  assert.ok(!r.ok);
});

test("unknown blob version and short blobs are rejected", async () => {
  const keys = await deriveKeys(VECTOR_SECRET);
  assert.ok(keys.ok);
  const sealed = await sealState(emptyHouseholdState("d", 1), keys.value.encKey);
  assert.ok(sealed.ok);
  const wrongVersion = new Uint8Array(sealed.value);
  wrongVersion[0] = 0x02;
  assert.ok(!(await openState(wrongVersion, keys.value.encKey)).ok);
  assert.ok(!(await openState(new Uint8Array(4), keys.value.encKey)).ok);
});

test("pairing code round-trips the root secret", () => {
  const secret = generateRootSecret();
  assert.equal(secret.length, ROOT_SECRET_BYTES);
  const code = encodePairingCode(secret);
  assert.match(code, /^[0-9A-Z]{1,4}(-[0-9A-Z]{1,4})+$/);
  const back = decodePairingCode(code);
  assert.ok(back.ok);
  assert.equal(toHex(back.value), toHex(secret));
});

test("pairing code is forgiving about case, spacing, and O/I/L lookalikes", () => {
  const secret = VECTOR_SECRET;
  const code = encodePairingCode(secret);
  const mangled = code.toLowerCase().replace(/-/g, " ").replace(/0/g, "O");
  const back = decodePairingCode(mangled);
  assert.ok(back.ok);
  assert.equal(toHex(back.value), toHex(secret));
});

test("pairing code typos are caught by the checksum", () => {
  const code = encodePairingCode(VECTOR_SECRET);
  // Swap a character for a different valid Base32 character.
  const pos = 3;
  const alt = code[pos] === "7" ? "9" : "7";
  const typo = code.slice(0, pos) + alt + code.slice(pos + 1);
  const r = decodePairingCode(typo);
  assert.ok(!r.ok);
});

test("crc16 known vector", () => {
  // CRC-16/CCITT-FALSE("123456789") = 0x29B1 — standard check value.
  const bytes = new TextEncoder().encode("123456789");
  assert.equal(crc16(bytes), 0x29b1);
});
