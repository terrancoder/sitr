/**
 * Guardian PIN — pure derivation and lockout policy (CLAUDE.md §9).
 *
 * The PIN is FRICTION, not security (threat-model.md): it stops a child
 * from casually loosening the filter in the options page. A determined
 * user with devtools access can read storage.local; that bypass is
 * accepted and documented — never overclaimed.
 *
 * Hashing: PBKDF2-SHA256 via WebCrypto (available in service workers,
 * extension pages, and Node ≥ 20 for tests). Salted per record.
 * Lockout: no delay for the first few attempts, then exponential backoff.
 * The attempt counter is persisted BEFORE reporting failure so a page
 * reload cannot reset it.
 */
import { type Result, err, ok } from "./result.js";

export const PIN_KEY = "guardianPin";
export const PIN_ATTEMPTS_KEY = "pinAttempts";

export const PIN_ITERATIONS = 600_000;
export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 32;

export interface PinRecord {
  v: 1;
  algo: "PBKDF2-SHA256";
  iterations: number;
  saltB64: string;
  hashB64: string;
}

export interface PinAttempts {
  count: number;
  /** Epoch ms until which verification is refused. 0 = not locked. */
  lockedUntil: number;
}

export const NO_ATTEMPTS: PinAttempts = { count: 0, lockedUntil: 0 };

const FREE_ATTEMPTS = 4;
const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 15 * 60_000;

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromB64(s: string): Result<Uint8Array, string> {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return ok(out);
  } catch {
    return err("invalid base64");
  }
}

export function sanitizePinRecord(raw: unknown): PinRecord | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  if (
    o["v"] === 1 &&
    o["algo"] === "PBKDF2-SHA256" &&
    typeof o["iterations"] === "number" &&
    Number.isInteger(o["iterations"]) &&
    o["iterations"] >= 1 &&
    typeof o["saltB64"] === "string" &&
    typeof o["hashB64"] === "string" &&
    fromB64(o["saltB64"]).ok &&
    fromB64(o["hashB64"]).ok
  ) {
    return {
      v: 1,
      algo: "PBKDF2-SHA256",
      iterations: o["iterations"],
      saltB64: o["saltB64"],
      hashB64: o["hashB64"],
    };
  }
  return undefined;
}

export function sanitizeAttempts(raw: unknown): PinAttempts {
  if (typeof raw !== "object" || raw === null) return NO_ATTEMPTS;
  const o = raw as Record<string, unknown>;
  const count = typeof o["count"] === "number" && Number.isInteger(o["count"]) && o["count"] >= 0
    ? o["count"]
    : 0;
  const lockedUntil =
    typeof o["lockedUntil"] === "number" && o["lockedUntil"] >= 0
      ? o["lockedUntil"]
      : 0;
  return { count, lockedUntil };
}

export function isValidPinInput(pin: string): Result<void, string> {
  if (pin.length < PIN_MIN_LENGTH || pin.length > PIN_MAX_LENGTH) {
    return err(
      `PIN must be ${PIN_MIN_LENGTH}–${PIN_MAX_LENGTH} characters`,
    );
  }
  return ok(undefined);
}

export async function hashPin(
  pin: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: salt as BufferSource,
      iterations,
    },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

export async function createPinRecord(pin: string): Promise<Result<PinRecord, string>> {
  const valid = isValidPinInput(pin);
  if (!valid.ok) return valid;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPin(pin, salt, PIN_ITERATIONS);
  return ok({
    v: 1,
    algo: "PBKDF2-SHA256",
    iterations: PIN_ITERATIONS,
    saltB64: toB64(salt),
    hashB64: toB64(hash),
  });
}

/** Constant-time-ish comparison; length leak is fine (fixed 32 bytes). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export async function verifyPin(
  pin: string,
  record: PinRecord,
): Promise<boolean> {
  const salt = fromB64(record.saltB64);
  const expected = fromB64(record.hashB64);
  if (!salt.ok || !expected.ok) return false;
  const got = await hashPin(pin, salt.value, record.iterations);
  return bytesEqual(got, expected.value);
}

/** Attempt state after one more failure at time `now`. */
export function backoffAfterFailure(count: number, now: number): PinAttempts {
  const next = count + 1;
  if (next <= FREE_ATTEMPTS) return { count: next, lockedUntil: 0 };
  const delay = Math.min(
    BASE_DELAY_MS * 2 ** (next - FREE_ATTEMPTS - 1),
    MAX_DELAY_MS,
  );
  return { count: next, lockedUntil: now + delay };
}

export function isLockedOut(
  attempts: PinAttempts,
  now: number,
): Result<void, { retryAt: number }> {
  if (attempts.lockedUntil > now) return err({ retryAt: attempts.lockedUntil });
  return ok(undefined);
}
