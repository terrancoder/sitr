/**
 * DEVELOPMENT ONLY — a local claim server and sync server for iOS Debug
 * builds (docs/sync-protocol.md §How this is tested before Apple's setup
 * exists). Lives under tests/, so it is never part of the server build or
 * its Docker image.
 *
 * It trusts a TEST anchor (for example Xcode's StoreKit test certificate),
 * accepts only the environment `Xcode`, signs with a throwaway key made at
 * start-up, and runs a sync server holding the matching public key. Both
 * databases are in memory.
 *
 *   npm run build:server && npx tsc -p tests/tsconfig.json
 *   SITR_DEV_APPLE_ROOT_FINGERPRINT="AB:CD:…" \
 *   SITR_APPLE_BUNDLE_ID=com.example.sitr \
 *   SITR_APPLE_PRODUCTS=com.example.family.month=family:month \
 *   node --experimental-sqlite tests/dist/devClaimServer.js
 *
 * Optional: SITR_DEV_CLAIM_PORT (8788), SITR_DEV_SYNC_PORT (8787), and
 * SITR_DEV_APPLE_LEAF_OID / SITR_DEV_APPLE_INTERMEDIATE_OID (hex DER of the
 * OIDs the test chain carries, when they differ from Apple's).
 */
import { createServer } from "node:http";

import { AppleVerifier, APPLE_INTERMEDIATE_OID, APPLE_LEAF_OID } from "../../server/sync/dist/apple.js";
import { ClaimHandler, claimListener } from "../../server/sync/dist/claim.js";
import { ClaimStore } from "../../server/sync/dist/claim-store.js";
import { SyncHandler, syncListener } from "../../server/sync/dist/http.js";
import { SyncStore } from "../../server/sync/dist/store.js";
import { configFromEnv } from "../../server/sync/dist/config.js";
import { keygen } from "../../server/sync/dist/mint.js";
import { randomBytes } from "node:crypto";

const env = process.env;
const fingerprint = env["SITR_DEV_APPLE_ROOT_FINGERPRINT"];
if (fingerprint === undefined) {
  console.error("set SITR_DEV_APPLE_ROOT_FINGERPRINT to the test root's SHA-256 fingerprint");
  process.exit(1);
}
const oid = (v: string | undefined, dflt: Buffer) => (v ? Buffer.from(v, "hex") : dflt);
const kp = keygen();
const base = configFromEnv(env);
const claimConfig = { ...base, entitlementPrivKeyB64: kp.privateB64, claimKey: randomBytes(32) };
const syncConfig = { ...base, entitlementPubKeyB64: kp.publicB64, entitlementPrivKeyB64: undefined };
const apple = new AppleVerifier(
  {
    rootFingerprint256: fingerprint,
    leafOid: oid(env["SITR_DEV_APPLE_LEAF_OID"], APPLE_LEAF_OID),
    intermediateOid: oid(env["SITR_DEV_APPLE_INTERMEDIATE_OID"], APPLE_INTERMEDIATE_OID),
  },
  new Set(["Xcode"]),
);
const claims = new ClaimHandler(claimConfig, Date.now, fetch, { store: new ClaimStore(":memory:"), apple });
const sync = new SyncHandler(new SyncStore(":memory:"), syncConfig);
const claimPort = Number(env["SITR_DEV_CLAIM_PORT"] ?? 8788);
const syncPort = Number(env["SITR_DEV_SYNC_PORT"] ?? 8787);
createServer(claimListener(claims, false)).listen(claimPort, "127.0.0.1");
createServer(syncListener(sync, syncConfig)).listen(syncPort, "127.0.0.1");
console.log(`dev claim server http://127.0.0.1:${claimPort} (Xcode receipts, test anchor)`);
console.log(`dev sync server  http://127.0.0.1:${syncPort} (SITR_ENTITLEMENT_PUBKEY=${kp.publicB64})`);
