/**
 * DEVELOPMENT ONLY — a local claim server and sync server for iOS Debug
 * builds (docs/sync-protocol.md §How this is tested before Apple's setup
 * exists). Lives under tests/, so it is never part of the server build or
 * its Docker image, and the deployed entry points never read its settings.
 *
 * It trusts Xcode's StoreKit test certificate (Xcode signs local StoreKit
 * transactions with it; Apple documents it as a root with no chain),
 * accepts only the environment `Xcode`, whose tokens carry `test: true`
 * like Sandbox ones, signs with a throwaway key made at start-up, and runs
 * a sync server holding the matching public key. Both databases are in
 * memory.
 *
 * Getting the certificate (owner, once, in Xcode):
 *   1. In the Project navigator, select apps/ios/Configs/Sitr.storekit.
 *   2. Choose Editor > Save Public Certificate and save it as StoreKitTestCertificate.cer.
 *   3. Pass that file's path below (keep it out of the repository).
 *
 *   npm run build:server && npx tsc -p tests/tsconfig.json
 *   SITR_APPLE_BUNDLE_ID=com.example.sitr \
 *   SITR_APPLE_PRODUCTS=com.example.family.month=family:month \
 *   node --experimental-sqlite tests/dist/devClaimServer.js /path/to/StoreKitTestCertificate.cer
 *
 * The path may instead be given as SITR_DEV_STOREKIT_CERT. Optional:
 * SITR_DEV_CLAIM_PORT (8788), SITR_DEV_SYNC_PORT (8787).
 *
 * Still to confirm against a real Xcode receipt: the x5c chain may hold 1
 * to 3 certificates and must end in exactly this certificate.
 */
import { createServer } from "node:http";
import { X509Certificate, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { AppleVerifier } from "../../server/sync/dist/apple.js";
import { ClaimHandler, claimListener } from "../../server/sync/dist/claim.js";
import { ClaimStore } from "../../server/sync/dist/claim-store.js";
import { SyncHandler, syncListener } from "../../server/sync/dist/http.js";
import { SyncStore } from "../../server/sync/dist/store.js";
import { configFromEnv } from "../../server/sync/dist/config.js";
import { keygen } from "../../server/sync/dist/mint.js";

const env = process.env;
const certPath = process.argv[2] ?? env["SITR_DEV_STOREKIT_CERT"];
let testRoot: X509Certificate;
try {
  if (certPath === undefined || certPath === "") throw new Error("no path given");
  testRoot = new X509Certificate(readFileSync(certPath)); // DER (.cer) or PEM
} catch {
  console.error(
    "devClaimServer: StoreKit test certificate missing or unreadable. In Xcode select " +
      "apps/ios/Configs/Sitr.storekit, choose Editor > Save Public Certificate, then pass the " +
      "saved StoreKitTestCertificate.cer path as the first argument or as SITR_DEV_STOREKIT_CERT.",
  );
  process.exit(1);
}
const kp = keygen();
const base = configFromEnv(env);
const claimConfig = { ...base, entitlementPrivKeyB64: kp.privateB64, claimKey: randomBytes(32) };
const syncConfig = { ...base, entitlementPubKeyB64: kp.publicB64, entitlementPrivKeyB64: undefined };
// Environment `Xcode` is not `Production`, so the claim handler treats it as
// Sandbox: source apple-sandbox, `test: true`, no binding.
const apple = new AppleVerifier({ testRoot }, new Set(["Xcode"]));
const claims = new ClaimHandler(claimConfig, Date.now, fetch, { store: new ClaimStore(":memory:"), apple });
const sync = new SyncHandler(new SyncStore(":memory:"), syncConfig);
const claimPort = Number(env["SITR_DEV_CLAIM_PORT"] ?? 8788);
const syncPort = Number(env["SITR_DEV_SYNC_PORT"] ?? 8787);
createServer(claimListener(claims, false)).listen(claimPort, "127.0.0.1");
createServer(syncListener(sync, syncConfig)).listen(syncPort, "127.0.0.1");
console.log(`dev claim server http://127.0.0.1:${claimPort} (Xcode receipts, StoreKit test certificate)`);
console.log(`dev sync server  http://127.0.0.1:${syncPort} (SITR_ENTITLEMENT_PUBKEY=${kp.publicB64})`);
