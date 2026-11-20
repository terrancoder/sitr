// Apple verification (steps 1 to 19) and App Store Server Notifications:
// docs/sync-protocol.md §Claim API → Apple verification, Revocation.
// Chains come from tests/fixtures/apple (TEST-ONLY keys, see gen.sh).
import assert from "node:assert/strict";
import { test } from "node:test";
import { X509Certificate, createPrivateKey, sign } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import {
  AppleVerifier,
  APPLE_INTERMEDIATE_OID,
  APPLE_LEAF_OID,
  APPLE_TRUST_ANCHOR,
  extensionOids,
} from "../../server/sync/dist/apple.js";
import { ClaimHandler, claimListener, deriveRevokedTx } from "../../server/sync/dist/claim.js";
import { ClaimStore } from "../../server/sync/dist/claim-store.js";
import { configFromEnv } from "../../server/sync/dist/config.js";
import { keygen } from "../../server/sync/dist/mint.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-20T12:00:00Z");
const pem = (n: string): Buffer => readFileSync(new URL(`../fixtures/apple/${n}.pem`, import.meta.url));
const cert = (n: string): X509Certificate => new X509Certificate(pem(n));
const der64 = (n: string): string => cert(n).raw.toString("base64");
const b64u = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");

const ANCHOR = {
  rootFingerprint256: cert("root").fingerprint256,
  leafOid: APPLE_LEAF_OID,
  intermediateOid: APPLE_INTERMEDIATE_OID,
};

function jws(
  payload: unknown,
  o: { chain?: [string, string, string]; alg?: string; x5c?: unknown; key?: string } = {},
): string {
  const chain = o.chain ?? ["leaf", "inter", "root"];
  const h = b64u({ alg: o.alg ?? "ES256", x5c: o.x5c ?? chain.map(der64) });
  const p = b64u(payload);
  const key = createPrivateKey(pem(`${o.key ?? chain[0]}-key`));
  const sig = sign("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" });
  return `${h}.${p}.${sig.toString("base64url")}`;
}

const BUNDLE = "com.example.sitr";
function tx(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bundleId: BUNDLE,
    environment: "Production",
    productId: "com.example.family.month",
    originalTransactionId: "2000000123456789",
    transactionId: "2000000999",
    storefront: "DEU",
    price: 4990,
    expiresDate: NOW + 20 * DAY,
    inAppOwnershipType: "PURCHASED",
    signedDate: NOW,
    ...over,
  };
}

const verifier = new AppleVerifier(ANCHOR, new Set(["Production"]));

/* ------------------------------ steps 1–11 ------------------------------ */

test("a well-formed test chain verifies; the DER reader finds both OIDs", () => {
  assert.equal(verifier.verify(jws(tx()))?.["originalTransactionId"], "2000000123456789");
  assert.ok(extensionOids(cert("leaf").raw).some((o) => o.equals(APPLE_LEAF_OID)));
  assert.ok(extensionOids(cert("inter").raw).some((o) => o.equals(APPLE_INTERMEDIATE_OID)));
  assert.ok(!extensionOids(cert("leaf_nooid").raw).some((o) => o.equals(APPLE_LEAF_OID)));
});

