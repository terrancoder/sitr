/**
 * Conformance fixture generator.
 *
 * Usage: node generate.js --out <apps/shared/fixtures>
 *
 * Exports the behavior of the reference TypeScript implementation
 * (extension/src/lib) as deterministic JSON fixtures that the Swift and
 * Kotlin ports replay in their own test suites. Fixtures are COMMITTED;
 * CI regenerates them and requires a clean diff, and
 * tests/src/fixtures.test.ts requires the reference itself to keep passing
 * them — so the three implementations can never drift apart silently.
 *
 * Determinism rules: every "random" input is a fixed constant below; no
 * timestamps; stable key order (objects are constructed in one place);
 * 2-space JSON with a trailing newline, like every other repo artifact.
 *
 * Every fixture is SELF-CHECKED against the reference before it is written:
 * a generator bug fails the run instead of poisoning three test suites.
 */
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  crc16,
  decodePairingCode,
  deriveKeys,
  encodePairingCode,
  openState,
  toHex,
} from "../../../extension/dist/lib/sync/crypto.js";
import {
  mergeStates,
  sanitizeHouseholdState,
  type HouseholdState,
} from "../../../extension/dist/lib/household.js";
import {
  LEAVE_JOIN_PLACEHOLDER_GATED_AS,
  REFRESH_DEVICE_LIST_GATED_AS,
  FAMILY_CODE_GATED_AS,
  gateMutation,
  type MutationKind,
} from "../../../extension/dist/lib/gate.js";
import { EMPTY_MANAGED_POLICY } from "../../../extension/dist/lib/managed.js";
import {
  DELAY_MINUTES,
  JOIN_HOUSEHOLD_WAITS_AS,
  SHORTEN_DELAY_GATED_AS,
  WINDOW_MS,
  delayChangeAction,
  evaluate,
  needsWait,
  type DelayAction,
  type DelayPhase,
  type DelayRequest,
} from "../../../extension/dist/lib/delay.js";
import {
  backoffAfterFailure,
  hashPin,
  sanitizePinRecord,
  toB64,
  verifyPin,
  PIN_ITERATIONS,
} from "../../../extension/dist/lib/pin.js";
import { buildLayerRule, type RuleLayer } from "../../../extension/dist/lib/ruleLayers.js";
import { compileBlockRuleset } from "../../../tools/compiler/dist/compile.js";
import { safesearchRules } from "../../../tools/compiler/dist/safesearch.js";
import { winningRule, type MatchableRule } from "../../../tools/compiler/dist/dnrMatch.js";
import {
  FIRST_BACKOFF_MS,
  MAX_BACKOFF_MS,
  claimOutcome,
  classifyCodeInput,
  created,
  emptyClaimState,
  forcesWrite,
  forgetClaims,
  next,
  normalizeSubscriptionCode,
  notice,
  observe,
  offersReplace,
  parseToken,
  record,
  retriesCreate,
  tokenToSend,
  userRetry,
  type ClaimOutcome,
  type ClaimReason,
  type ClaimState,
  type Decision,
  type EntitlementToken,
  type Notice,
  type SyncAnswer,
} from "../../../extension/dist/lib/entitlement.js";
import { DAY, HOUR, parseSyncRefusal } from "../../../extension/dist/lib/householdEnd.js";
import { mintToken, mintTokenV2, privateKeyFromB64 } from "../../../server/sync/dist/mint.js";
import { EntitlementChecker, checkToken } from "../../../server/sync/dist/entitlement.js";

function outDirArg(): string {
  const i = process.argv.indexOf("--out");
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined) {
    console.error("missing required argument --out");
    process.exit(2);
  }
  return v;
}

const fromHex = (hex: string): Uint8Array =>
  new Uint8Array(hex.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? []);

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/* ---------------------------- fixed inputs ------------------------------ */

/** The published vector secret: bytes 00..1f (docs/sync-protocol.md). */
const VECTOR_SECRET = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
const ZERO_SECRET = new Uint8Array(32);
const FF_SECRET = new Uint8Array(32).fill(0xff);
/** An arbitrary fixed secret so ports don't special-case patterned bytes. */
const INTEROP_SECRET = fromHex(
  "8f3a52c6d94e17b0a5c8e21f76d3049b1e6c8a35f20d97b4c1a68e53d7f20c94",
);
const SECRETS: Array<[string, Uint8Array]> = [
  ["vector", VECTOR_SECRET],
  ["zeros", ZERO_SECRET],
  ["ones", FF_SECRET],
  ["interop", INTEROP_SECRET],
];

/** Fixed AES-GCM nonce for blob goldens (sealState uses random nonces; the
 * blob layout is normative, so assembling with a fixed nonce is legitimate). */
const FIXED_NONCE = fromHex("000102030405060708090a0b");
const AAD = new TextEncoder().encode("sitr-sync v1");

/** Fixed PBKDF2 salt for the PIN golden. */
const PIN_SALT = fromHex("000102030405060708090a0b0c0d0e0f");

/** Test-only Ed25519 seed — NEVER a production key. */
const ENT_SEED = VECTOR_SECRET;
const ENT_NOW = 1_755_500_000_000;
const ENT_EXP_VALID = 4_102_444_800_000; // 2100-01-01
const ENT_EXP_PAST = 1_000;

/* ------------------------- reference helpers ---------------------------- */

/** HKDF-SHA256, empty salt — same WebCrypto primitive the reference uses.
 * Needed because deriveKeys() returns the encryption key non-extractable;
 * the blob self-check below proves this derivation matches the reference. */
async function hkdfBytes(
  secret: Uint8Array,
  info: string,
  bytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    secret as BufferSource,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(info),
    },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

async function sealWithFixedNonce(
  plaintextUtf8: string,
  encKeyBytes: Uint8Array,
  nonce: Uint8Array,
  versionByte: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encKeyBytes as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce as BufferSource,
        additionalData: AAD as BufferSource,
      },
      key,
      new TextEncoder().encode(plaintextUtf8) as BufferSource,
    ),
  );
  const blob = new Uint8Array(1 + nonce.length + ct.length);
  blob[0] = versionByte;
  blob.set(nonce, 1);
  blob.set(ct, 1 + nonce.length);
  return blob;
}

/** Crockford Base32 encode — local copy so we can build a version-0x02
 * pairing payload (the reference encoder only emits version 0x01). The
 * canonical-code self-check proves this matches the reference bit-for-bit. */
