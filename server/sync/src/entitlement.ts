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
 *
 * When no public key is configured (SITR_ENTITLEMENT_PUBKEY unset), every
 * request is entitled — so self-hosters run a free server by default and
 * the check exists only on infrastructure whose operator opts in.
 */
import { createPublicKey, verify as edVerify, type KeyObject } from "node:crypto";

export const TOKEN_PREFIX = "sitr-ent-v1";

export type EntitlementOutcome = { kind: "ok" } | { kind: "denied"; reason: string };

export interface EntitlementPayload {
  v: 1;
  plan: string;
  exp: number;
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

  check(header: string | undefined, now: number): EntitlementOutcome {
    if (this.key === undefined) return { kind: "ok" };
    if (header === undefined || header === "") {
      return { kind: "denied", reason: "entitlement required" };
    }
    const parts = header.split(".");
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
      return { kind: "denied", reason: "malformed entitlement token" };
    }
    let payloadBytes: Buffer;
    let sig: Buffer;
    try {
      payloadBytes = Buffer.from(parts[1]!, "base64url");
      sig = Buffer.from(parts[2]!, "base64url");
    } catch {
      return { kind: "denied", reason: "malformed entitlement token" };
    }
    if (!edVerify(null, payloadBytes, this.key, sig)) {
      return { kind: "denied", reason: "invalid entitlement signature" };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(payloadBytes.toString("utf8"));
    } catch {
      return { kind: "denied", reason: "malformed entitlement payload" };
    }
    const p = payload as Partial<EntitlementPayload>;
    if (p.v !== 1 || typeof p.exp !== "number") {
      return { kind: "denied", reason: "unsupported entitlement version" };
    }
    if (p.exp < now) {
      return { kind: "denied", reason: "entitlement expired — please renew" };
    }
    return { kind: "ok" };
  }
}

/** Back-compat shim for existing call sites/tests: open mode. */
export function checkEntitlement(_header: string | undefined): EntitlementOutcome {
  return { kind: "ok" };
}
