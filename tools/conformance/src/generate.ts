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
  gateMutation,
  type MutationKind,
} from "../../../extension/dist/lib/gate.js";
import { EMPTY_MANAGED_POLICY } from "../../../extension/dist/lib/managed.js";
import {
  backoffAfterFailure,
  hashPin,
  sanitizePinRecord,
  toB64,
  verifyPin,
  PIN_ITERATIONS,
} from "../../../extension/dist/lib/pin.js";
import { mintToken, privateKeyFromB64 } from "../../../server/sync/dist/mint.js";
import { EntitlementChecker } from "../../../server/sync/dist/entitlement.js";

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
    "enableCategory",
    "addDeviceBlockRule",
    "removeDeviceAllowRule",
    "addHouseholdRule",
    "changePin",
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
  return {
    version: 1,
    note: "generated — edit tools/conformance, run npm run fixtures. Exhaustive: every context x every mutation kind.",
    cases,
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
    ["not an object", "nope"],
    ["unknown version", { ...good, v: 2 }],
    ["missing rev", { v: 1 }],
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
    [true, true, true, true, true, true, false, false, false, false, false],
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
      checker.check(c.token === "" ? undefined : c.token, ENT_NOW).kind,
      c.outcome,
      c.name,
    );
    assert.equal(open.check(c.token, ENT_NOW).kind, "ok");
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

/* -------------------------------- main ---------------------------------- */

const outDir = outDirArg();
const files = new Map<string, object>([
  ["hkdf.json", await genHkdf()],
  ["blob.json", await genBlob()],
  ["pairing.json", genPairing()],
  ["crc16.json", genCrc16()],
  ["merge.json", await genMerge()],
  ["gate.json", genGate()],
  ["sanitize.json", await genSanitize()],
  ["pin.json", await genPin()],
  ["entitlement.json", genEntitlement()],
]);

mkdirSync(outDir, { recursive: true });
for (const [name, body] of files) {
  writeFileSync(join(outDir, name), JSON.stringify(body, null, 2) + "\n", "utf8");
}
console.log(`wrote ${files.size} conformance fixture file(s) -> ${outDir}`);