function b32encode(bytes: Uint8Array): string {
  const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

function pairingCodeWithVersion(secret: Uint8Array, version: number): string {
  const payload = new Uint8Array(1 + secret.length + 2);
  payload[0] = version;
  payload.set(secret, 1);
  const crc = crc16(payload.subarray(0, 1 + secret.length));
  payload[1 + secret.length] = crc >>> 8;
  payload[2 + secret.length] = crc & 0xff;
  const raw = b32encode(payload);
  return raw.match(/.{1,4}/g)?.join("-") ?? raw;
}

/** A canonical non-trivial state that survives sanitize round-trips
 * unchanged (sorted lists, valid domains, fixed-salt PIN record). */
async function canonicalState(): Promise<HouseholdState> {
  const pinHash = await hashPin("1234", PIN_SALT, PIN_ITERATIONS);
  const raw = {
    v: 1,
    rev: 7,
    updatedAt: 1_700_000_000_000,
    updatedBy: "device-guardian-1",
    allowDomains: ["allowed.example", "ok.example"],
    blockDomains: ["blocked.example", "worse.example"],
    devices: ["device-child-1", "device-guardian-1"],
    disabledCategories: ["sitr_dating"],
    pin: {
      v: 1,
      algo: "PBKDF2-SHA256",
      iterations: PIN_ITERATIONS,
      saltB64: toB64(PIN_SALT),
      hashB64: toB64(pinHash),
    },
    policy: { childLockOptions: true },
  };
  const sanitized = sanitizeHouseholdState(raw);
  assert.ok(sanitized.ok, "canonical state must sanitize cleanly");
  assert.deepEqual(sanitized.value, raw, "canonical state must be a fixpoint");
  return sanitized.value;
}

/* ------------------------------ fixtures -------------------------------- */

async function genHkdf(): Promise<object> {
  const cases = [];
  for (const [name, secret] of SECRETS) {
    const keys = await deriveKeys(secret);
    assert.ok(keys.ok);
    const encKey = await hkdfBytes(secret, "sitr-sync v1 encryption key", 32);
    // Self-check the local HKDF against the reference-derived values.
    assert.equal(
      toHex(await hkdfBytes(secret, "sitr-sync v1 auth credential", 32)),
      keys.value.authToken,
    );
    assert.equal(
      toHex(await hkdfBytes(secret, "sitr-sync v1 household id", 16)),
      keys.value.householdId,
    );
    cases.push({
      name,
      rootSecretHex: toHex(secret),
      encKeyHex: toHex(encKey),
      authTokenHex: keys.value.authToken,
      householdIdHex: keys.value.householdId,
    });
  }
  const bad = await deriveKeys(new Uint8Array(16));
  assert.ok(!bad.ok);
  return {
    version: 1,
    note: "generated — edit tools/conformance, run npm run fixtures",
    hkdf: {
      hash: "SHA-256",
      salt: "",
      infoEncryptionKey: "sitr-sync v1 encryption key",
      infoAuthCredential: "sitr-sync v1 auth credential",
      infoHouseholdId: "sitr-sync v1 household id",
    },
    cases,
    invalid: [{ name: "wrong-length secret", rootSecretHex: "00".repeat(16) }],
  };
}

async function genBlob(): Promise<object> {
  const state = await canonicalState();
  const plaintextUtf8 = JSON.stringify(state);
  const encKeyBytes = await hkdfBytes(
    VECTOR_SECRET,
    "sitr-sync v1 encryption key",
    32,
  );
  const blob = await sealWithFixedNonce(plaintextUtf8, encKeyBytes, FIXED_NONCE, 0x01);

  // Self-check: the reference must open the assembled blob to the exact
  // state — proving key derivation, layout, AAD, and sanitizer all agree.
  const vectorKeys = await deriveKeys(VECTOR_SECRET);
  assert.ok(vectorKeys.ok);
  const opened = await openState(blob, vectorKeys.value.encKey);
  assert.ok(opened.ok, `reference must open the golden blob: ${JSON.stringify(opened)}`);
  assert.deepEqual(opened.value, state);

  const tampered = new Uint8Array(blob);
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
  assert.ok(!(await openState(tampered, vectorKeys.value.encKey)).ok);

  const wrongVersion = await sealWithFixedNonce(
    plaintextUtf8,
    encKeyBytes,
    FIXED_NONCE,
    0x02,
  );
  assert.ok(!(await openState(wrongVersion, vectorKeys.value.encKey)).ok);

  const zeroKeys = await deriveKeys(ZERO_SECRET);
  assert.ok(zeroKeys.ok);
  assert.ok(!(await openState(blob, zeroKeys.value.encKey)).ok);

  return {
    version: 1,
    note: "generated — edit tools/conformance, run npm run fixtures. Ports must encrypt plaintextUtf8 exactly as given (no re-serialization).",
    aad: "sitr-sync v1",
    golden: {
      rootSecretHex: toHex(VECTOR_SECRET),
      nonceHex: toHex(FIXED_NONCE),
      plaintextUtf8,
      stateJson: state,
      blobB64: b64(blob),
    },
    errors: [
      { name: "tampered last byte", blobB64: b64(tampered) },
      { name: "unknown version byte", blobB64: b64(wrongVersion) },
      { name: "too short", blobB64: b64(new Uint8Array(4)) },
      {
        name: "wrong key",
        blobB64: b64(blob),
        rootSecretHex: toHex(ZERO_SECRET),
      },
    ],
  };
}

function genPairing(): object {
  const canonical = SECRETS.map(([name, secret]) => {
    const code = encodePairingCode(secret);
    // Self-check the local encoder against the reference (version 0x01).
    assert.equal(pairingCodeWithVersion(secret, 0x01), code);
    const decoded = decodePairingCode(code);
    assert.ok(decoded.ok);
    assert.equal(toHex(decoded.value), toHex(secret));
    return { name, rootSecretHex: toHex(secret), code };
  });

  const vectorCode = encodePairingCode(VECTOR_SECRET);
  const mangled = vectorCode.toLowerCase().replace(/-/g, " ").replace(/0/g, "O");
  const mangledDecoded = decodePairingCode(mangled);
  assert.ok(mangledDecoded.ok);
  assert.equal(toHex(mangledDecoded.value), toHex(VECTOR_SECRET));

  const pos = 3;
  const alt = vectorCode[pos] === "7" ? "9" : "7";
  const typo = vectorCode.slice(0, pos) + alt + vectorCode.slice(pos + 1);
  assert.ok(!decodePairingCode(typo).ok);

  const truncated = vectorCode.slice(0, 12);
  assert.ok(!decodePairingCode(truncated).ok);

  const futureVersion = pairingCodeWithVersion(VECTOR_SECRET, 0x02);
  assert.ok(!decodePairingCode(futureVersion).ok);

  return {
    version: 1,
    note: "generated — edit tools/conformance, run npm run fixtures",
    canonical,
    decodeOk: [
      {
        name: "lowercase, spaces, O-for-0 lookalikes",
        code: mangled,
        rootSecretHex: toHex(VECTOR_SECRET),
      },
    ],
    decodeError: [
      { name: "single-character typo", code: typo },
      { name: "truncated", code: truncated },
      { name: "future version byte", code: futureVersion },
    ],
  };
}

function genCrc16(): object {
  const inputs: Array<[string, Uint8Array]> = [
    ["standard check value", new TextEncoder().encode("123456789")],
    ["empty", new Uint8Array(0)],
    ["single zero byte", new Uint8Array(1)],
    ["bytes 00..1f", VECTOR_SECRET],
  ];
  const cases = inputs.map(([name, bytes]) => ({
    name,
    inputHex: toHex(bytes),
    crcHex: crc16(bytes).toString(16).padStart(4, "0"),
  }));
  assert.equal(cases[0]?.crcHex, "29b1");
  return {
    version: 1,
    note: "generated — edit tools/conformance, run npm run fixtures",
    algorithm: "CRC-16/CCITT-FALSE",
    cases,
  };
}

async function genMerge(): Promise<object> {
  const base = await canonicalState();
  const s = (over: Partial<HouseholdState>): HouseholdState => ({
    ...base,
    ...over,
  });
  const pairs: Array<[string, HouseholdState, HouseholdState]> = [
    ["higher rev wins (a)", s({ rev: 9 }), s({ rev: 8 })],
    ["higher rev wins (b)", s({ rev: 3 }), s({ rev: 12 })],
    [
      "rev tie -> later updatedAt wins",
      s({ rev: 5, updatedAt: 100 }),
      s({ rev: 5, updatedAt: 200 }),
    ],
    [
      "rev+time tie -> greater updatedBy wins",
      s({ rev: 5, updatedAt: 100, updatedBy: "device-b" }),
      s({ rev: 5, updatedAt: 100, updatedBy: "device-a" }),
    ],
    ["identical states (tie resolves to b)", s({}), s({})],
  ];
  const cases = pairs.map(([name, a, x]) => {
    const winner = mergeStates(a, x) === a ? "a" : "b";
    return { name, a, b: x, winner };
  });
  assert.deepEqual(
    cases.map((c) => c.winner),
    ["a", "b", "b", "a", "b"],
  );
  return {
    version: 1,
    note: "generated — edit tools/conformance, run npm run fixtures",
    cases,
  };
}

function genGate(): object {
  const kinds: MutationKind[] = [
    "disableCategory",
    "removeDeviceBlockRule",
    "addDeviceAllowRule",
    "removeHouseholdRule",
    "leaveHousehold",
    "loosenMediaMode",
    "addImageAllowRule",
    "enableCategory",
    "addDeviceBlockRule",
    "removeDeviceAllowRule",
    "addHouseholdRule",
    "changePin",
    "tightenMediaMode",
    "removeImageAllowRule",
  ];
  const cases = [];
  for (const lockOptions of [false, true]) {
    for (const role of [undefined, "guardian", "child"] as const) {
      for (const hasPin of [false, true]) {
        for (const kind of kinds) {
          const verdict = gateMutation(kind, {
            managed: { ...EMPTY_MANAGED_POLICY, lockOptions },
            role,
            hasPin,
          });
          cases.push({
            kind,
            managedLockOptions: lockOptions,
            role: role ?? null,
            hasPin,
            verdict,
          });
        }
      }
    }
  }
  assert.equal(cases.length, 2 * 3 * 2 * kinds.length);
  // A child leaves only with the household PIN; without one it is refused.
  const child = (hasPin: boolean) => ({ managed: EMPTY_MANAGED_POLICY, role: "child" as const, hasPin });
  assert.deepEqual(gateMutation("leaveHousehold", child(true)), { allowed: true, requiresPin: true });
  assert.deepEqual(gateMutation("leaveHousehold", child(false)), { allowed: false, reason: "child-device" });
  // Leaving a join placeholder: managed lock refuses, otherwise allowed with
  // no PIN and no wait, in every context (P1).
  for (const c of cases.filter((c) => c.kind === LEAVE_JOIN_PLACEHOLDER_GATED_AS)) {
    assert.deepEqual(
      c.verdict,
      c.managedLockOptions ? { allowed: false, reason: "managed-locked" } : { allowed: true, requiresPin: false },
    );
  }
  for (const phase of ["off", "idle", "waiting", "open"] as const) {
    assert.equal(needsWait(LEAVE_JOIN_PLACEHOLDER_GATED_AS, phase), false);
  }
  // A subscription code: managed lock and child device refuse; otherwise the
  // PIN exactly when one is set; never a wait.
  for (const c of cases.filter((c) => c.kind === FAMILY_CODE_GATED_AS)) {
    assert.deepEqual(
      c.verdict,
      c.managedLockOptions
        ? { allowed: false, reason: "managed-locked" }
        : c.role === "child"
          ? { allowed: false, reason: "child-device" }
          : { allowed: true, requiresPin: c.hasPin },
    );
  }
  for (const phase of ["off", "idle", "waiting", "open"] as const) {
    assert.equal(needsWait(FAMILY_CODE_GATED_AS, phase), false);
  }
  return {
    version: 1,
    note: "generated — edit tools/conformance, run npm run fixtures. Exhaustive: every context x every mutation kind. A child device leaving without a household PIN is refused as child-device; show \"Leaving needs the guardian PIN. Ask your guardian to set one in the household.\" for it. \"Refresh device list\" has no row: it is gated exactly as refreshDeviceListGatedAs. Leaving a household this device never received has no row either: when the household state READ FROM STORAGE at the moment of leaving (never one cached by an open screen) is a join placeholder (rev 1, updatedAt 0) with no pin field, leaveHousehold is gated exactly as leaveJoinPlaceholderGatedAs, for any role: refused as managed-locked under a managed lock, otherwise allowed with no PIN and no wait (that kind never waits, see delay.json needsWait). A browser's or phone's own PIN does not count; check the stored state again inside the function that performs the leave. Entering, removing or moving a subscription code has no row either: it is gated exactly as subscriptionGatedAs (on Android also refused while the child lock is on).",
    refreshDeviceListGatedAs: REFRESH_DEVICE_LIST_GATED_AS,
    leaveJoinPlaceholderGatedAs: LEAVE_JOIN_PLACEHOLDER_GATED_AS,
    subscriptionGatedAs: FAMILY_CODE_GATED_AS,
    cases,
  };
}

/*
 * delay.json — "wait before loosening" (extension/src/lib/delay.ts).
 *
 * Shape (all times are integer milliseconds <= 2^53-1; minutes are integers):
 * {
 *   "version": 1, "note": string,
 *   "delayMinutesAllowed": [0, 5, 30, 60, 360, 1440],   // 0 = off
 *   "windowMs": 600000,
 *   "shortenDelayGatedAs": "disableCategory",  // gate row used for shortenDelay
 *   "joinHouseholdWaitsAs": "disableCategory", // needsWait row used for joining
 *   "evaluate": [{ "name": string, "delayMinutes": int,
 *                  "request": { "at": int } | null, "now": int,
 *                  "result": { "phase": "off"|"idle"|"waiting"|"open",
 *                              "remainingMs": int,
 *                              "request": { "at": int } | null } }],
 *   "needsWait": [{ "action": <MutationKind> | "shortenDelay",
 *                   "phase": <phase>, "needsWait": bool }],
 *   "delayChange": [{ "fromMinutes": int, "toMinutes": int,
 *                     "action": "shortenDelay" | null,  // null = free
 *                     "phase": <phase of the CURRENT (from) setting>,
 *                     "needsWait": bool }]
 * }
 * evaluate: persist result.request whenever it differs from the input
 * (restarted after the clock went back, or cleared). Compute with
 * elapsed = now - at, never at + delay. Caller rules not expressible as
 * cases: starting and cancelling a request never wait; any change to the
 * delay setting clears the stored request; the order is gate (refused stays
 * refused) -> needsWait -> PIN if the gate asked for one -> needsWait again
 * after a correct PIN. Joining a household is never refused (not by the
 * managed lock, not by a role): it waits as joinHouseholdWaitsAs, then asks
 * for this device's own PIN when one is set, then re-checks the wait.
 */
function genDelay(): object {
  const T = 1_700_000_000_000;
  const MAX = Number.MAX_SAFE_INTEGER;
  const W = WINDOW_MS;
  const evaluateCases = [];
  for (const minutes of DELAY_MINUTES) {
    const d = minutes * 60_000;
    const clock: Array<[string, DelayRequest | null, number]> = [
      ["no request", null, T],
      ["just requested", { at: T }, T],
      ["one ms before the wait ends", { at: T }, T + d - 1],
      ["exactly at the end of the wait", { at: T }, T + d],
      ["inside the window", { at: T }, T + d + W / 2],
      ["one ms before the window closes", { at: T }, T + d + W - 1],
      ["exactly at the window close", { at: T }, T + d + W],
      ["long after (30 days)", { at: T }, T + d + W + 30 * 86_400_000],
      ["clock one ms backwards", { at: T }, T - 1],
      ["clock far backwards (to zero)", { at: T }, 0],
      ["monotonic clock at zero, just requested", { at: 0 }, 0],
      ["huge: requested at zero, now at max", { at: 0 }, MAX],
      ["huge: requested one ms before max", { at: MAX - 1 }, MAX],
      ["huge: requested at max, clock back to zero", { at: MAX }, 0],
    ];
    for (const [name, request, now] of clock) {
      evaluateCases.push({
        name: `${minutes} min: ${name}`,
        delayMinutes: minutes,
        request,
        now,
        result: evaluate(minutes, request, now),
      });
    }
  }
  // Self-check the defining properties against the generated table.
  for (const c of evaluateCases) {
    const r = c.result;
    if (c.delayMinutes === 0) assert.equal(r.phase, "off", c.name);
    if (c.delayMinutes > 0 && c.request !== null && c.now < c.request.at) {
      assert.equal(r.phase, "waiting", c.name);
      assert.deepEqual(r.request, { at: c.now }, c.name);
    }
    if (r.phase === "open") {
      assert.ok(c.request !== null && c.now - c.request.at >= c.delayMinutes * 60_000, c.name);
    }
  }

  const kinds: DelayAction[] = [
    "disableCategory",
    "removeDeviceBlockRule",
    "addDeviceAllowRule",
    "removeHouseholdRule",
    "leaveHousehold",
    "loosenMediaMode",
    "addImageAllowRule",
    "enableCategory",
    "addDeviceBlockRule",
    "removeDeviceAllowRule",
    "addHouseholdRule",
    "changePin",
    "tightenMediaMode",
    "removeImageAllowRule",
    "shortenDelay",
  ];
  const phases: DelayPhase[] = ["off", "idle", "waiting", "open"];
  const needsWaitCases = [];
  for (const action of kinds) {
    for (const phase of phases) {
      needsWaitCases.push({ action, phase, needsWait: needsWait(action, phase) });
    }
  }
  assert.equal(needsWaitCases.filter((c) => c.needsWait).length, 8 * 2);

  const delayChange = [];
  for (const from of DELAY_MINUTES) {
    for (const to of DELAY_MINUTES) {
      if (from === to) continue;
      const action = delayChangeAction(from, to);
      for (const phase of from === 0 ? (["off"] as const) : (["idle", "waiting", "open"] as const)) {
        delayChange.push({
          fromMinutes: from,
          toMinutes: to,
          action,
          phase,
          needsWait: action !== null && needsWait(action, phase),
        });
      }
    }
  }
  return {
    version: 1,
    note: "generated — edit tools/conformance, run npm run fixtures. Shape documented above genDelay() in tools/conformance/src/generate.ts. A misbehaving clock may open the window late, never early.",
    delayMinutesAllowed: [...DELAY_MINUTES],
    windowMs: WINDOW_MS,
    shortenDelayGatedAs: SHORTEN_DELAY_GATED_AS,
    joinHouseholdWaitsAs: JOIN_HOUSEHOLD_WAITS_AS,
    evaluate: evaluateCases,
    needsWait: needsWaitCases,
    delayChange,
  };
}

async function genSanitize(): Promise<object> {
  const good = await canonicalState();
  const inputs: Array<[string, unknown]> = [
    ["canonical state is a fixpoint", good],
    [
      "invalid domains dropped, lists sorted and deduped",
      {
        ...good,
        allowDomains: ["z.example", "not a domain!", "a.example", "a.example"],
        blockDomains: ["UPPER.example"],
      },
    ],
    [
      "unknown fields dropped, defaults filled",
      { v: 1, rev: 1, surprise: true },
    ],
    ["updatedBy truncated to 64 chars", { ...good, updatedBy: "x".repeat(100) }],
    [
      "invalid pin record dropped",
      { ...good, pin: { v: 1, algo: "bcrypt", saltB64: "!", hashB64: "!" } },
    ],
    [
      "childLockOptions defaults to true",
      { v: 1, rev: 2, policy: { other: 1 } },
    ],
    [
      "updatedAt beyond the exact-integer range resets to 0",
      { ...good, updatedAt: 1e300 },
    ],
    [
      "pin record with an absurd iteration count dropped",
      {
        ...good,
        pin: { v: 1, algo: "PBKDF2-SHA256", iterations: 5e9, saltB64: "AAAA", hashB64: "AAAA" },
      },
    ],
    ["not an object", "nope"],
    ["unknown version", { ...good, v: 2 }],
    ["missing rev", { v: 1 }],
    ["rev beyond the supported range", { ...good, rev: 2_000_000_001 }],
    ["rev far beyond any integer type", { ...good, rev: 1e300 }],
    [
      "oversized device list",
      { v: 1, rev: 1, devices: Array.from({ length: 21 }, (_, i) => `d${i}`) },
    ],
    [
      "oversized domain list",
      {
        v: 1,
        rev: 1,
        blockDomains: Array.from({ length: 2001 }, (_, i) => `d${i}.example`),
      },
    ],
  ];
  const cases = inputs.map(([name, raw]) => {
    const r = sanitizeHouseholdState(raw);
    return r.ok
      ? { name, raw, ok: true, sanitized: r.value }
      : { name, raw, ok: false };
  });
  assert.deepEqual(
    cases.map((c) => c.ok),
    [true, true, true, true, true, true, true, true, false, false, false, false, false, false, false],
  );
  return {
    version: 1,
    note: "generated — edit tools/conformance, run npm run fixtures",
    cases,
  };
}

async function genPin(): Promise<object> {
  const hash = await hashPin("1234", PIN_SALT, PIN_ITERATIONS);
  const record = {
    v: 1 as const,
    algo: "PBKDF2-SHA256" as const,
    iterations: PIN_ITERATIONS,
    saltB64: toB64(PIN_SALT),
    hashB64: toB64(hash),
  };
  assert.ok(sanitizePinRecord(record) !== undefined);
  assert.ok(await verifyPin("1234", record));
  assert.ok(!(await verifyPin("4321", record)));

  const NOW = 1_000_000;
  const backoff = Array.from({ length: 9 }, (_, count) => ({
    priorCount: count,
    now: NOW,
    after: backoffAfterFailure(count, NOW),
  }));
  // Free attempts then 30s * 2^(n-5), capped at 15 min.
  assert.equal(backoff[3]?.after.lockedUntil, 0);
  assert.equal(backoff[4]?.after.lockedUntil, NOW + 30_000);
  assert.equal(backoff[8]?.after.lockedUntil, NOW + 480_000);

  return {
    version: 1,
    note: "generated — edit tools/conformance, run npm run fixtures",
    golden: {
      pin: "1234",
      saltHex: toHex(PIN_SALT),
      iterations: PIN_ITERATIONS,
      hashHex: toHex(hash),
      record,
      wrongPin: "4321",
    },
    backoff,
  };
}

function genEntitlement(): object {
  const seedB64 = b64(ENT_SEED);
  const priv = privateKeyFromB64(seedB64);
  const pubDer = createPublicKey(priv).export({ format: "der", type: "spki" });
  const pubB64 = Buffer.from(pubDer.subarray(pubDer.length - 32)).toString(
    "base64",
  );

  const valid = mintToken(priv, "family", ENT_EXP_VALID);
  const expired = mintToken(priv, "family", ENT_EXP_PAST);
  const otherSeed = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(ZERO_SECRET),
    ]),
    format: "der",
    type: "pkcs8",
  });
  const wrongKey = mintToken(otherSeed, "family", ENT_EXP_VALID);

  const checker = new EntitlementChecker(pubB64);
  const open = new EntitlementChecker(undefined);
  const cases = [
    { name: "valid token", token: valid, outcome: "ok" },
    { name: "expired token", token: expired, outcome: "denied" },
    { name: "signed by a different key", token: wrongKey, outcome: "denied" },
    { name: "wrong prefix", token: valid.replace("sitr-ent-v1", "sitr-ent-v9"), outcome: "denied" },
    { name: "missing signature part", token: valid.split(".").slice(0, 2).join("."), outcome: "denied" },
    { name: "empty header", token: "", outcome: "denied" },
  ];
  for (const c of cases) {
    assert.equal(
      checkToken(checker, c.token === "" ? undefined : c.token, ENT_NOW).kind,
      c.outcome,
      c.name,
    );
    assert.equal(checkToken(open, c.token, ENT_NOW).kind, "ok");
  }

  return {
    version: 1,
    note: "generated — edit tools/conformance, run npm run fixtures. TEST-ONLY keypair; never a production key.",
    publicKeyB64: pubB64,
    privateSeedHexTestOnly: toHex(ENT_SEED),
    now: ENT_NOW,
    cases,
    openMode: "with no public key configured every token verifies ok",
  };
}

