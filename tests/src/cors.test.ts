// CORS headers a browser extension needs where its host permission does not
// lift CORS (Safari's service worker): the claim POST and every sync answer.
// Node's fetch does not enforce CORS, so these tests check the headers a
// browser would act on, not a browser's behaviour.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { ClaimHandler, claimListener } from "../../server/sync/dist/claim.js";
import { ClaimStore } from "../../server/sync/dist/claim-store.js";
import { SyncHandler, syncListener } from "../../server/sync/dist/http.js";
import { SyncStore } from "../../server/sync/dist/store.js";
import { configFromEnv } from "../../server/sync/dist/config.js";
import { keygen, mintTokenV2, privateKeyFromB64 } from "../../server/sync/dist/mint.js";

const ORIGINS = ["safari-web-extension://0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9", "chrome-extension://abcdefghijklmnopabcdefghijklmnop"];
const DAY = 86_400_000;
const listen = (s: Server): Promise<string> =>
  new Promise((ok) => s.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const list = (v: string | null) => (v ?? "").split(",").map((x) => x.trim().toLowerCase());

test("sync: preflight answered without a bearer; every answer lets an extension read ETag and X-Sitr-Entitlement-Expires", async (ctx) => {
  const kp = keygen();
  const config = { ...configFromEnv({}), entitlementPubKeyB64: kp.publicB64 };
  const store = new SyncStore(":memory:");
  const server = createServer(syncListener(new SyncHandler(store, config), config));
  const base = await listen(server);
  ctx.after(() => {
    server.close();
    store.close();
  });
  const url = `${base}/v1/blob/${"c".repeat(32)}`;
  const auth = { Authorization: `Bearer ${"d".repeat(64)}` };
  const corsOk = (r: Response, what: string) => {
    assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*", what);
    assert.equal(r.headers.get("Access-Control-Allow-Credentials"), null, what);
    assert.deepEqual(list(r.headers.get("Access-Control-Expose-Headers")).sort(), ["etag", "x-sitr-entitlement-expires"], what);
  };

  for (const origin of ORIGINS) {
    const pre = await fetch(url, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "authorization,if-match,if-none-match,x-sitr-entitlement" },
    });
    assert.equal(pre.status, 204, origin);
    corsOk(pre, origin);
    for (const m of ["GET", "PUT", "DELETE"]) assert.ok(list(pre.headers.get("Access-Control-Allow-Methods")).includes(m.toLowerCase()), m);
    for (const h of ["authorization", "if-match", "if-none-match", "x-sitr-entitlement"]) {
      assert.ok(list(pre.headers.get("Access-Control-Allow-Headers")).includes(h), h);
    }
  }
  const origin = { Origin: ORIGINS[0]! };
  const exp = Date.now() + 2 * DAY;
  const token = mintTokenV2(privateKeyFromB64(kp.privateB64), { v: 2, plan: "family", term: "month", per: Math.floor(Date.now() / DAY) * DAY - DAY, exp, jti: Buffer.alloc(16, 5).toString("base64url") });
  const created = await fetch(url, { method: "PUT", headers: { ...origin, ...auth, "If-None-Match": "*", "X-Sitr-Entitlement": token }, body: new Uint8Array([1]) });
  assert.equal(created.status, 201);
  corsOk(created, "201");
  assert.equal(created.headers.get("X-Sitr-Entitlement-Expires"), String(exp));
  const got = await fetch(url, { headers: { ...origin, ...auth } });
  assert.equal(got.status, 200);
  corsOk(got, "GET");
  assert.equal(got.headers.get("ETag"), '"1"');
  assert.equal(got.headers.get("X-Sitr-Entitlement-Expires"), String(exp));
  // Error answers too, so the client reads the status instead of a network error.
  const conflict = await fetch(url, { method: "PUT", headers: { ...origin, ...auth, "If-Match": '"9"' }, body: new Uint8Array([1]) });
  assert.equal(conflict.status, 409);
  corsOk(conflict, "409");
  assert.equal(conflict.headers.get("ETag"), '"1"');
  const refused = await fetch(`${base}/v1/blob/${"e".repeat(32)}`, { method: "PUT", headers: { ...origin, ...auth, "If-None-Match": "*" }, body: new Uint8Array([1]) });
  assert.equal(refused.status, 402);
  corsOk(refused, "402");
  corsOk(await fetch(url, { headers: origin }), "401");
  corsOk(await fetch(url, { method: "PUT", headers: { ...origin, ...auth }, body: new Uint8Array(70 * 1024) }), "413");
});

