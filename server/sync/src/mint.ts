/**
 * Entitlement minting — shared by the claim endpoint and the ops CLI.
 *
 * Run as a CLI:
 *   node dist/mint.js --keygen
 *     → prints a new Ed25519 keypair (base64 raw): private for the claim
 *       service, public for SITR_ENTITLEMENT_PUBKEY.
 *   SITR_ENTITLEMENT_PRIVKEY=<b64> node dist/mint.js --plan family --days 7
 *     → prints a signed version 1 token (manual issuance / support cases).
 *       --days defaults to 7 and is refused above 7 unless --old-style-token
 *       is given: the sync server treats a token with more than 8 days left
 *       as an old-style token, which creates any number of legacy households
 *       until the cut-over.
 *   SITR_ENTITLEMENT_PUBKEY=<b64> node dist/mint.js --verify <token>
 *     → prints plan, term, exp and whether the token is valid now
 *       (Institutions proof tokens). Exit 0 valid, 1 invalid or expired,
 *       2 usage error, 3 no usable SITR_ENTITLEMENT_PUBKEY.
 */
import { parseArgs } from "node:util";
import {
  createPrivateKey,
  generateKeyPairSync,
  sign as edSign,
  type KeyObject,
} from "node:crypto";
import {
  DAY,
  EntitlementChecker,
  checkToken,
  TOKEN_PREFIX,
  TOKEN_PREFIX_V2,
  validPayloadV2,
  type EntitlementPayload,
  type EntitlementPayloadV2,
} from "./entitlement.js";

/** PKCS8 DER prefix for a raw Ed25519 private key. */
const PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

export function privateKeyFromB64(b64: string): KeyObject {
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 32) {
    throw new Error("SITR_ENTITLEMENT_PRIVKEY must be 32 bytes of base64");
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
}

export function mintToken(
  key: KeyObject,
  plan: string,
  expiresAt: number,
): string {
  const payload: EntitlementPayload = { v: 1, plan, exp: expiresAt };
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
  const sig = edSign(null, payloadBytes, key);
  return `${TOKEN_PREFIX}.${payloadBytes.toString("base64url")}.${sig.toString("base64url")}`;
}

/** Signs a version 2 token; the payload keys are written in the spec's order. */
export function mintTokenV2(key: KeyObject, fields: EntitlementPayloadV2): string {
  const { plan, term, per, exp, jti, test } = fields;
  const payload = { v: 2 as const, plan, term, per, exp, jti, ...(test === true ? { test } : {}) };
  if (!validPayloadV2(payload)) throw new Error("invalid version 2 payload");
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
  const sig = edSign(null, payloadBytes, key);
  return `${TOKEN_PREFIX_V2}.${payloadBytes.toString("base64url")}.${sig.toString("base64url")}`;
}

export function keygen(): { privateB64: string; publicB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privDer = privateKey.export({ format: "der", type: "pkcs8" });
  const pubDer = publicKey.export({ format: "der", type: "spki" });
  return {
    privateB64: Buffer.from(privDer.subarray(privDer.length - 32)).toString("base64"),
    publicB64: Buffer.from(pubDer.subarray(pubDer.length - 32)).toString("base64"),
  };
}

/* CLI */
if (import.meta.url === `file://${process.argv[1]}`) {
  const usage =
    "usage: mint.js --keygen | --verify <token> | [--plan family] [--days 1-7] [--old-style-token]";
  let values: { keygen?: boolean; verify?: string; plan: string; days: string; "old-style-token"?: boolean };
  try {
    values = parseArgs({
      options: {
        keygen: { type: "boolean" },
        verify: { type: "string" },
        plan: { type: "string", default: "family" },
        days: { type: "string", default: "7" },
        "old-style-token": { type: "boolean" },
      },
    }).values;
  } catch (e) {
    console.error(`${(e as Error).message}\n${usage}`);
    process.exit(2);
  }
  if (values.keygen) {
    const kp = keygen();
    console.log(`SITR_ENTITLEMENT_PRIVKEY=${kp.privateB64}`);
    console.log(`SITR_ENTITLEMENT_PUBKEY=${kp.publicB64}`);
  } else if (values.verify !== undefined) {
    // Without a usable key nothing can be verified: say so, with its own exit
    // code, rather than calling every token invalid.
    const pub = process.env["SITR_ENTITLEMENT_PUBKEY"] ?? "";
    let checker: EntitlementChecker | undefined;
    try {
      if (pub.trim() !== "") checker = new EntitlementChecker(pub);
    } catch {
      // malformed key: same message below
    }
    if (checker === undefined) {
      console.error("set SITR_ENTITLEMENT_PUBKEY to the 32-byte base64 public key to verify a token");
      process.exit(3);
    }
    const r = checker.verify(values.verify);
    if (!r.ok) {
      console.log(`invalid (${r.reason})`);
      process.exit(1);
    }
    const p = r.token.payload;
    const valid = checkToken(checker, values.verify, Date.now()).kind === "ok";
    console.log(`plan ${p.plan}`);
    console.log(`term ${"term" in p ? p.term : "-"}`);
    console.log(`exp ${new Date(p.exp).toISOString()}`);
    console.log(valid ? "valid now" : "not valid now (expired)");
    process.exit(valid ? 0 : 1);
  } else {
    const days = /^\d{1,5}$/.test(values.days) ? Number(values.days) : 0;
    if (days < 1) {
      console.error(`--days must be a whole number of days, at least 1\n${usage}`);
      process.exit(2);
    }
    if (days > 7 && !values["old-style-token"]) {
      console.error(
        "--days above 7 mints an old-style token: until the cut-over the sync server lets it\n" +
          "create any number of legacy households. Add --old-style-token if that is intended.",
      );
      process.exit(2);
    }
    let key: KeyObject;
    try {
      key = privateKeyFromB64(process.env["SITR_ENTITLEMENT_PRIVKEY"] ?? "");
    } catch {
      console.error("set SITR_ENTITLEMENT_PRIVKEY to the 32-byte base64 private key, or use --keygen");
      process.exit(1);
    }
    console.log(mintToken(key, values.plan, Date.now() + days * DAY));
  }
}