test("each of steps 1 to 11 fails once", () => {
  const good = jws(tx());
  const [h, p, s] = good.split(".") as [string, string, string];
  const flipped = Buffer.from(s, "base64url");
  flipped[10] = flipped[10]! ^ 1;
  const cases: [string, string][] = [
    ["1 two parts", `${h}.${p}`],
    ["2 alg ES384", jws(tx(), { alg: "ES384" })],
    ["2 alg none", jws(tx(), { alg: "none" })],
    ["3 x5c of 2", jws(tx(), { x5c: [der64("leaf"), der64("inter")] })],
    ["3 x5c base64url, not base64", jws(tx(), { x5c: ["leaf", "inter", "root"].map((n) => cert(n).raw.toString("base64url") + "-_") })],
    ["3 x5c not a certificate", jws(tx(), { x5c: ["AAAA", der64("inter"), der64("root")] })],
    ["4 signedDate missing", jws(tx({ signedDate: undefined }))],
    ["4 signedDate a string", jws(tx({ signedDate: String(NOW) }))],
    ["5 leaf expired at signedDate", jws(tx(), { chain: ["leaf_expired", "inter", "root"] })],
    ["5 signedDate before the chain", jws(tx({ signedDate: Date.parse("2019-06-01") }))],
    ["6 other root", jws(tx(), { chain: ["leaf_other", "inter2", "root2"] })],
    ["7 intermediate not issued by root", jws(tx(), { chain: ["leaf", "inter2", "root"] })],
    ["8 leaf not issued by intermediate", jws(tx(), { chain: ["leaf_other", "inter", "root"] })],
    ["9 leaf is a CA", jws(tx(), { chain: ["leaf_ca", "inter", "root"] })],
    ["10 leaf without OID", jws(tx(), { chain: ["leaf_nooid", "inter", "root"] })],
    ["10 intermediate without OID", jws(tx(), { chain: ["leaf_under_nooid", "inter_nooid", "root"] })],
    ["11 P-384 leaf", jws(tx(), { chain: ["leaf_p384", "inter", "root"] })],
    ["11 bad signature", `${h}.${p}.${flipped.toString("base64url")}`],
    ["11 signature not 64 bytes", `${h}.${p}.${s}AA`],
    ["11 payload changed", `${h}.${b64u(tx({ expiresDate: NOW + 900 * DAY }))}.${s}`],
  ];
  for (const [name, token] of cases) assert.equal(verifier.verify(token), null, name);
  // The expired leaf is refused because of the date, not the chain.
  assert.ok(verifier.verify(jws(tx({ signedDate: Date.parse("2020-06-01") }), { chain: ["leaf_expired", "inter", "root"] })));
});

test("the pinned Apple root: the repository's file matches the constant", () => {
  const apple = new X509Certificate(readFileSync(new URL("../../server/sync/certs/AppleRootCA-G3.cer", import.meta.url)));
  assert.equal(apple.fingerprint256, APPLE_TRUST_ANCHOR.rootFingerprint256);
  assert.equal(apple.subject, "CN=Apple Root CA - G3\nOU=Apple Certification Authority\nO=Apple Inc.\nC=US");
  assert.equal(apple.issuer, apple.subject);
  assert.ok(apple.checkIssued(apple) && apple.verify(apple.publicKey)); // self-signed
  assert.equal(apple.ca, true);
  assert.equal(apple.validFromDate.toISOString(), "2014-04-30T18:19:06.000Z");
  assert.equal(apple.validToDate.toISOString(), "2039-04-30T18:19:06.000Z");
});

test("the production anchor refuses every test chain: none chains to Apple's root", () => {
  const prod = new AppleVerifier(APPLE_TRUST_ANCHOR, new Set(["Production", "Sandbox"]));
  for (const chain of [["leaf", "inter", "root"], ["leaf_other", "inter2", "root2"]] as [string, string, string][]) {
    assert.equal(prod.verify(jws(tx(), { chain })), null);
  }
});

/* ---------------------- payload rules 12–19, via claims ----------------- */