/*
 * decision.json — which allow entries can open a name (owner's rules,
 * 2026-11-20). Shape:
 * {
 *   "version": 1, "note": string,
 *   "lists": { "adult": [domain], "gambling": [...], "dating": [...],
 *              "violence": [...] },          // violence = an opt-in list, on
 *   "searchEngine": "www.google.com",       // a name SafeSearch rewrites
 *   "cases": [{ "name": string, "rule": "R1"|"R2"|"R3", "host": string,
 *               "managed"|"household"|"user": { "allow": [domain],
 *                                               "block": [domain] },
 *               "expected": "block" | "forward" | "safesearch" }]
 * }
 * Matching: a listed or allowed parent covers its subdomains. Expected:
 * R1 a name on the adult list (or under a listed parent) is blocked
 * whatever any layer allows; an allow on a parent still opens the parent
 * and its other subdomains. R2 an allow never stops SafeSearch. R3 every
 * other list and the layer order (managed > household > user > lists,
 * allow before block within a layer) are as before. Lists are synthetic.
 * Self-checked against the extension's real rules (buildLayerRule,
 * compileBlockRuleset, safesearchRules) under DNR precedence (dnrMatch.ts).
 */
type DecisionLayers = Partial<Record<RuleLayer, { allow?: string[]; block?: string[] }>>;
const DECISION_LISTS = {
  adult: ["adult.example", "deep.host.example"],
  gambling: ["bet.example"],
  dating: ["date.example"],
  violence: ["gore.example"],
};

