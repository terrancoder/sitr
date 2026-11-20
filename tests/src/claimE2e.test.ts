// End to end: claim → sync create → next month's claim → sync extend, with
// the claim and sync servers on their own local ports and their own
// database files, over real HTTP. Only the clock and Polar are faked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { ClaimHandler, claimListener } from "../../server/sync/dist/claim.js";
import { ClaimStore } from "../../server/sync/dist/claim-store.js";
import { SyncHandler, syncListener } from "../../server/sync/dist/http.js";
import { SyncStore } from "../../server/sync/dist/store.js";
import { configFromEnv } from "../../server/sync/dist/config.js";
import { keygen } from "../../server/sync/dist/mint.js";

const SUB = "6f1c2a3b-1d2e-4f50-8a9b-0c1d2e3f4a5b";
const listen = (s: Server): Promise<string> =>
  new Promise((ok) => s.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

test("claim → create → next month's claim → extend, across two processes' servers", async (ctx) => {
  const dir = mkdtempSync(join(tmpdir(), "sitr-e2e-"));
  const kp = keygen();
  const clock = { t: Date.parse("2026-11-20T12:00:00Z") };
  const base = configFromEnv({ SITR_POLAR_PRODUCTS: "prod_y=family:year" });

  // Claim process: private key, claim key, its own database.
  const claimStore = new ClaimStore(join(dir, "claim.sqlite"));
  const polar = (async () =>
    new Response(
      JSON.stringify({ status: "active", product_id: "prod_y", recurring_interval: "year", current_period_end: "2027-06-01T00:00:00Z" }),
    )) as unknown as typeof fetch;
  const claimHandler = new ClaimHandler(
    { ...base, entitlementPrivKeyB64: kp.privateB64, polarAccessToken: "t", claimKey: Buffer.alloc(32, 4) },
    () => clock.t,
    polar,
    { store: claimStore },
  );
  // Sync process: public key only, its own database.
  const syncStore = new SyncStore(join(dir, "sync.sqlite"));
  const syncConfig = { ...base, entitlementPubKeyB64: kp.publicB64 };
  const syncHandler = new SyncHandler(syncStore, syncConfig, () => clock.t);

  const claimServer = createServer(claimListener(claimHandler, false));
  const syncServer = createServer(syncListener(syncHandler, syncConfig));
  const [claimUrl, syncUrl] = await Promise.all([listen(claimServer), listen(syncServer)]);
  ctx.after(() => {
    claimServer.close();
    syncServer.close();
    claimStore.close();
    syncStore.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const claimSecret = Buffer.alloc(32, 8).toString("base64url");
  const claim = async (): Promise<string> => {
    const r = await fetch(`${claimUrl}/v1/entitlement/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "polar", credential: SUB, claim_secret: claimSecret }),
    });
    assert.equal(r.status, 200);
    return ((await r.json()) as { token: string }).token;
  };
  const blob = `${syncUrl}/v1/blob/${"ab".repeat(16)}`;
  const auth = { Authorization: `Bearer ${"c".repeat(64)}` };

  const nov = await claim();
  const created = await fetch(blob, {
    method: "PUT",
    headers: { ...auth, "If-None-Match": "*", "X-Sitr-Entitlement": nov },
    body: "household",
  });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("X-Sitr-Entitlement-Expires"), String(Date.parse("2026-12-04")));

  clock.t = Date.parse("2026-11-26T09:00:00Z"); // renewal window
  const dec = await claim();
  assert.notEqual(dec, nov);
  const extended = await fetch(blob, {
    method: "PUT",
    headers: { ...auth, "If-Match": created.headers.get("ETag")!, "X-Sitr-Entitlement": dec },
    body: "household v2",
  });
  assert.equal(extended.status, 200);
  assert.equal(extended.headers.get("X-Sitr-Entitlement-Expires"), String(Date.parse("2027-01-04")));

  // A retry gets the same token, which the sync server now ignores.
  assert.equal(await claim(), dec);
  const again = await fetch(blob, {
    method: "PUT",
    headers: { ...auth, "If-Match": extended.headers.get("ETag")!, "X-Sitr-Entitlement": dec },
    body: "household v3",
  });
  assert.equal(again.status, 200);
  assert.equal(again.headers.get("X-Sitr-Entitlement-Expires"), String(Date.parse("2027-01-04")));
});