const SECRET = Buffer.alloc(32, 1).toString("base64url");
function setup(opts: { sandbox?: boolean; envs?: string[]; db?: string; anchor?: ConstructorParameters<typeof AppleVerifier>[0] } = {}) {
  const kp = keygen();
  const store = new ClaimStore(opts.db ?? ":memory:");
  const config = {
    ...configFromEnv({
      SITR_APPLE_BUNDLE_ID: BUNDLE,
      SITR_APPLE_PRODUCTS:
        "com.example.family.month=family:month,com.example.family.year=family:year,com.example.inst=inst-starter:year",
    }),
    entitlementPrivKeyB64: kp.privateB64,
    claimKey: Buffer.alloc(32, 9),
  };
  const envs = opts.envs ?? (opts.sandbox ? ["Production", "Sandbox"] : ["Production"]);
  const clock = { t: NOW };
  const h = new ClaimHandler(config, () => clock.t, fetch, {
    store,
    apple: new AppleVerifier(opts.anchor ?? ANCHOR, new Set(envs)),
  });
  const claim = async (credential: string, secret = SECRET) => {
    const r = await h.handle({
      method: "POST",
      path: "/v1/entitlement/claim",
      ip: "203.0.113.5",
      headers: {},
      body: new TextEncoder().encode(JSON.stringify({ source: "apple", credential, claim_secret: secret })),
    });
    return { status: r.status, body: JSON.parse(new TextDecoder().decode(r.body)) as Record<string, unknown> };
  };
  const notify = async (payload: unknown) =>
    (
      await h.handle({
        method: "POST",
        path: "/v1/entitlement/apple/notifications",
        ip: "203.0.113.6",
        headers: {},
        body: new TextEncoder().encode(JSON.stringify({ signedPayload: jws(payload) })),
      })
    ).status;
  const rows = () => store.db.prepare("SELECT * FROM markers").all() as Record<string, unknown>[];
  const revoked = () => store.db.prepare("SELECT * FROM revoked_transactions").all() as Record<string, unknown>[];
  return { h, store, clock, claim, notify, rows, revoked, config };
}
const payloadOf = (token: unknown): Record<string, unknown> =>
  JSON.parse(Buffer.from(String(token).split(".")[1]!, "base64url").toString());

test("payload rules: bundle, environment (Xcode always refused), product, ownership, revocation, expiry", async () => {
  const s = setup();
  const ok = await s.claim(jws(tx()));
  assert.equal(ok.status, 200);
  assert.equal(payloadOf(ok.body["token"])["plan"], "family");
  const cases: [string, Record<string, unknown>, number, string][] = [
    ["bundle", { bundleId: "com.other" }, 422, "invalid-receipt"],
    ["Xcode", { environment: "Xcode" }, 422, "test-purchase"],
    ["local testing", { environment: "LocalTesting" }, 422, "test-purchase"],
    ["Sandbox while off", { environment: "Sandbox" }, 422, "test-purchase"],
    ["product", { productId: "com.example.unknown" }, 422, "wrong-product"],
    ["family sharing", { inAppOwnershipType: "FAMILY_SHARED" }, 422, "family-sharing"],
    ["revocationDate", { revocationDate: NOW - DAY }, 402, "revoked"],
    ["expired", { expiresDate: NOW }, 402, "inactive"],
    ["no originalTransactionId", { originalTransactionId: undefined }, 422, "invalid-receipt"],
    ["no transactionId", { transactionId: undefined }, 422, "invalid-receipt"],
  ];
  for (const [name, over, status, error] of cases) {
    const r = await s.claim(jws(tx(over)), Buffer.alloc(32, 2).toString("base64url"));
    assert.deepEqual([r.status, r.body["error"]], [status, error], name);
  }
  assert.deepEqual((await s.claim("not.a.jws")).body, { error: "invalid-receipt" });
  // Institutions product through the same route.
  const inst = await s.claim(jws(tx({ productId: "com.example.inst", originalTransactionId: "2000000777" })));
  assert.deepEqual([payloadOf(inst.body["token"])["plan"], payloadOf(inst.body["token"])["term"]], ["inst-starter", "year"]);
});

test("Sandbox on: daily test tokens, no binding, nothing stored", async () => {
  const s = setup({ sandbox: true });
  const sb = jws(tx({ environment: "Sandbox" }));
  const a = await s.claim(sb);
  const b = await s.claim(sb, Buffer.alloc(32, 5).toString("base64url"));
  assert.equal(a.status, 200);
  assert.equal(b.status, 200); // a second device: no bound-to-other-device
  const p = payloadOf(a.body["token"]);
  assert.equal(p["test"], true);
  assert.deepEqual([p["per"], p["exp"]], [Date.parse("2026-11-20"), Date.parse("2026-11-21T01:00:00Z")]);
  assert.equal((await s.claim(sb)).body["token"], a.body["token"]); // same secret, same day
  assert.deepEqual(s.rows(), []);
  s.clock.t = Date.parse("2026-11-21T00:10:00Z");
  const next = payloadOf((await s.claim(jws(tx({ environment: "Sandbox", signedDate: s.clock.t })))).body["token"]);
  assert.equal(next["exp"], Date.parse("2026-11-22T01:00:00Z"));
});