function extensionOutcome(host: string, layers: DecisionLayers): string {
  const rules: MatchableRule[] = [...safesearchRules()];
  for (const [category, domains] of Object.entries(DECISION_LISTS)) {
    const compiled = compileBlockRuleset(category, [...domains].sort());
    assert.ok(compiled.ok);
    rules.push(...compiled.value);
  }
  let id = 1;
  for (const [layer, kinds] of Object.entries(layers) as Array<[RuleLayer, { allow?: string[]; block?: string[] }]>) {
    for (const kind of ["allow", "block"] as const) {
      for (const d of kinds[kind] ?? []) rules.push(buildLayerRule(layer, kind, d, id++));
    }
  }
  const won = winningRule(rules, `https://${host}/search?q=x`);
  return won === undefined || won.action.type === "allow"
    ? "forward"
    : won.action.type === "redirect"
      ? "safesearch"
      : "block";
}

function genDecision(): object {
  const all = (d: string): DecisionLayers => ({
    managed: { allow: [d] },
    household: { allow: [d] },
    user: { allow: [d] },
  });
  const cases: Array<{ name: string; rule: string; host: string; expected: string } & DecisionLayers> = [
    { name: "adult name, no lists", rule: "R1", host: "adult.example", expected: "block" },
    { name: "adult name, user allow", rule: "R1", host: "adult.example", user: { allow: ["adult.example"] }, expected: "block" },
    { name: "adult name, household allow", rule: "R1", host: "adult.example", household: { allow: ["adult.example"] }, expected: "block" },
    { name: "adult name, managed allow", rule: "R1", host: "adult.example", managed: { allow: ["adult.example"] }, expected: "block" },
    { name: "adult name, allowed at every layer", rule: "R1", host: "adult.example", ...all("adult.example"), expected: "block" },
    { name: "subdomain of an adult parent, allow on the subdomain", rule: "R1", host: "www.adult.example", user: { allow: ["www.adult.example"] }, expected: "block" },
    { name: "adult subdomain, managed allow on its parent", rule: "R1", host: "deep.host.example", managed: { allow: ["host.example"] }, expected: "block" },
    { name: "parent of an adult subdomain, allow on the parent opens it", rule: "R1", host: "host.example", user: { allow: ["host.example"] }, expected: "forward" },
    { name: "other subdomain of that parent, allow on the parent opens it", rule: "R1", host: "other.host.example", household: { allow: ["host.example"] }, expected: "forward" },
    { name: "parent of an adult subdomain, no lists", rule: "R1", host: "host.example", expected: "forward" },
    { name: "search engine, no lists", rule: "R2", host: "www.google.com", expected: "safesearch" },
    { name: "search engine, user allow on its parent", rule: "R2", host: "www.google.com", user: { allow: ["google.com"] }, expected: "safesearch" },
    { name: "search engine, household allow", rule: "R2", host: "www.google.com", household: { allow: ["www.google.com"] }, expected: "safesearch" },
    { name: "search engine, allowed at every layer", rule: "R2", host: "www.google.com", ...all("google.com"), expected: "safesearch" },
    { name: "gambling name, no lists", rule: "R3", host: "bet.example", expected: "block" },
    { name: "gambling name, user allow", rule: "R3", host: "bet.example", user: { allow: ["bet.example"] }, expected: "forward" },
    { name: "dating subdomain, household allow on the parent", rule: "R3", host: "m.date.example", household: { allow: ["date.example"] }, expected: "forward" },
    { name: "opt-in list name, user allow", rule: "R3", host: "gore.example", user: { allow: ["gore.example"] }, expected: "forward" },
    { name: "gambling name, managed allow", rule: "R3", host: "bet.example", managed: { allow: ["bet.example"] }, expected: "forward" },
    { name: "household block beats a user allow", rule: "R3", host: "bet.example", household: { block: ["bet.example"] }, user: { allow: ["bet.example"] }, expected: "block" },
    { name: "household allow beats a household block", rule: "R3", host: "site.example", household: { allow: ["site.example"], block: ["site.example"] }, expected: "forward" },
    { name: "managed block beats a household allow", rule: "R3", host: "site.example", managed: { block: ["site.example"] }, household: { allow: ["site.example"] }, expected: "block" },
    { name: "managed allow beats every block", rule: "R3", host: "site.example", managed: { allow: ["site.example"] }, household: { block: ["site.example"] }, user: { block: ["site.example"] }, expected: "forward" },
    { name: "user block on an unlisted name", rule: "R3", host: "site.example", user: { block: ["site.example"] }, expected: "block" },
    { name: "unlisted name, no lists", rule: "R3", host: "site.example", expected: "forward" },
  ];
  for (const c of cases) {
    const { name, rule, host, expected, ...layers } = c;
    assert.equal(extensionOutcome(host, layers), expected, `${rule} ${name}`);
  }
  return {
    version: 1,
    note: "generated — edit tools/conformance, run npm run fixtures. Synthetic names. Every platform's decision must give `expected`.",
    lists: DECISION_LISTS,
    searchEngine: "www.google.com",
    cases,
  };
}

/*
 * claim.json — entitlement version 2 on the client
 * (extension/src/lib/entitlement.ts; docs/sync-protocol.md §What each client
 * must do). Shape:
 * {
 *   "version": 1, "note": string, "constants": {...},
 *   "tokens": [{ "name", "raw", "parsed": <token> | null }],
 *   "codeInput": [{ "name", "input", "normalized": string | null,
 *                   "classified": { "kind": "code", "code" }
 *                               | { "kind": "v1-token", "token" }
 *                               | { "kind": "invalid" } }],
 *   "claimOutcomes": [{ "name", "status", "body": string | null, "outcome" }],
 *   "syncRefusals": [{ "name", "status", "body", "refusal": string | null,
 *                      "retriesCreate": bool }],
 *   "scenarios": [{ "name", "holdsCode", "steps": [{ "now", "random": n | null,
 *                   "state", "event", "decision": <decision> | null,
 *                   "result": { "state", "notice", "offersReplace",
 *                               "tokenToSend": raw | null, "forcesWrite" } }] }]
 * }
 * <token> = { raw, plan, term, per, exp, test }. A state is the full claim
 * state (every field present, null for none). Events:
 *   { type: "next", householdId }              -> decision, state
 *   { type: "record", current, outcome }       -> state
 *   { type: "observe", householdId, answer: { entExp, lapsed, succeeded, forced } }
 *   { type: "created", householdId, token, entExp }
 *   { type: "userRetry" } | { type: "forgetClaims" }
 * `random` is what next() draws, only on steps that draw. result.notice is
 * notice(result.state, now, holdsCode); the other result fields are computed
 * on result.state at `now`. Every `next` decision below is written by hand
 * and asserted, not recorded.
 */
