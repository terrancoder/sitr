/**
 * Conformance fixture replay — the reference implementation must pass the
 * COMMITTED fixtures in apps/shared/fixtures forever, not just at the
 * moment they were generated. The Swift and Kotlin ports replay the same
 * files in their own suites; this test is what keeps all three
 * implementations pinned to one behavior.
 *
 * Regenerate with `npm run fixtures` (CI diffs the result).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import {
  crc16,
  decodePairingCode,
  deriveKeys,
  encodePairingCode,
  openState,
  toHex,
} from "../../extension/dist/lib/sync/crypto.js";
import {
  mergeStates,
  sanitizeHouseholdState,
  type HouseholdState,
} from "../../extension/dist/lib/household.js";
import {
  gateMutation,
  type MutationKind,
  type HouseholdRole,
} from "../../extension/dist/lib/gate.js";
import { EMPTY_MANAGED_POLICY } from "../../extension/dist/lib/managed.js";
import {
  backoffAfterFailure,
  hashPin,
  verifyPin,
  type PinRecord,
} from "../../extension/dist/lib/pin.js";
import { EntitlementChecker } from "../../server/sync/dist/entitlement.js";

const fixture = (name: string): any =>
  JSON.parse(
    readFileSync(
      new URL(`../../apps/shared/fixtures/${name}`, import.meta.url),
      "utf8",
    ),
  );

const fromHex = (hex: string): Uint8Array =>
  new Uint8Array(hex.match(/.{2}/g)?.map((b: string) => parseInt(b, 16)) ?? []);

const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

test("hkdf fixture: derivations match for every committed case", async () => {
  const fx = fixture("hkdf.json");
  assert.ok(fx.cases.length >= 4);
  for (const c of fx.cases) {
    const keys = await deriveKeys(fromHex(c.rootSecretHex));
    assert.ok(keys.ok, c.name);
    assert.equal(keys.value.authToken, c.authTokenHex, c.name);
    assert.equal(keys.value.householdId, c.householdIdHex, c.name);

    // encKeyHex: prove the committed bytes are the reference's actual key by
    // sealing a probe with them and opening it with the reference-derived key.
    const imported = await crypto.subtle.importKey(
      "raw",
      fromHex(c.encKeyHex) as BufferSource,
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    );
    const nonce = new Uint8Array(12);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: nonce as BufferSource,
          additionalData: new TextEncoder().encode("sitr-sync v1") as BufferSource,
        },
        imported,
        new TextEncoder().encode(
          JSON.stringify({ v: 1, rev: 1 }),
        ) as BufferSource,
      ),
    );
    const probe = new Uint8Array(1 + 12 + ct.length);
    probe[0] = 0x01;
    probe.set(nonce, 1);
    probe.set(ct, 13);
    const opened = await openState(probe, keys.value.encKey);
    assert.ok(opened.ok, `${c.name}: committed encKeyHex must match the reference key`);
  }
  for (const c of fx.invalid) {
    assert.ok(!(await deriveKeys(fromHex(c.rootSecretHex))).ok, c.name);
  }
});

test("blob fixture: golden opens byte-exactly and errors stay errors", async () => {
  const fx = fixture("blob.json");
  const keys = await deriveKeys(fromHex(fx.golden.rootSecretHex));
  assert.ok(keys.ok);
  const opened = await openState(fromB64(fx.golden.blobB64), keys.value.encKey);
  assert.ok(opened.ok);
  assert.deepEqual(opened.value, fx.golden.stateJson);
  assert.equal(JSON.stringify(fx.golden.stateJson), fx.golden.plaintextUtf8);

  for (const e of fx.errors) {
    const k =
      e.rootSecretHex !== undefined
        ? await deriveKeys(fromHex(e.rootSecretHex))
        : keys;
    assert.ok(k.ok);
    const r = await openState(fromB64(e.blobB64), k.value.encKey);
    assert.ok(!r.ok, e.name);
  }
});

test("pairing fixture: canonical codes, forgiveness, and rejections", () => {
  const fx = fixture("pairing.json");
  for (const c of fx.canonical) {
    assert.equal(encodePairingCode(fromHex(c.rootSecretHex)), c.code, c.name);
    const back = decodePairingCode(c.code);
    assert.ok(back.ok, c.name);
    assert.equal(toHex(back.value), c.rootSecretHex, c.name);
  }
  for (const c of fx.decodeOk) {
    const back = decodePairingCode(c.code);
    assert.ok(back.ok, c.name);
    assert.equal(toHex(back.value), c.rootSecretHex, c.name);
  }
  for (const c of fx.decodeError) {
    assert.ok(!decodePairingCode(c.code).ok, c.name);
  }
});

test("crc16 fixture", () => {
  const fx = fixture("crc16.json");
  for (const c of fx.cases) {
    assert.equal(
      crc16(fromHex(c.inputHex)).toString(16).padStart(4, "0"),
      c.crcHex,
      c.name,
    );
  }
});

test("merge fixture: LWW winners", () => {
  const fx = fixture("merge.json");
  for (const c of fx.cases) {
    const winner = mergeStates(c.a as HouseholdState, c.b as HouseholdState);
    assert.deepEqual(winner, c.winner === "a" ? c.a : c.b, c.name);
  }
});

test("gate fixture: exhaustive authority table", () => {
  const fx = fixture("gate.json");
  assert.equal(fx.cases.length, 120);
  for (const c of fx.cases) {
    const verdict = gateMutation(c.kind as MutationKind, {
      managed: { ...EMPTY_MANAGED_POLICY, lockOptions: c.managedLockOptions },
      role: (c.role ?? undefined) as HouseholdRole | undefined,
      hasPin: c.hasPin,
    });
    assert.deepEqual(verdict, c.verdict, `${c.kind} / ${JSON.stringify(c)}`);
  }
});

test("sanitize fixture: total validator behavior", () => {
  const fx = fixture("sanitize.json");
  for (const c of fx.cases) {
    const r = sanitizeHouseholdState(c.raw);
    assert.equal(r.ok, c.ok, c.name);
    if (r.ok) assert.deepEqual(r.value, c.sanitized, c.name);
  }
});

test("pin fixture: fixed-salt golden hash, verify, and backoff schedule", async () => {
  const fx = fixture("pin.json");
  const g = fx.golden;
  const hash = await hashPin(g.pin, fromHex(g.saltHex), g.iterations);
  assert.equal(toHex(hash), g.hashHex);
  assert.ok(await verifyPin(g.pin, g.record as PinRecord));
  assert.ok(!(await verifyPin(g.wrongPin, g.record as PinRecord)));
  for (const c of fx.backoff) {
    assert.deepEqual(backoffAfterFailure(c.priorCount, c.now), c.after);
  }
});

test("entitlement fixture: verification outcomes with the committed test key", () => {
  const fx = fixture("entitlement.json");
  const checker = new EntitlementChecker(fx.publicKeyB64);
  const open = new EntitlementChecker(undefined);
  for (const c of fx.cases) {
    const header = c.token === "" ? undefined : c.token;
    assert.equal(checker.check(header, fx.now).kind, c.outcome, c.name);
    assert.equal(open.check(header, fx.now).kind, "ok", c.name);
  }
});