test("dev anchor may accept Xcode; the production builder never does (claim-server.ts)", async () => {
  const s = setup({ envs: ["Xcode"] });
  const r = await s.claim(jws(tx({ environment: "Xcode" })));
  assert.equal(r.status, 200);
  assert.equal(payloadOf(r.body["token"])["test"], true);
  const src = readFileSync(new URL("../../server/sync/src/claim-server.ts", import.meta.url), "utf8");
  assert.ok(!src.includes('"Xcode"'));
});

/* ------------------------------ notifications --------------------------- */

const note = (type: string, txOver: Record<string, unknown> = {}, env = "Production") => ({
  notificationType: type,
  notificationUUID: "uuid-not-stored",
  signedDate: NOW,
  data: { bundleId: BUNDLE, environment: env, signedTransactionInfo: jws(tx({ environment: env, ...txOver })) },
});

const MONTH = "com.example.family.month";
const YEAR = "com.example.family.year";

test("revocation is per transaction: a refunded yearly purchase does not block a new monthly one", async () => {
  const s = setup();
  const yearly = { transactionId: "T-YEAR", productId: YEAR, expiresDate: NOW + 365 * DAY };
  assert.equal(await s.notify(note("REFUND", yearly)), 200);
  assert.deepEqual((await s.claim(jws(tx(yearly)))).body, { error: "revoked" }); // replay of the refunded receipt
  // Same originalTransactionId, new monthly purchase: its own transaction, not refunded.
  const monthly = await s.claim(jws(tx({ transactionId: "T-MONTH", productId: MONTH, expiresDate: NOW + 30 * DAY })));
  assert.equal(monthly.status, 200);
});

test("REFUND / REVOKE store one keyed hash per transaction; replay refused; renewal and other product pass; idempotent", async () => {
  const s = setup();
  assert.equal(await s.notify(note("REFUND", { transactionId: "T1" })), 200);
  assert.equal(await s.notify(note("REFUND", { transactionId: "T1" })), 200);
  assert.deepEqual(s.rows(), []); // a notification creates no marker
  const rows = s.revoked();
  assert.equal(rows.length, 1);
  assert.deepEqual(new Uint8Array(rows[0]!["tx_hash"] as Uint8Array), new Uint8Array(deriveRevokedTx(s.config.claimKey!, "apple", "T1")));
  assert.equal(rows[0]!["exp"], NOW + 20 * DAY);
  // REVOKE of the same transaction with an earlier expiry keeps the later one.
  assert.equal(await s.notify(note("REVOKE", { transactionId: "T1", expiresDate: NOW + DAY })), 200);
  assert.equal(s.revoked()[0]!["exp"], NOW + 20 * DAY);
  assert.deepEqual((await s.claim(jws(tx({ transactionId: "T1" })))).body, { error: "revoked" });
  assert.equal((await s.claim(jws(tx({ transactionId: "T2", expiresDate: NOW + 50 * DAY })))).status, 200); // renewal
  const other = await s.claim(jws(tx({ transactionId: "T3", productId: "com.example.inst", originalTransactionId: "2000000777" })));
  assert.equal(other.status, 200);
  assert.equal((await s.claim(jws(tx({ transactionId: "T4", productId: YEAR })))).status, 200); // other product, same subscription
});

test("REFUND_REVERSED lifts only its own transaction's block", async () => {
  const s = setup();
  assert.equal(await s.notify(note("REFUND", { transactionId: "T1" })), 200);
  assert.equal(await s.notify(note("REFUND", { transactionId: "T2" })), 200);
  assert.equal(await s.notify(note("REFUND_REVERSED", { transactionId: "T1" })), 200);
  assert.equal((await s.claim(jws(tx({ transactionId: "T1" })))).status, 200);
  assert.deepEqual((await s.claim(jws(tx({ transactionId: "T2" })))).body, { error: "revoked" });
  assert.deepEqual(s.revoked().map((r) => r["revoked"]).sort(), [0, 1]); // T1 kept as reversed, until its expiry
});

