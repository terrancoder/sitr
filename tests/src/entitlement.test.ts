import assert from "node:assert/strict";
import { test } from "node:test";

import { EntitlementChecker } from "../../server/sync/dist/entitlement.js";
import { keygen, mintToken, privateKeyFromB64 } from "../../server/sync/dist/mint.js";
import { SyncStore } from "../../server/sync/dist/store.js";
import { SyncHandler, type SyncRequest } from "../../server/sync/dist/http.js";
import { ClaimHandler } from "../../server/sync/dist/claim.js";
import { configFromEnv } from "../../server/sync/dist/config.js";

const NOW = 1_800_000_000_000;
const kp = keygen();
const priv = privateKeyFromB64(kp.privateB64);
const validToken = mintToken(priv, "family", NOW + 1000);

test("open mode: no public key configured accepts anything", () => {
  const open = new EntitlementChecker(undefined);
  assert.equal(open.enforcing, false);
  assert.deepEqual(open.check(undefined, NOW), { kind: "ok" });
  assert.deepEqual(open.check("garbage", NOW), { kind: "ok" });
});

test("enforcing mode: valid token passes, everything else is denied", () => {
  const checker = new EntitlementChecker(kp.publicB64);
  assert.equal(checker.enforcing, true);
  assert.deepEqual(checker.check(validToken, NOW), { kind: "ok" });
  assert.equal(checker.check(undefined, NOW).kind, "denied");
  assert.equal(checker.check("", NOW).kind, "denied");
  assert.equal(checker.check("sitr-ent-v1.only-two", NOW).kind, "denied");
  assert.equal(checker.check("wrong-prefix.a.b", NOW).kind, "denied");
});

test("expired tokens and foreign signatures are denied", () => {
  const checker = new EntitlementChecker(kp.publicB64);
  const expired = mintToken(priv, "family", NOW - 1);
  const denied = checker.check(expired, NOW);
  assert.equal(denied.kind, "denied");
  assert.match((denied as { reason: string }).reason, /expired/);

  const other = keygen();
  const forged = mintToken(privateKeyFromB64(other.privateB64), "family", NOW + 1000);
  assert.equal(checker.check(forged, NOW).kind, "denied");
});

test("tampered payload fails signature verification", () => {
  const checker = new EntitlementChecker(kp.publicB64);
  const parts = validToken.split(".");
  const tampered = Buffer.from(
    JSON.stringify({ v: 1, plan: "family", exp: NOW + 9e12 }),
  ).toString("base64url");
  assert.equal(checker.check(`${parts[0]}.${tampered}.${parts[2]}`, NOW).kind, "denied");
});

/* ------------------------- handler integration ------------------------- */

const ID = "0123456789abcdef0123456789abcdef";
const TOKEN = "a".repeat(64);

function put(entitlement?: string): SyncRequest {
  return {
    method: "PUT",
    path: `/v1/blob/${ID}`,
    ip: "203.0.113.7",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "if-none-match": "*",
      "x-sitr-entitlement": entitlement,
    },
    body: new Uint8Array([1]),
  };
}

function enforcingConfig() {
  return {
    ...configFromEnv({}),
    entitlementPubKeyB64: kp.publicB64,
    entitlementPrivKeyB64: kp.privateB64,
    polarAccessToken: "polar-test-token",
  };
}

test("household creation requires entitlement when enforcing; updates never do", () => {
  const h = new SyncHandler(new SyncStore(":memory:"), enforcingConfig(), () => NOW);
  assert.equal(h.handle(put()).status, 402);
  const created = h.handle(put(validToken));
  assert.equal(created.status, 201);
  // Subsequent update without a token: allowed (expiry never cuts off sync).
  const update: SyncRequest = {
    ...put(),
    headers: { authorization: `Bearer ${TOKEN}`, "if-match": '"1"' },
  };
  assert.equal(h.handle(update).status, 200);
});

test("claim endpoint exchanges a paid Polar checkout for a valid token", async () => {
  const fetchStub = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/v1/checkouts/paid-checkout")) {
      return new Response(JSON.stringify({ status: "succeeded" }), { status: 200 });
    }
    if (url.endsWith("/v1/checkouts/open-checkout")) {
      return new Response(JSON.stringify({ status: "open" }), { status: 200 });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  // The claim endpoint runs in its own process (claim-server.ts) so the
  // minting key never lives in the blob-parsing sync process.
  const h = new ClaimHandler(enforcingConfig(), () => NOW, fetchStub);

  const claim = (id: string): SyncRequest => ({
    method: "GET",
    path: `/v1/entitlement/claim/${id}`,
    ip: "203.0.113.9",
    headers: {},
    body: new Uint8Array(0),
  });

  const ok = await h.handleClaim(claim("paid-checkout"));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["Access-Control-Allow-Origin"], "https://sitrshield.com");
  const { token } = JSON.parse(new TextDecoder().decode(ok.body)) as { token: string };
  assert.deepEqual(new EntitlementChecker(kp.publicB64).check(token, NOW), { kind: "ok" });

  assert.equal((await h.handleClaim(claim("open-checkout"))).status, 402);
  assert.equal((await h.handleClaim(claim("nope"))).status, 404);
});

test("claim endpoint is 503 when billing is not configured", async () => {
  const h = new ClaimHandler(configFromEnv({}), () => NOW);
  const res = await h.handleClaim({
    method: "GET",
    path: "/v1/entitlement/claim/x",
    ip: "203.0.113.9",
    headers: {},
    body: new Uint8Array(0),
  });
  assert.equal(res.status, 503);
});
