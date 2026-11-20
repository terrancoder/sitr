/**
 * Entry point: node:http wiring around SyncHandler + hourly GC.
 * Run behind TLS (Caddy or similar); see server/sync/README.md.
 *
 * This process serves ONLY the blob API and holds ONLY the entitlement
 * public key. The claim endpoint — the one place the Ed25519 minting key
 * lives — runs as its own process (claim-server.ts), so a compromise of
 * the internet-facing blob parser never yields the minting key.
 */
import { createServer } from "node:http";
import { configFromEnv, type Config } from "./config.js";
import { SyncStore } from "./store.js";
import { SyncHandler, syncListener } from "./http.js";

let config: Config;
let store: SyncStore;
let handler: SyncHandler;
try {
  config = configFromEnv(process.env);
  try {
    store = new SyncStore(config.dbPath);
  } catch {
    throw new Error("SITR_SYNC_DB: cannot open or create the database (does its directory exist and is it writable?)");
  }
  handler = new SyncHandler(store, config);
} catch (e) {
  // Our own messages: they name variables, never values.
  console.error(`sitr-sync: ${(e as Error).message}`);
  process.exit(1);
}

const server = createServer(syncListener(handler, config));

setInterval(
  () => {
    store.gc(Date.now(), config.idleExpiryMs);
  },
  60 * 60 * 1000,
).unref();

server.listen(config.port, () => {
  // Startup line only — the server never logs requests.
  console.log(`sitr-sync listening on :${config.port}`);
});