test("revoked transactions are pruned once their expiresDate has passed", async () => {
  const s = setup();
  await s.notify(note("REFUND", { transactionId: "T1", expiresDate: NOW + 20 * DAY }));
  await s.notify(note("REFUND", { transactionId: "T2", expiresDate: NOW + 40 * DAY }));
  s.store.prune(NOW + 20 * DAY - 1, 180);
  assert.equal(s.revoked().length, 2);
  s.store.prune(NOW + 20 * DAY, 180);
  assert.equal(s.revoked().length, 1);
  s.store.prune(NOW + 40 * DAY, 180);
  assert.equal(s.revoked().length, 0);
});

test("no raw transaction ID or original transaction ID anywhere in the claim database files", async (ctx) => {
  const dir = mkdtempSync(join(tmpdir(), "sitr-revoked-"));
  ctx.after(() => rmSync(dir, { recursive: true, force: true }));
  const s = setup({ db: join(dir, "claims.sqlite") });
  await s.notify(note("REFUND", { transactionId: "RAWTX-4711-REFUNDED" }));
  assert.equal((await s.claim(jws(tx({ transactionId: "RAWTX-4712-CLAIMED" })))).status, 200);
  s.store.close();
  const bytes = Buffer.concat(readdirSync(dir).map((f) => readFileSync(join(dir, f))));
  for (const needle of ["RAWTX-4711-REFUNDED", "RAWTX-4712-CLAIMED", "2000000123456789"]) {
    assert.equal(bytes.indexOf(needle), -1, needle);
  }
});

