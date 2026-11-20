/**
 * Entry point for the claim service — the ONLY process that holds the
 * Ed25519 minting key (SITR_ENTITLEMENT_PRIVKEY), the claim key
 * (SITR_CLAIM_KEY), the Polar token and the claim database. Serves nothing
 * but /v1/entitlement/*. In production it is its own service on its own
 * hostname (server/sync/README.md); self-hosters may instead route that
 * path prefix here from a reverse proxy in front of both processes. The
 * sync process (server.ts) never sees any of these secrets.
 */
import { createServer } from "node:http";
import { checkClaimConfig, configFromEnv, type Config } from "./config.js";
import { ClaimHandler, claimListener } from "./claim.js";
import { guarded } from "./http.js";
import { ClaimStore } from "./claim-store.js";
import { APPLE_TRUST_ANCHOR, AppleVerifier } from "./apple.js";

let config: Config;
let store: ClaimStore | undefined;
let handler: ClaimHandler;
try {
  config = configFromEnv(process.env);
  checkClaimConfig(config);
  if (config.claimKey !== undefined) {
    try {
      store = new ClaimStore(config.claimDbPath);
    } catch {
      throw new Error("SITR_CLAIM_DB: cannot open or create the claim database (does its directory exist and is it writable?)");
    }
  }
  // The only place the production Apple verifier is built: Apple's pinned
  // root, Production, plus Sandbox when SITR_APPLE_SANDBOX=1. Never Xcode.
  const apple = new AppleVerifier(
    APPLE_TRUST_ANCHOR,
    new Set(config.appleSandbox ? ["Production", "Sandbox"] : ["Production"]),
  );
  handler = new ClaimHandler(config, Date.now, fetch, { ...(store ? { store } : {}), apple });
} catch (e) {
  // Our own messages: they name variables, never values.
  console.error(`sitr-claim: ${(e as Error).message}`);
  process.exit(1);
}

if (store !== undefined) {
  const prune = () =>
    guarded("sitr-claim", "hourly clean-up", () => store.prune(Date.now(), config.replacementDays, config.v1CutoverMs));
  prune(); // also at start-up, so v1_claims is emptied once the cut-over has passed
  setInterval(prune, 60 * 60 * 1000).unref();
}

createServer(claimListener(handler, config.trustedProxy)).listen(config.claimPort, () => {
  // Startup line only — the server never logs requests.
  console.log(`sitr-claim listening on :${config.claimPort}`);
});