type ClaimEvent =
  | { type: "next"; householdId: string }
  | { type: "record"; current: boolean; outcome: ClaimOutcome }
  | { type: "observe"; householdId: string; answer: SyncAnswer }
  | { type: "created"; householdId: string; token: EntitlementToken; entExp: number | null }
  | { type: "userRetry" }
  | { type: "forgetClaims" };

interface ClaimStep {
  now: number;
  event: ClaimEvent;
  random?: number;
  decision?: Decision;
  notice?: Notice;
  offersReplace?: boolean;
  check?: (s: ClaimState) => void;
}

function claimScenario(name: string, initial: ClaimState, steps: ClaimStep[], holdsCode = true): object {
  let state = initial;
  const out = [];
  for (const [i, st] of steps.entries()) {
    const label = `${name} — step ${i}`;
    const e = st.event;
    let decision: Decision | null = null;
    let after: ClaimState;
    switch (e.type) {
      case "next": {
        assert.ok(st.decision !== undefined, `${label}: a next step needs its decision`);
        let drawn = false;
        const r = next(state, st.now, e.householdId, () => {
          assert.ok(st.random !== undefined, `${label}: random drawn but none given`);
          drawn = true;
          return st.random;
        });
        assert.ok(st.random === undefined || drawn, `${label}: random given but not drawn`);
        decision = r.decision;
        after = r.state;
        assert.deepEqual(decision, st.decision, label);
        break;
      }
      case "record":
        after = record(state, e.outcome, e.current, st.now);
        break;
      case "observe":
        after = observe(state, e.answer, e.householdId, st.now);
        break;
      case "created":
        after = created(state, e.token, e.householdId, e.entExp);
        break;
      case "userRetry":
        after = userRetry(state);
        break;
      case "forgetClaims":
        after = forgetClaims(state);
        break;
    }
    const result: {
      state: ClaimState;
      notice: Notice;
      offersReplace: boolean;
      tokenToSend: string | null;
      forcesWrite: boolean;
    } = {
      state: after,
      notice: notice(after, st.now, holdsCode),
      offersReplace: offersReplace(after, st.now),
      tokenToSend: tokenToSend(after)?.raw ?? null,
      forcesWrite: forcesWrite(after),
    };
    if (st.notice !== undefined) assert.equal(result.notice, st.notice, label);
    if (st.offersReplace !== undefined) assert.equal(result.offersReplace, st.offersReplace, label);
    st.check?.(after);
    out.push({ now: st.now, random: st.random ?? null, state, event: e, decision, result });
    state = after;
  }
  return { name, holdsCode, steps: out };
}

