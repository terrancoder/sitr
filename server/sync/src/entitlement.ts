/**
 * Entitlement verification — offline Ed25519 signature checks.
 *
 * Design (docs/sync-protocol.md): the billing provider (Polar) NEVER enters
 * the sync path. At purchase time a token is minted (see claim endpoint /
 * mint.ts) and signed with our private key; this module verifies tokens
 * using only the public key — no network call, no lookup, no state. The
 * token carries no customer identity and is unlinkable to the household's
 * encryption keys.
 *
 * Token wire format: `sitr-ent-v1.<base64url(payload JSON)>.<base64url(sig)>`
 * payload: { v: 1, plan: "family", exp: <epoch ms> }
 * signature: Ed25519 over the exact payload bytes.
 * Version 2 (`sitr-ent-v2.`): same shape and key pair, payload as in
 * docs/sync-protocol.md §Entitlement version 2 → Token format.
 *
 * When no public key is configured (SITR_ENTITLEMENT_PUBKEY unset), every
 * request is entitled — so self-hosters run a free server by default and
 * the check exists only on infrastructure whose operator opts in.
 */
import { createPublicKey, verify as edVerify, type KeyObject } from "node:crypto";

export const TOKEN_PREFIX = "sitr-ent-v1";
export const TOKEN_PREFIX_V2 = "sitr-ent-v2";
export const DAY = 86_400_000;

export interface EntitlementPayload {
  v: 1;
  plan: string;
  exp: number;
}

/** docs/sync-protocol.md §Token format. Keys are signed in this order. */
export interface EntitlementPayloadV2 {
  v: 2;
  plan: "family" | "inst-starter" | "inst-standard";
  term: "month" | "year";
  per: number;
  exp: number;
  jti: string;
  test?: true;
}

/** A token whose signature and fields check out; time is not judged here. */
export type VerifiedToken =
  | { v: 1; payload: EntitlementPayload; payloadBytes: Buffer }
  | { v: 2; payload: EntitlementPayloadV2 };

export type VerifyResult =
  | { ok: true; token: VerifiedToken }
  | { ok: false; reason: "token-required" | "token-invalid" };

const PLANS = new Set(["family", "inst-starter", "inst-standard"]);

export function validPayloadV2(p: Partial<EntitlementPayloadV2>): p is EntitlementPayloadV2 {
  return (
    p.v === 2 &&
    typeof p.plan === "string" &&
    PLANS.has(p.plan) &&
    (p.term === "month" || p.term === "year") &&
    Number.isSafeInteger(p.per) &&
    Number.isSafeInteger(p.exp) &&
    p.per! % DAY === 0 &&
    p.per! < p.exp! &&
    typeof p.jti === "string" &&
    /^[A-Za-z0-9_-]{22}$/.test(p.jti) &&
    Buffer.from(p.jti, "base64url").length === 16 &&
    (p.test === undefined || p.test === true)
  );
}

export class EntitlementChecker {
  private readonly key: KeyObject | undefined;

  /** `pubKeyB64`: base64 of the 32-byte raw Ed25519 public key, or undefined. */
  constructor(pubKeyB64: string | undefined) {
    if (pubKeyB64 === undefined || pubKeyB64 === "") {
      this.key = undefined;
      return;
    }
    // SPKI DER prefix for Ed25519 + raw key — lets us accept a bare key.
    const raw = Buffer.from(pubKeyB64, "base64");
    if (raw.length !== 32) {
      throw new Error("SITR_ENTITLEMENT_PUBKEY must be 32 bytes of base64");
    }
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    this.key = createPublicKey({
      key: Buffer.concat([spkiPrefix, raw]),
      format: "der",
      type: "spki",
    });
  }

  get enforcing(): boolean {
    return this.key !== undefined;
  }

  /** Format, signature and fields of either version. Open mode: never call. */
  verify(header: string | undefined): VerifyResult {
    if (header === undefined || header === "") return { ok: false, reason: "token-required" };
    const invalid = { ok: false, reason: "token-invalid" } as const;
    if (this.key === undefined) return invalid;
    const parts = header.split(".");
    if (parts.length !== 3) return invalid;
    const version = parts[0] === TOKEN_PREFIX ? 1 : parts[0] === TOKEN_PREFIX_V2 ? 2 : 0;
    if (version === 0) return invalid;
    const payloadBytes = Buffer.from(parts[1]!, "base64url");
    const sig = Buffer.from(parts[2]!, "base64url");
    if (!edVerify(null, payloadBytes, this.key, sig)) return invalid;
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(payloadBytes.toString("utf8")) as Record<string, unknown>;
    } catch {
      return invalid;
    }
    if (typeof p !== "object" || p === null) return invalid;
    // A verifier refuses a token whose `v` does not match its prefix.
    if (version === 1) {
      if (p["v"] !== 1 || typeof p["exp"] !== "number") return invalid;
      return { ok: true, token: { v: 1, payload: p as unknown as EntitlementPayload, payloadBytes } };
    }
    if (!validPayloadV2(p as Partial<EntitlementPayloadV2>)) return invalid;
    return { ok: true, token: { v: 2, payload: p as unknown as EntitlementPayloadV2 } };
  }
}

export type CheckOutcome = { kind: "ok" } | { kind: "denied"; reason: string };

/**
 * Valid (either version, signature and fields) and not expired at `now`;
 * open mode accepts anything. Used by `mint.js --verify`, the conformance
 * fixture generator and the tests; the sync server applies the fuller
 * version 2 rules in http.ts.
 */
export function checkToken(c: EntitlementChecker, header: string | undefined, now: number): CheckOutcome {
  if (!c.enforcing) return { kind: "ok" };
  const r = c.verify(header);
  if (!r.ok) return { kind: "denied", reason: r.reason };
  return r.token.payload.exp > now ? { kind: "ok" } : { kind: "denied", reason: "token-expired" };
}
