/**
 * Entitlement minting — shared by the claim endpoint and the ops CLI.
 *
 * Run as a CLI:
 *   node dist/mint.js --keygen
 *     → prints a new Ed25519 keypair (base64 raw): private for the claim
 *       service, public for SITR_ENTITLEMENT_PUBKEY.
 *   SITR_ENTITLEMENT_PRIVKEY=<b64> node dist/mint.js --plan family --days 366
 *     → prints a signed token (manual issuance / support cases).
 */
import {
  createPrivateKey,
  generateKeyPairSync,
  sign as edSign,
  type KeyObject,
} from "node:crypto";
import { TOKEN_PREFIX, type EntitlementPayload } from "./entitlement.js";

/** PKCS8 DER prefix for a raw Ed25519 private key. */
const PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

export function privateKeyFromB64(b64: string): KeyObject {
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 32) {
    throw new Error("private key must be 32 bytes of base64");
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
const args = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (args.includes("--keygen")) {
    const kp = keygen();
    console.log(`SITR_ENTITLEMENT_PRIVKEY=${kp.privateB64}`);
    console.log(`SITR_ENTITLEMENT_PUBKEY=${kp.publicB64}`);
  } else {
    const priv = process.env["SITR_ENTITLEMENT_PRIVKEY"];
    if (priv === undefined) {
      console.error("set SITR_ENTITLEMENT_PRIVKEY or use --keygen");
      process.exit(1);
    }
    const plan = args[args.indexOf("--plan") + 1] ?? "family";
    const days = Number(args[args.indexOf("--days") + 1] ?? "366");
    const token = mintToken(
      privateKeyFromB64(priv),
      plan,
      Date.now() + days * 24 * 60 * 60 * 1000,
    );
    console.log(token);
  }
}