function genClaim(): object {
  const priv = privateKeyFromB64(b64(ENT_SEED));
  const JTI = "AAAAAAAAAAAAAAAAAAAAAA";
  const mint = (per: number, exp: number, o: { plan?: string; term?: string; test?: true } = {}): EntitlementToken => {
    const raw = mintTokenV2(priv, {
      v: 2,
      plan: (o.plan ?? "family") as "family",
      term: (o.term ?? "month") as "month",
      per,
      exp,
      jti: JTI,
      ...(o.test ? { test: true as const } : {}),
    });
    const t = parseToken(raw);
    assert.ok(t !== null);
    return t;
  };
  const fake = (payload: unknown): string =>
    `sitr-ent-v2.${Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)).toString("base64url")}.c2ln`;

  const d = (y: number, m: number, day: number, h = 0, min = 0) => Date.UTC(y, m - 1, day, h, min);
  const MIN = 60_000;
  const nov1 = d(2026, 11, 1), nov10 = d(2026, 11, 10), nov20 = d(2026, 11, 20), nov21 = d(2026, 11, 21);
  const nov22 = d(2026, 11, 22), nov24 = d(2026, 11, 24), nov25 = d(2026, 11, 25), nov26 = d(2026, 11, 26);
  const nov27 = d(2026, 11, 27), nov28 = d(2026, 11, 28), nov29 = d(2026, 11, 29), nov30 = d(2026, 11, 30);
  const dec1 = d(2026, 12, 1), dec2 = d(2026, 12, 2), dec3 = d(2026, 12, 3), dec4 = d(2026, 12, 4);
  const dec5 = d(2026, 12, 5), dec10 = d(2026, 12, 10), dec25 = d(2026, 12, 25), dec26 = d(2026, 12, 26);
  const dec27 = d(2026, 12, 27), jan1 = d(2027, 1, 1), jan4 = d(2027, 1, 4), jan25 = d(2027, 1, 25);
  const feb4 = d(2027, 2, 4), mar1 = d(2027, 3, 1), mar25 = d(2027, 3, 25), apr4 = d(2027, 4, 4);
  assert.equal(dec4 - 10 * DAY, nov24);
  assert.equal(jan4 - 10 * DAY, dec25);
  assert.equal(dec4 - 5 * DAY, nov29);

  const NOV = mint(nov1, dec4), DEC = mint(dec1, jan4), JAN = mint(jan1, feb4), MAR = mint(mar1, apr4);
  const NOV_Y = mint(nov1, dec4, { term: "year" }), DEC_Y = mint(dec1, jan4, { term: "year" });
  const TEST_20 = mint(nov20, nov21 + HOUR, { test: true }), TEST_21 = mint(nov21, nov22 + HOUR, { test: true });
  const INST = mint(dec1, jan4, { plan: "inst-starter" });
  const V1 = mintToken(priv, "family", ENT_EXP_VALID);

  /* tokens */
  const valid: Array<[string, EntitlementToken, Partial<EntitlementToken>]> = [
    ["monthly family token", DEC, { plan: "family", term: "month", per: dec1, exp: jan4, test: false }],
    ["yearly family token", DEC_Y, { term: "year", per: dec1, exp: jan4 }],
    ["Sandbox token (test: true)", TEST_20, { per: nov20, exp: nov21 + HOUR, test: true }],
    ["Institutions token (parses; the plan is the caller's check)", INST, { plan: "inst-starter" }],
  ];
  const tokens: Array<{ name: string; raw: string; parsed: EntitlementToken | null }> = valid.map(([name, t, want]) => {
    for (const [k, v] of Object.entries(want)) assert.equal(t[k as keyof EntitlementToken], v, name);
    return { name, raw: t.raw, parsed: t };
  });
  const base = { v: 2, plan: "family", term: "month", per: dec1, exp: jan4, jti: JTI };
  const without = (k: string) => Object.fromEntries(Object.entries(base).filter(([key]) => key !== k));
  const okFake: Array<[string, unknown]> = [
    ["unknown payload key ignored", { ...base, extra: "x" }],
    ["keys in another order", { exp: jan4, per: dec1, term: "month", plan: "family", v: 2, jti: JTI }],
    ["no jti (the client does not read it)", without("jti")],
    ["test not the boolean true (1) reads as false", { ...base, test: 1 }],
  ];
  for (const [name, p] of okFake) {
    const raw = fake(p);
    const parsed = parseToken(raw);
    assert.ok(parsed !== null && parsed.per === dec1 && parsed.exp === jan4 && !parsed.test, name);
    tokens.push({ name, raw, parsed });
  }
  const bad: Array<[string, string]> = [
    ["version 1 token", V1],
    ["wrong prefix", DEC.raw.replace("sitr-ent-v2", "sitr-ent-v3")],
    ["two parts", DEC.raw.split(".").slice(0, 2).join(".")],
    ["four parts", `${DEC.raw}.x`],
    ["payload not base64url", "sitr-ent-v2.e30!.c2ln"],
    ["payload not JSON", fake("not json")],
    ["payload a JSON array", fake([2])],
    ["v 1 under the v2 prefix", fake({ ...base, v: 1 })],
    ["v missing", fake(without("v"))],
    ["v a string", fake({ ...base, v: "2" })],
    ["v not an integer (2.5)", fake({ ...base, v: 2.5 })],
    ["plan missing", fake(without("plan"))],
    ["plan a number", fake({ ...base, plan: 1 })],
    ["term missing", fake(without("term"))],
    ["per missing", fake(without("per"))],
    ["per a string", fake({ ...base, per: String(dec1) })],
    ["exp missing", fake(without("exp"))],
    ["exp a string", fake({ ...base, exp: String(jan4) })],
    ["empty", ""],
  ];
  for (const [name, raw] of bad) {
    assert.equal(parseToken(raw), null, name);
    tokens.push({ name, raw, parsed: null });
  }

  /* the one input field */
  const inputs: Array<[string, string, string]> = [
    ["version 4 UUID", "3f2b8c4e-9d1a-4e7b-a6c5-0f1e2d3c4b5a", "code"],
    ["upper case is lower-cased", "3F2B8C4E-9D1A-4E7B-A6C5-0F1E2D3C4B5A", "code"],
    ["surrounding whitespace is trimmed", "  3f2b8c4e-9d1a-4e7b-a6c5-0f1e2d3c4b5a\n", "code"],
    ["version 1 (time-based) UUID", "e3a1b2c0-1d2e-11ef-9a4b-0242ac120002", "code"],
    ["version 7 UUID", "01932c07-209c-7a5e-8b3f-1234567890ab", "code"],
    ["no hyphens", "3f2b8c4e9d1a4e7ba6c50f1e2d3c4b5a", "invalid"],
    ["in braces", "{3f2b8c4e-9d1a-4e7b-a6c5-0f1e2d3c4b5a}", "invalid"],
    ["urn prefix", "urn:uuid:3f2b8c4e-9d1a-4e7b-a6c5-0f1e2d3c4b5a", "invalid"],
    ["one character short", "3f2b8c4e-9d1a-4e7b-a6c5-0f1e2d3c4b5", "invalid"],
    ["one character long", "3f2b8c4e-9d1a-4e7b-a6c5-0f1e2d3c4b5a0", "invalid"],
    ["not hex", "3f2b8c4e-9d1a-4e7b-a6c5-0f1e2d3c4b5g", "invalid"],
    ["variant nibble not 8-b (the claim service refuses it)", "3f2b8c4e-9d1a-4e7b-c6c5-0f1e2d3c4b5a", "invalid"],
    ["nil UUID", "00000000-0000-0000-0000-000000000000", "invalid"],
    ["version 1 token", V1, "v1-token"],
    ["version 1 token with whitespace", ` ${V1}\n`, "v1-token"],
    ["version 1 prefix, two parts", "sitr-ent-v1.e30", "invalid"],
    ["version 2 token", DEC.raw, "invalid"],
    ["empty", "", "invalid"],
  ];
  const codeInput = inputs.map(([name, input, kind]) => {
    const classified = classifyCodeInput(input);
    assert.equal(classified.kind, kind, name);
    if (classified.kind === "code") assert.equal(classified.code, input.trim().toLowerCase(), name);
    if (classified.kind === "v1-token") assert.equal(classified.token, V1, name);
    return { name, input, normalized: normalizeSubscriptionCode(input), classified };
  });

  /* claim answers */
  const err = (error: string, extra: object = {}) => JSON.stringify({ error, ...extra });
  const answers: Array<[string, number, string | null, ClaimOutcome]> = [
    ["200 with a family token", 200, JSON.stringify({ token: DEC.raw }), { kind: "token", token: DEC }],
    ["200 with an Institutions token", 200, JSON.stringify({ token: INST.raw }), { kind: "not-family", plan: "inst-starter" }],
    ["200 with a token this client cannot read", 200, JSON.stringify({ token: "garbage" }), { kind: "unavailable" }],
    ["200 that is not JSON", 200, "<html>ok</html>", { kind: "unavailable" }],
    ["409 bound-to-other-device", 409, err("bound-to-other-device"), { kind: "refused", reason: "bound-to-other-device", retryAfter: null }],
    ["409 replacement-used with retry_after", 409, err("replacement-used", { retry_after: 1_811_808_000_000 }), { kind: "refused", reason: "replacement-used", retryAfter: 1_811_808_000_000 }],
    ["402 payment-pending", 402, err("payment-pending"), { kind: "refused", reason: "payment-pending", retryAfter: null }],
    ["402 inactive", 402, err("inactive"), { kind: "refused", reason: "inactive", retryAfter: null }],
    ["402 revoked", 402, err("revoked"), { kind: "refused", reason: "revoked", retryAfter: null }],
    ["404 unknown-code", 404, err("unknown-code"), { kind: "refused", reason: "unknown-code", retryAfter: null }],
    ["422 wrong-product", 422, err("wrong-product"), { kind: "refused", reason: "wrong-product", retryAfter: null }],
    ["422 invalid-receipt (Apple)", 422, err("invalid-receipt"), { kind: "refused", reason: "invalid-receipt", retryAfter: null }],
    ["422 test-purchase (Apple)", 422, err("test-purchase"), { kind: "refused", reason: "test-purchase", retryAfter: null }],
    ["422 family-sharing (Apple)", 422, err("family-sharing"), { kind: "refused", reason: "family-sharing", retryAfter: null }],
    ["400 bad-request", 400, err("bad-request"), { kind: "refused", reason: "bad-request", retryAfter: null }],
    ["404 not-found (stops)", 404, err("not-found"), { kind: "refused", reason: "unrecognized", retryAfter: null }],
    ["413 too-large (stops)", 413, err("too-large"), { kind: "refused", reason: "unrecognized", retryAfter: null }],
    ["405 method-not-allowed (stops)", 405, err("method-not-allowed"), { kind: "refused", reason: "unrecognized", retryAfter: null }],
    ["429 slow-down", 429, err("slow-down"), { kind: "unavailable" }],
    ["502 billing-unavailable", 502, err("billing-unavailable"), { kind: "unavailable" }],
    ["503 claims-disabled", 503, err("claims-disabled"), { kind: "unavailable" }],
    ["500 with an empty body", 500, "", { kind: "unavailable" }],
    ["no network (no answer)", 0, null, { kind: "unavailable" }],
    ["404 plain text from a host without the claim route", 404, "not found\n", { kind: "unavailable" }],
    ["402 plain text (version 1 route prose)", 402, "checkout not completed\n", { kind: "unavailable" }],
    ["400 JSON without an error field", 400, JSON.stringify({ message: "x" }), { kind: "unavailable" }],
  ];
  const claimOutcomes = answers.map(([name, status, body, outcome]) => {
    assert.deepEqual(claimOutcome(status, body), outcome, name);
    return { name, status, body, outcome };
  });

  /* sync 402 reasons */
  const refusals: Array<[string, number, string, string | null, boolean]> = [
    ["lapsed", 402, "lapsed\n", "lapsed", false],
    ["token-required", 402, "token-required\n", "token-required", true],
    ["token-invalid", 402, "token-invalid\n", "token-invalid", true],
    ["token-expired", 402, "token-expired\n", "token-expired", true],
    ["plan-not-accepted with a second line", 402, "plan-not-accepted\nmore text", "plan-not-accepted", false],
    ["token-used without a newline", 402, "token-used", "token-used", true],
    ["v1-ended", 402, "v1-ended\n", "v1-ended", false],
    ["surrounding whitespace", 402, " lapsed \r\n", "lapsed", false],
    ["version 1 server: entitlement required", 402, "entitlement required\n", "token-required", true],
    ["version 1 server: malformed entitlement token (also a v2 token)", 402, "malformed entitlement token\n", "token-invalid", true],
    ["version 1 server: invalid entitlement signature", 402, "invalid entitlement signature\n", "token-invalid", true],
    ["version 1 server: malformed entitlement payload", 402, "malformed entitlement payload\n", "token-invalid", true],
    ["version 1 server: unsupported entitlement version", 402, "unsupported entitlement version\n", "token-invalid", true],
    ["version 1 server: entitlement expired", 402, "entitlement expired — please renew\n", "token-expired", true],
    ["unknown first line", 402, "server responded\n", null, false],
    ["not a 402", 409, "lapsed\n", null, false],
  ];
  const syncRefusals = refusals.map(([name, status, body, refusal, retry]) => {
    const got = parseSyncRefusal(status, body);
    assert.equal(got, refusal, name);
    assert.equal(got !== null && retriesCreate(got), retry, name);
    return { name, status, body, refusal, retriesCreate: retry };
  });

  /* scenarios */
  const H = "h1";
  const NONE: Decision = { kind: "none" };
  const CLAIM: Decision = { kind: "claim", replace: false, current: false };
  const CURRENT: Decision = { kind: "claim", replace: false, current: true };
  const WAIT = (until: number): Decision => ({ kind: "wait", until });
  const nx = (now: number, decision: Decision, more: Partial<ClaimStep> & { householdId?: string } = {}): ClaimStep => ({
    now,
    event: { type: "next", householdId: more.householdId ?? H },
    decision,
    ...more,
  });
  const rec = (now: number, outcome: ClaimOutcome, current = false, more: Partial<ClaimStep> = {}): ClaimStep => ({
    now,
    event: { type: "record", current, outcome },
    ...more,
  });
  const obs = (
    now: number,
    entExp: number | null,
    a: { lapsed?: boolean; succeeded?: boolean; forced?: string } = {},
    more: Partial<ClaimStep> = {},
  ): ClaimStep => ({
    now,
    event: {
      type: "observe",
      householdId: H,
      answer: { entExp, lapsed: a.lapsed ?? false, succeeded: a.succeeded ?? !a.lapsed, forced: a.forced ?? null },
    },
    ...more,
  });
  const make = (now: number, token: EntitlementToken, entExp: number | null): ClaimStep => ({
    now,
    event: { type: "created", householdId: H, token, entExp },
  });
  const tok = (t: EntitlementToken): ClaimOutcome => ({ kind: "token", token: t });
  const refused = (reason: ClaimReason, retryAfter: number | null = null): ClaimOutcome => ({
    kind: "refused",
    reason,
    retryAfter,
  });
  const UNAVAILABLE: ClaimOutcome = { kind: "unavailable" };
  const empty = emptyClaimState();
  const applied = (entExp: number, more: Partial<ClaimState> = {}): ClaimState => ({
    ...empty,
    appliedHousehold: H,
    entExp,
    ...more,
  });
  const BOUND = "bound-to-other-device" as const;
  const held = (n: number) => (s: ClaimState) => assert.equal(s.tokens.length, n);
  const backoff = (ms: number | null) => (s: ClaimState) => assert.equal(s.backoff, ms);

  const scenarios = [
    claimScenario("Purchase on 20 November: the November token, exp 4 December; the window for December opens on 24 November.", empty, [
      rec(nov20 + 15 * HOUR, tok(NOV), false, { check: held(1) }),
      make(nov20 + 15 * HOUR + MIN, NOV, dec4),
      nx(nov21, WAIT(nov24 + 2.5 * DAY), { random: 0.5 }),
      nx(nov24 + 2.5 * DAY, CLAIM),
      rec(nov24 + 2.5 * DAY, tok(DEC), false, { check: (s) => assert.ok(forcesWrite(s) && s.notBefore === null) }),
      nx(nov24 + 2.5 * DAY + HOUR, NONE),
      obs(nov24 + 2.5 * DAY + HOUR, jan4, { forced: DEC.raw }, { check: held(0) }),
      nx(nov24 + 2.5 * DAY + 2 * HOUR, WAIT(dec25 + 1.25 * DAY), { random: 0.25 }),
    ]),
    claimScenario("Purchase on 27 November: the December token at once, exp 4 January. It is early until 1 December, which does not stop it creating a household.", empty, [
      rec(nov27, tok(DEC)),
      make(nov27 + MIN, DEC, jan4),
      nx(nov27 + 2 * MIN, WAIT(dec25), { random: 0 }),
    ]),
    claimScenario("(b) at once, when it has never applied a version 2 token to its current household (a legacy household, or a credential just entered); here E is an announced cut-over date.", empty, [
      obs(nov10, mar1, {}, { notice: "none" }),
      nx(nov10 + MIN, CLAIM),
      rec(nov10 + MIN, tok(NOV), false, { check: (s) => assert.equal(s.notBefore, nov10 + MIN + DAY) }),
      nx(nov10 + 2 * MIN, WAIT(nov10 + MIN + DAY)),
      obs(nov10 + 3 * MIN, dec4, { forced: NOV.raw }, { check: (s) => assert.ok(s.appliedHousehold === H && s.tokens.length === 0) }),
      nx(nov10 + MIN + DAY, WAIT(nov24 + 2.5 * DAY), { random: 0.5 }),
    ]),
    claimScenario("A legacy household after the cut-over is announced: a device that holds no code shows \"Enter your subscription code on one guardian device before <date>.\" (E more than 41 days away, or a value once seen more than 41 days away).", empty, [
      obs(nov10, mar1, {}, { notice: "enter-code" }),
      obs(jan25, mar1, {}, { notice: "enter-code" }),
      obs(mar1 + HOUR, mar1, { lapsed: true }, { notice: "waiting" }),
    ], false),
    claimScenario("Otherwise it shows the ordinary notices (a device without a code, E never seen more than 41 days away).", empty, [
      obs(nov10, dec4, {}, { notice: "none" }),
      obs(dec3, dec4, {}, { notice: "waiting" }),
    ], false),
    claimScenario("Legacy household converted: on or after the cut-over it is lapsed, and the device claims with current: true first.", { ...empty, entExp: mar1 }, [
      nx(mar1 + HOUR, CURRENT),
      rec(mar1 + HOUR, tok(MAR), true, { check: (s) => assert.ok(s.lapseClaimed) }),
      nx(mar1 + 2 * HOUR, NONE),
      obs(mar1 + 3 * HOUR, apr4, { forced: MAR.raw }, { check: (s) => assert.ok(!s.lapsed && s.appliedHousehold === H) }),
      nx(mar1 + 4 * HOUR, WAIT(mar25), { random: 0 }),
    ]),
    claimScenario("(c) The device picks a time evenly at random in the first 5 days, [E − 10 × DAY, E − 5 × DAY), and claims at its first run after that time.", applied(dec4), [
      nx(nov24 - 1, WAIT(nov24 + 2.5 * DAY), { random: 0.5 }),
      nx(nov25, WAIT(nov24 + 2.5 * DAY)),
      nx(nov24 + 2.5 * DAY - 1, WAIT(nov24 + 2.5 * DAY)),
      nx(nov24 + 2.5 * DAY, CLAIM),
    ]),
    claimScenario("(c) From E − 5 × DAY on it claims at its first run with no delay.", applied(dec4), [
      nx(nov29, CLAIM, { random: 0.75 }),
    ]),
    claimScenario("Monthly, renewal day the 28th, claim on 25 November: the November token again (a token whose exp is not later than E: it tries again a day later); after the renewal on 28 November it gets the December token.", applied(dec4), [
      nx(nov25, CLAIM, { random: 0 }),
      rec(nov25, tok(NOV), false, { check: (s) => assert.equal(s.notBefore, nov26) }),
      obs(nov25 + HOUR, dec4, { forced: NOV.raw }, { check: held(0) }),
      nx(nov25 + 2 * HOUR, WAIT(nov26)),
      nx(nov26, CLAIM),
      rec(nov26, tok(NOV), false, { check: (s) => assert.ok(s.notBefore === nov27 && !forcesWrite(s)) }),
      obs(nov26 + HOUR, dec4, {}, { check: held(0) }),
      nx(nov28 + HOUR, CLAIM),
      rec(nov28 + HOUR, tok(DEC), false, { check: (s) => assert.ok(s.notBefore === null && s.tokens.length === 1) }),
      nx(nov28 + 2 * HOUR, NONE),
    ]),
    claimScenario("Yearly, claim on 10 November: exp 4 December. The bound device claims again from 24 November (E − 10 days) and gets the December token.", empty, [
      rec(nov10, tok(NOV_Y)),
      make(nov10 + MIN, NOV_Y, dec4),
      nx(nov10 + 2 * MIN, WAIT(nov24), { random: 0 }),
      nx(nov24, CLAIM),
      rec(nov24, tok(DEC_Y), false, { check: (s) => assert.equal(tokenToSend(s)?.term, "year") }),
    ]),
    claimScenario("A device that holds two tokens (this month's and an early one for next month) sends the one that is not early first, and the early one at the next write.",
      applied(dec4, { lapsed: true, lapseClaimed: true, tokens: [JAN, DEC] }), [
      nx(dec26, NONE, { check: (s) => assert.equal(tokenToSend(s)?.raw, DEC.raw) }),
      obs(dec26 + HOUR, jan4, { forced: DEC.raw }, { check: (s) => assert.ok(tokenToSend(s)?.raw === JAN.raw && forcesWrite(s)) }),
      obs(dec26 + 2 * HOUR, feb4, { forced: JAN.raw }, { check: held(0) }),
    ]),
    claimScenario("Household lapsed since 4 December, bound device back on 26 December: a claim with current: true gets the December token, which reopens the household; the plain claim that follows gets the January token, early, which extends it to 4 February.", applied(dec4), [
      nx(dec26, CURRENT, { notice: "waiting" }),
      rec(dec26, tok(DEC), true),
      nx(dec26 + MIN, NONE),
      obs(dec26 + 2 * MIN, jan4, { forced: DEC.raw }, { notice: "none", check: (s) => assert.ok(!s.lapsed && !s.lapseClaimed) }),
      nx(dec26 + 3 * MIN, CLAIM, { random: 0 }),
      rec(dec26 + 3 * MIN, tok(JAN)),
      obs(dec26 + 4 * MIN, feb4, { forced: JAN.raw }, { check: held(0) }),
    ]),
    claimScenario("(d) When its household is lapsed (E ≤ now, or a 402 lapsed), at once and with current: true — here a 402 lapsed while the device's own clock still puts E ahead.", applied(dec4), [
      obs(dec3, dec4, { lapsed: true }, { notice: "waiting" }),
      nx(dec3 + MIN, CURRENT),
    ]),
    claimScenario("Laptop closed from 25 December: it claims at its first run after reopening on 4 January, when the household is already lapsed.", applied(jan4, { windowFor: jan4, windowAt: dec27 }), [
      nx(d(2027, 1, 4, 8), CURRENT),
    ]),
    claimScenario("payment-pending: show the reason with the way to fix it, then try at most once a day; \"Payment problem\" while E is less than 2 days away and once lapsed.", applied(dec4), [
      nx(nov29, CLAIM, { random: 0.5 }),
      rec(nov29, refused("payment-pending"), false, { notice: "none" }),
      nx(nov30 - 1, WAIT(nov30)),
      nx(nov30, CLAIM),
      rec(nov30, refused("payment-pending")),
      nx(dec3, CLAIM),
      rec(dec3, refused("payment-pending"), false, { notice: "payment-problem" }),
      nx(dec4 + HOUR, CURRENT),
      rec(dec4 + HOUR, refused("payment-pending"), true, { notice: "payment-problem" }),
      nx(dec4 + 2 * HOUR, WAIT(dec5 + HOUR)),
    ]),
    claimScenario("inactive: at most once a day; \"Family has ended\" only when a claim on this device came back inactive or revoked.", applied(dec4), [
      nx(dec3, CLAIM, { random: 0 }),
      rec(dec3, refused("inactive"), false, { notice: "ended" }),
      nx(dec3 + HOUR, WAIT(dec4)),
      nx(dec4, CURRENT, { notice: "ended" }),
    ]),
    claimScenario("revoked: try at most once a day, or when the user asks.", applied(dec4), [
      nx(dec3, CLAIM, { random: 0 }),
      rec(dec3, refused("revoked"), false, { notice: "ended" }),
      nx(dec3 + HOUR, WAIT(dec4)),
      { now: dec3 + HOUR, event: { type: "userRetry" } },
      nx(dec3 + HOUR, CLAIM),
    ]),
    claimScenario("429, 502, 503, no network: retry at later sync runs, with backoff (5 minutes, doubling, at most 6 hours).", applied(dec4), [
      nx(nov29, CLAIM, { random: 0.5 }),
      rec(nov29, UNAVAILABLE, false, { check: backoff(FIRST_BACKOFF_MS) }),
      nx(nov29 + MIN, WAIT(nov29 + 5 * MIN)),
      nx(nov29 + 5 * MIN, CLAIM),
      rec(nov29 + 5 * MIN, UNAVAILABLE, false, { check: backoff(10 * MIN) }),
      nx(nov29 + 15 * MIN, CLAIM),
      ...[20, 40, 80, 160, 320, 360, 360].map((m) =>
        rec(nov29 + 15 * MIN, UNAVAILABLE, false, { check: backoff(m * MIN) }),
      ),
      nx(nov29 + 16 * MIN, WAIT(nov29 + 15 * MIN + MAX_BACKOFF_MS)),
      rec(nov29 + 15 * MIN + MAX_BACKOFF_MS, tok(DEC), false, { check: (s) => assert.ok(s.backoff === null && s.notBefore === null) }),
    ]),
    claimScenario("replacement-used: show the date in retry_after. The subscription is still bound elsewhere: no automatic claim while E is in the future; once E has passed, one claim with current: true.",
      applied(dec4, { lastRefusal: BOUND }), [
      nx(dec3, NONE, { offersReplace: true }),
      rec(dec3 + MIN, refused("replacement-used", 1_811_808_000_000), false, {
        offersReplace: false,
        notice: "replacement-used",
        check: (s) => assert.equal(s.retryAfter, 1_811_808_000_000),
      }),
      nx(dec3 + 2 * MIN, NONE),
      nx(dec4 + MIN, CURRENT),
      rec(dec4 + MIN, tok(DEC), true, { check: (s) => assert.ok(s.lastRefusal === null && s.retryAfter === null) }),
    ]),
    claimScenario("replacement-used: no \"Renew on this device\" until retry_after, and the notice shows that date; the bound rule goes on meanwhile.",
      applied(dec4, { lastRefusal: BOUND }), [
      rec(dec3, refused("replacement-used", dec10), false, { offersReplace: false, notice: "replacement-used" }),
      nx(dec4 + MIN, CURRENT),
      rec(dec4 + MIN, refused(BOUND), true, { offersReplace: false, notice: "replacement-used" }),
      nx(dec5, WAIT(dec5 + MIN)),
      nx(dec10 + MIN, CURRENT),
      rec(dec10 + MIN, refused(BOUND), true, { offersReplace: true, notice: "waiting" }),
    ]),
    claimScenario("bound-to-other-device, E in the future: no automatic claim — not by rule (b), not in the window, and no daily retry; \"Renew on this device\" only when E − now < 2 × DAY.", applied(dec4), [
      nx(nov29, CLAIM, { random: 0.5 }),
      rec(nov29, refused(BOUND), false, { offersReplace: false, notice: "none" }),
      nx(nov30, NONE),
      nx(dec2 + 1, NONE, { offersReplace: true, notice: "waiting" }),
      { now: dec2 + 2, event: { type: "userRetry" } },
      nx(dec2 + 3, NONE),
      nx(dec2 + 4, NONE, { householdId: "h2" }),
    ]),
    claimScenario("bound-to-other-device with no E (a version 1 household): no automatic claim.", { ...empty, lastRefusal: BOUND }, [
      nx(nov10, NONE, { offersReplace: false }),
    ]),
    claimScenario("bound-to-other-device: once E has passed, one claim without replace, with current: true; refused as bound, at most once a day while lapsed; stop if E moves into the future.", applied(dec4), [
      nx(dec3 + 23 * HOUR, CLAIM, { random: 0 }),
      rec(dec3 + 23 * HOUR, refused(BOUND)),
      nx(dec4 + MIN, CURRENT, { offersReplace: false }),
      rec(dec4 + MIN, refused(BOUND), true, { offersReplace: true, notice: "waiting" }),
      nx(dec4 + 2 * HOUR, WAIT(dec5 + MIN)),
      nx(dec5 + MIN, CURRENT),
      rec(dec5 + MIN, refused(BOUND), true, { offersReplace: true }),
      obs(dec5 + 2 * HOUR, jan4, {}, { offersReplace: false, notice: "none", check: (s) => assert.ok(!s.lapsed && !s.lapseRefused) }),
      nx(dec5 + 3 * HOUR, NONE),
    ]),
    claimScenario("bound-to-other-device: once E has passed the old binding is usually stale and the claim with current: true binds this device without the rebind.", applied(dec4, { lastRefusal: BOUND }), [
      nx(dec4 + MIN, CURRENT),
      rec(dec4 + MIN, tok(DEC), true, { check: (s) => assert.equal(s.lastRefusal, null) }),
      obs(dec4 + 2 * MIN, jan4, { forced: DEC.raw }),
      nx(dec4 + 3 * MIN, WAIT(dec25), { random: 0 }),
    ]),
    claimScenario("bound-to-other-device: a 402 lapsed also counts as E having passed.", applied(dec4, { lastRefusal: BOUND }), [
      obs(dec3, dec4, { lapsed: true }),
      nx(dec3 + MIN, CURRENT),
    ]),
    claimScenario("bound-to-other-device is remembered until a claim succeeds, the credential is entered again or removed, or the device leaves: entering the code again claims by rule (b).", applied(dec4, { lastRefusal: BOUND }), [
      nx(nov29, NONE),
      { now: nov29, event: { type: "forgetClaims" } },
      nx(nov29 + MIN, CLAIM),
    ]),
    claimScenario("A code of an Institutions plan: the claim succeeds and the token's plan is not family; the client deletes the code, the claim secret and the token, and creates nothing.", { ...empty, entExp: dec4 }, [
      nx(nov10, CLAIM),
      rec(nov10, { kind: "not-family", plan: "inst-starter" }, false, { check: (s) => assert.deepEqual(s, { ...empty, entExp: dec4 }) }),
    ]),
    claimScenario("No X-Sitr-Entitlement-Expires header: a version 1 household. With a code it claims once by rule (b) (the claim service not deployed answers like no network) and then not again while it holds that token; again only after the held token's exp has passed.", empty, [
      obs(nov10, null, {}, { notice: "none" }),
      nx(nov10 + MIN, CLAIM),
      rec(nov10 + MIN, UNAVAILABLE),
      nx(nov10 + 6 * MIN, CLAIM),
      rec(nov10 + 6 * MIN, tok(NOV), false, { check: (s) => assert.ok(s.notBefore === null && forcesWrite(s)) }),
      nx(nov10 + 7 * MIN, NONE),
      obs(nov10 + 8 * MIN, null, { forced: NOV.raw }, { check: (s) => assert.ok(s.tokens.length === 1 && !forcesWrite(s)) }),
      nx(nov20, NONE, { notice: "none" }),
      obs(dec4, null, {}, { check: held(0) }),
      nx(dec4 + MIN, CLAIM),
    ]),
    claimScenario("No X-Sitr-Entitlement-Expires header on a successful round after E was known: a version 1 household, never lapsed, no notice; a failed round without it changes nothing.", applied(dec4, { lapsed: true }), [
      obs(dec10, null, { succeeded: false }, { notice: "waiting", check: (s) => assert.equal(s.entExp, dec4) }),
      obs(dec10 + MIN, null, {}, { notice: "none", check: (s) => assert.ok(s.entExp === null && !s.lapsed) }),
      nx(dec10 + 2 * MIN, NONE),
    ]),
    claimScenario("For a test household, (c) is instead \"when E is less than 1 hour away\" (strictly less: at midnight itself E is exactly an hour away); the 2-day notice does not apply.", empty, [
      rec(nov20 + 15 * HOUR, tok(TEST_20)),
      make(nov20 + 15 * HOUR + MIN, TEST_20, nov21 + HOUR),
      nx(nov20 + 16 * HOUR, WAIT(nov21 + 1), { notice: "none" }),
      nx(nov21, WAIT(nov21 + 1)),
      nx(nov21 + 1, CLAIM, { notice: "none" }),
      rec(nov21 + 1, tok(TEST_21), false, { check: held(1) }),
      obs(nov21 + MIN, nov22 + HOUR, { forced: TEST_21.raw }),
      nx(nov21 + 2 * MIN, WAIT(nov22 + 1)),
    ]),
    claimScenario("unknown-code, wrong-product, invalid-receipt, test-purchase, family-sharing, bad-request: show the reason and stop until the user acts (also when lapsed).", applied(dec4), [
      nx(nov29, CLAIM, { random: 0.5 }),
      rec(nov29, refused("unknown-code"), false, { check: (s) => assert.ok(s.stopped) }),
      nx(dec5, NONE),
      { now: dec5 + MIN, event: { type: "userRetry" } },
      nx(dec5 + 2 * MIN, CURRENT),
    ]),
  ];

  return {
    version: 1,
    note: "generated — edit tools/conformance, run npm run fixtures. Shape documented above genClaim() in tools/conformance/src/generate.ts. Replay each scenario step from its own `state`; compare decision and every result field. Tokens are minted with the TEST-ONLY key of entitlement.json; the client never checks signatures. Modules (extension): syncRefusals and the neutral \"waiting\" notice are householdEnd.ts (what a member device needs; the Safari App Store build ships only that); everything else is entitlement.ts. Rules for Polar clients only (extension, Android), which iOS may skip: codeInput; the not-family claim outcome and the Institutions scenario; the enter-code notice (scenarios with holdsCode false) and the legacyEnd field (iOS keeps it null and passes holdsCode true).",
    constants: {
      dayMs: DAY,
      hourMs: HOUR,
      firstBackoffMs: FIRST_BACKOFF_MS,
      maxBackoffMs: MAX_BACKOFF_MS,
      windowOpensDaysBeforeE: 10,
      windowNoDelayDaysBeforeE: 5,
      noticeDaysBeforeE: 2,
      legacyDays: 41,
    },
    tokens,
    codeInput,
    claimOutcomes,
    syncRefusals,
    scenarios,
  };
}

/* -------------------------------- main ---------------------------------- */

const outDir = outDirArg();
const files = new Map<string, object>([
  ["hkdf.json", await genHkdf()],
  ["blob.json", await genBlob()],
  ["pairing.json", genPairing()],
  ["crc16.json", genCrc16()],
  ["merge.json", await genMerge()],
  ["gate.json", genGate()],
  ["delay.json", genDelay()],
  ["sanitize.json", await genSanitize()],
  ["pin.json", await genPin()],
  ["entitlement.json", genEntitlement()],
  ["decision.json", genDecision()],
  ["claim.json", genClaim()],
]);

mkdirSync(outDir, { recursive: true });
for (const [name, body] of files) {
  writeFileSync(join(outDir, name), JSON.stringify(body, null, 2) + "\n", "utf8");
}
console.log(`wrote ${files.size} conformance fixture file(s) -> ${outDir}`);