test("a fault of the verifier itself is thrown, not reported as a bad receipt; the listener answers 500 and logs no request data", async (ctx) => {
  const broken = new AppleVerifier({ ...ANCHOR, leafOid: undefined as unknown as Buffer }, new Set(["Production"]));
  const credential = jws(tx());
  assert.throws(() => broken.verify(credential), TypeError);
  assert.equal(broken.verify("not.a.jws"), null); // a bad receipt is still just refused
  const s = setup();
  const h = new ClaimHandler(s.config, () => NOW, fetch, { store: s.store, apple: broken });
  const server = createServer(claimListener(h, false));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  ctx.after(() => server.close());
  const logged: unknown[][] = [];
  const saved = console.error;
  console.error = (...a: unknown[]) => void logged.push(a);
  let status: number;
  try {
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/entitlement/claim`, {
      method: "POST",
      body: JSON.stringify({ source: "apple", credential, claim_secret: SECRET }),
    });
    status = r.status;
  } finally {
    console.error = saved;
  }
  assert.equal(status, 500);
  assert.deepEqual(logged, [["sitr-claim: internal error (TypeError)"]]);
});

test("Apple verification refuses to start on a Node without X509Certificate.validFromDate", () => {
  const proto = X509Certificate.prototype as unknown as Record<string, unknown>;
  const d = Object.getOwnPropertyDescriptor(proto, "validFromDate")!;
  delete proto["validFromDate"];
  try {
    assert.throws(() => new AppleVerifier(ANCHOR, new Set(["Production"])), /Node 22\.10/);
  } finally {
    Object.defineProperty(proto, "validFromDate", d);
  }
  assert.ok(new AppleVerifier(ANCHOR, new Set(["Production"])));
});

test("a verified REFUND without a usable expiresDate or transactionId is 200 and stores nothing", async () => {
  const s = setup();
  for (const over of [{ expiresDate: undefined }, { expiresDate: "2027-01-01" }, { transactionId: undefined }]) {
    assert.equal(await s.notify(note("REFUND", over)), 200, JSON.stringify(over));
    assert.equal(await s.notify(note("REVOKE", over)), 200, JSON.stringify(over));
  }
  assert.equal(await s.notify(note("REFUND_REVERSED", { transactionId: undefined })), 200);
  assert.deepEqual(s.revoked(), []);
});

test("notifications: other types and switched-off Sandbox store nothing; bad ones are 400; limits", async () => {
  const s = setup();
  for (const t of ["DID_RENEW", "EXPIRED", "DID_FAIL_TO_RENEW"]) assert.equal(await s.notify(note(t)), 200);
  assert.equal(await s.notify(note("REFUND", {}, "Sandbox")), 200);
  assert.deepEqual(s.rows(), []);
  assert.deepEqual(s.revoked(), []);
  const bad = (body: Uint8Array) =>
    s.h.handle({ method: "POST", path: "/v1/entitlement/apple/notifications", ip: "203.0.113.6", headers: {}, body });
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
  assert.equal((await bad(enc({ signedPayload: "x.y.z" }))).status, 400);
  assert.equal((await bad(new TextEncoder().encode("not json"))).status, 400);
  assert.equal(await s.notify({ ...note("REFUND"), data: { ...note("REFUND").data, bundleId: "com.other" } }), 400);
  assert.equal(await s.notify({ ...note("REFUND"), data: { ...note("REFUND").data, signedTransactionInfo: "a.b.c" } }), 400);
  const big = await bad(new Uint8Array(64 * 1024 + 1));
  assert.deepEqual([big.status, big.body.length], [413, 0]);
  assert.deepEqual(s.revoked(), []);
  // 9 requests so far from this IP; the 601st in the hour is refused.
  let n = 9;
  while ((await bad(enc({}))).status !== 429 && n < 700) n++;
  assert.equal(n, 600);
});

test("refund and reversal: the later-signed notice wins, whichever arrives first", async () => {
  const at = (type: string, signedDate: number) => ({ ...note(type, { transactionId: "T1" }), signedDate });
  const orders: [string, [string, number][], number][] = [
    ["refund, then later reversal", [["REFUND", NOW], ["REFUND_REVERSED", NOW + 1]], 200],
    ["later reversal arrives first", [["REFUND_REVERSED", NOW + 1], ["REFUND", NOW]], 200],
    ["reversal, then later refund", [["REFUND_REVERSED", NOW], ["REFUND", NOW + 1]], 402],
    ["later refund arrives first", [["REFUND", NOW + 1], ["REFUND_REVERSED", NOW]], 402],
  ];
  for (const [name, notices, status] of orders) {
    const s = setup();
    for (const [type, d] of notices) assert.equal(await s.notify(at(type, d)), 200, name);
    assert.equal((await s.claim(jws(tx({ transactionId: "T1" })))).status, status, name);
  }
});

test("StoreKit test anchor (dev server only): a chain ending in that certificate verifies; tokens carry test", async () => {
  const xcode = (o = {}) => jws(tx({ environment: "Xcode" }), { x5c: [der64("leaf")], key: "leaf", ...o });
  const dev = new AppleVerifier({ testRoot: cert("leaf") }, new Set(["Xcode"]));
  assert.ok(dev.verify(xcode()));
  assert.equal(dev.verify(xcode({ key: "leaf_other" })), null); // signed by another key
  assert.equal(new AppleVerifier({ testRoot: cert("root") }, new Set(["Xcode"])).verify(xcode()), null); // other root
  assert.ok(new AppleVerifier({ testRoot: cert("root") }, new Set(["Xcode"])).verify(jws(tx()))); // 3-chain to it
  assert.equal(new AppleVerifier({ testRoot: cert("root") }, new Set(["Xcode"])).verify(jws(tx(), { chain: ["leaf_other", "inter2", "root"] })), null);
  assert.equal(new AppleVerifier(APPLE_TRUST_ANCHOR, new Set(["Production", "Sandbox"])).verify(xcode()), null);
  const s = setup({ anchor: { testRoot: cert("leaf") }, envs: ["Xcode"] });
  const r = await s.claim(xcode());
  assert.equal(r.status, 200);
  assert.equal(payloadOf(r.body["token"])["test"], true);
  assert.deepEqual(s.rows(), []); // treated as Sandbox: no binding
});