test("sync: a lapsed household's 402 carries the end, readable cross-origin", async (ctx) => {
  const kp = keygen();
  const config = { ...configFromEnv({}), entitlementPubKeyB64: kp.publicB64 };
  const clock = { t: Date.parse("2030-03-10T00:00:00Z") };
  const store = new SyncStore(":memory:");
  const server = createServer(syncListener(new SyncHandler(store, config, () => clock.t), config));
  const base = await listen(server);
  ctx.after(() => {
    server.close();
    store.close();
  });
  const url = `${base}/v1/blob/${"f".repeat(32)}`;
  const auth = { Authorization: `Bearer ${"0".repeat(64)}`, Origin: ORIGINS[0]! };
  const exp = clock.t + DAY;
  const token = mintTokenV2(privateKeyFromB64(kp.privateB64), { v: 2, plan: "family", term: "month", per: clock.t - DAY, exp, jti: Buffer.alloc(16, 6).toString("base64url") });
  assert.equal((await fetch(url, { method: "PUT", headers: { ...auth, "If-None-Match": "*", "X-Sitr-Entitlement": token }, body: new Uint8Array([1]) })).status, 201);
  clock.t += 2 * DAY;
  const r = await fetch(url, { method: "PUT", headers: { ...auth, "If-Match": '"1"' }, body: new Uint8Array([2]) });
  assert.equal(r.status, 402);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*");
  assert.match(r.headers.get("Access-Control-Expose-Headers") ?? "", /X-Sitr-Entitlement-Expires/);
  assert.equal(r.headers.get("X-Sitr-Entitlement-Expires"), String(exp));
});

test("claim: POST preflight with Content-Type: application/json answered for any origin, without credentials; other routes keep the site's origin", async (ctx) => {
  const config = { ...configFromEnv({ SITR_POLAR_PRODUCTS: "p=family:month" }), entitlementPrivKeyB64: keygen().privateB64, claimKey: Buffer.alloc(32, 2), polarAccessToken: "t" };
  const fake = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
  const store = new ClaimStore(":memory:");
  const server = createServer(claimListener(new ClaimHandler(config, Date.now, fake, { store }), false));
  const base = await listen(server);
  ctx.after(() => {
    server.close();
    store.close();
  });
  for (const origin of ORIGINS) {
    const pre = await fetch(`${base}/v1/entitlement/claim`, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(pre.headers.get("Access-Control-Allow-Credentials"), null);
    assert.ok(list(pre.headers.get("Access-Control-Allow-Methods")).includes("post"));
    assert.ok(list(pre.headers.get("Access-Control-Allow-Headers")).includes("content-type"));
    // An error body is readable too.
    const r = await fetch(`${base}/v1/entitlement/claim`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ source: "polar", credential: "00000000-0000-4000-8000-000000000001", claim_secret: Buffer.alloc(32, 1).toString("base64url") }),
    });
    assert.deepEqual([r.status, r.headers.get("Access-Control-Allow-Origin"), await r.json()], [404, "*", { error: "unknown-code" }]);
  }
  const exchange = await fetch(`${base}/v1/entitlement/subscription/chk`, { method: "OPTIONS", headers: { Origin: ORIGINS[0]! } });
  assert.equal(exchange.headers.get("Access-Control-Allow-Origin"), "https://sitrshield.com");
});
