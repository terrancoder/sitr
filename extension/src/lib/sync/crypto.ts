/**
 * Sync crypto — key derivation, blob sealing, pairing codes.
 * Pure given WebCrypto; makes no network calls (CLAUDE.md §9).
 *
 * Spec (normative, with test vectors): docs/sync-protocol.md. The server
 * never sees the root secret or the encryption key — only the derived
 * household id, the derived bearer credential, and an opaque AES-GCM blob.
 * The three derivations are independent HKDF outputs: knowing any one of
 * them reveals nothing about the others.
 */
import { type Result, err, ok } from "../result.js";
import {
  sanitizeHouseholdState,
  type HouseholdState,
} from "../household.js";

export const ROOT_SECRET_BYTES = 32;
export const BLOB_VERSION = 0x01;
export const MAX_BLOB_BYTES = 64 * 1024;

const HKDF_INFO_ENC = "sitr-sync v1 encryption key";
const HKDF_INFO_AUTH = "sitr-sync v1 auth credential";
const HKDF_INFO_ID = "sitr-sync v1 household id";
const AAD = new TextEncoder().encode("sitr-sync v1");

export interface HouseholdKeys {
  /** AES-256-GCM key for sealing/opening the state blob. */
  encKey: CryptoKey;
  /** Bearer credential sent to the server (which stores only its SHA-256). */
  authToken: string;
  /** URL path id for the household's blob. */
  householdId: string;
}

export function generateRootSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(ROOT_SECRET_BYTES));
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hkdf(
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

export async function deriveKeys(
  rootSecret: Uint8Array,
): Promise<Result<HouseholdKeys, string>> {
  if (rootSecret.length !== ROOT_SECRET_BYTES) {
    return err(`root secret must be ${ROOT_SECRET_BYTES} bytes`);
  }
  const encBytes = await hkdf(rootSecret, HKDF_INFO_ENC, 32);
  const authBytes = await hkdf(rootSecret, HKDF_INFO_AUTH, 32);
  const idBytes = await hkdf(rootSecret, HKDF_INFO_ID, 16);
  const encKey = await crypto.subtle.importKey(
    "raw",
    encBytes as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  return ok({
    encKey,
    authToken: toHex(authBytes),
    householdId: toHex(idBytes),
  });
}

/** Blob layout: version byte ‖ 12-byte nonce ‖ AES-GCM ciphertext. */
export async function sealState(
  state: HouseholdState,
  encKey: CryptoKey,
): Promise<Result<Uint8Array, string>> {
  const plaintext = new TextEncoder().encode(JSON.stringify(state));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, additionalData: AAD as BufferSource },
      encKey,
      plaintext as BufferSource,
    ),
  );
  const blob = new Uint8Array(1 + nonce.length + ct.length);
  blob[0] = BLOB_VERSION;
  blob.set(nonce, 1);
  blob.set(ct, 13);
  if (blob.length > MAX_BLOB_BYTES) {
    return err(`sealed blob exceeds ${MAX_BLOB_BYTES} bytes`);
  }
  return ok(blob);
}

export async function openState(
  blob: Uint8Array,
  encKey: CryptoKey,
): Promise<Result<HouseholdState, string>> {
  if (blob.length < 1 + 12 + 16) return err("blob too short");
  if (blob[0] !== BLOB_VERSION) {
    return err(`unknown blob version: ${String(blob[0])}`);
  }
  const nonce = blob.subarray(1, 13);
  const ct = blob.subarray(13);
  let plaintext: Uint8Array;
  try {
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce as BufferSource, additionalData: AAD as BufferSource },
        encKey,
        ct as BufferSource,
      ),
    );
  } catch {
    return err("blob failed authentication — wrong key or tampered data");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return err("decrypted blob is not valid JSON");
  }
  return sanitizeHouseholdState(parsed);
}

/* ------------------------- pairing codes -------------------------------- */

/** Crockford Base32 — no I, L, O, U; case-insensitive on decode. */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PAIR_VERSION = 0x01;

/** CRC-16/CCITT-FALSE over the payload, catches typos in manual entry. */
export function crc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function b32encode(bytes: Uint8Array): string {
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

function b32decode(s: string): Result<Uint8Array, string> {
  const normalized = s
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  let bits = 0;
  let acc = 0;
  const out: number[] = [];
  for (const ch of normalized) {
    const v = B32.indexOf(ch);
    if (v < 0) return err(`invalid pairing-code character: ${ch}`);
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return ok(new Uint8Array(out));
}

/**
 * Pairing code = Crockford-Base32(version ‖ rootSecret ‖ CRC-16),
 * grouped for readability. Possession of this code IS household
 * membership — it is shown only on the guardian's options page.
 */
export function encodePairingCode(rootSecret: Uint8Array): string {
  const payload = new Uint8Array(1 + rootSecret.length + 2);
  payload[0] = PAIR_VERSION;
  payload.set(rootSecret, 1);
  const crc = crc16(payload.subarray(0, 1 + rootSecret.length));
  payload[1 + rootSecret.length] = crc >>> 8;
  payload[2 + rootSecret.length] = crc & 0xff;
  const raw = b32encode(payload);
  return raw.match(/.{1,4}/g)?.join("-") ?? raw;
}

export function decodePairingCode(
  code: string,
): Result<Uint8Array, string> {
  const bytes = b32decode(code.replace(/[-\s]/g, ""));
  if (!bytes.ok) return bytes;
  const payload = bytes.value;
  if (payload.length < 1 + ROOT_SECRET_BYTES + 2) {
    return err("pairing code is too short");
  }
  if (payload[0] !== PAIR_VERSION) {
    return err("pairing code is from a newer version of Sitr");
  }
  const body = payload.subarray(0, 1 + ROOT_SECRET_BYTES);
  const expected = crc16(body);
  const got =
    ((payload[1 + ROOT_SECRET_BYTES] ?? 0) << 8) |
    (payload[2 + ROOT_SECRET_BYTES] ?? 0);
  if (expected !== got) {
    return err("pairing code check failed — please re-check the characters");
  }
  return ok(new Uint8Array(body.subarray(1)));
}
