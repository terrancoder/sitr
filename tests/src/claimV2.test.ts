// Claim service, version 2 and the restricted version 1 route:
// docs/sync-protocol.md §Entitlement version 2 → The issue period, Derived
// values, Claim API, Stored data (claim part), Transition and cut-over,
// Institutions tokens, Failure cases (claim-side rows).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ClaimHandler,
  POLAR_VERSION,
  deriveBinder,
  deriveJti,
  deriveMarker,
  issuePeriod,
} from "../../server/sync/dist/claim.js";
import { ClaimStore } from "../../server/sync/dist/claim-store.js";
import { configFromEnv, type Config } from "../../server/sync/dist/config.js";
import { EntitlementChecker } from "../../server/sync/dist/entitlement.js";
import { keygen, mintTokenV2, privateKeyFromB64 } from "../../server/sync/dist/mint.js";

const DAY = 86_400_000;
const T = (iso: string): number => Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
const kp = keygen();
const KEY = Buffer.alloc(32, 9);
const secret = (n: number): string => Buffer.alloc(32, n).toString("base64url");
const SUB = "6f1c2a3b-1d2e-4f50-8a9b-0c1d2e3f4a5b";
const SUB2 = "7a1c2a3b-1d2e-4f50-9a9b-0c1d2e3f4a5c";

type Answer = { status?: number; body?: unknown; throws?: boolean; raw?: string };

function setup(over: Partial<Config> = {}, env: Record<string, string> = {}, db = ":memory:") {
  const clock = { t: T("2026-11-20T12:00:00Z") };
  const config: Config = {
    ...configFromEnv({
      SITR_POLAR_PRODUCTS: "prod_m=family:month,prod_y=family:year,prod_inst=inst-standard:month",
      ...env,
    }),
    entitlementPrivKeyB64: kp.privateB64,
    polarAccessToken: "polar-test-token",
    claimKey: KEY,
    ...over,
  };
  const polar = new Map<string, Answer>();
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const sub = (over2: Record<string, unknown> = {}) => ({
    status: "active",
    product_id: "prod_y",
    recurring_interval: "year",
    current_period_end: "2027-06-01T00:00:00Z",
    ...over2,
  });
  polar.set(`/v1/subscriptions/${SUB}`, { body: sub() });
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const a = polar.get(url.replace(config.polarApiBase, "")) ?? { status: 404 };
    if (a.throws) throw new Error("network");
    return new Response(a.raw ?? JSON.stringify(a.body ?? {}), { status: a.status ?? 200 });
  }) as typeof fetch;
  const store = new ClaimStore(db);
  const h = new ClaimHandler(config, () => clock.t, fetchStub, { store });
  const raw = async (body: Uint8Array | string, ip = "203.0.113.5", method = "POST", path = "/v1/entitlement/claim") => {
    const r = await h.handle({
      method,
      path,
      ip,
      headers: {},
      body: typeof body === "string" ? new TextEncoder().encode(body) : body,
    });
    const text = new TextDecoder().decode(r.body);
    return { ...r, text, json: text.startsWith("{") ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };
  const claim = (o: Record<string, unknown> = {}, ip?: string) =>
    raw(JSON.stringify({ source: "polar", credential: SUB, claim_secret: secret(1), ...o }), ip);
  const rows = () => store.db.prepare("SELECT * FROM markers").all() as Record<string, unknown>[];
  return { clock, config, polar, calls, sub, store, h, raw, claim, rows };
}
const payload = (token: unknown): Record<string, unknown> =>
  JSON.parse(Buffer.from(String(token).split(".")[1]!, "base64url").toString());

/* ------------------------- issue period, derived ------------------------ */

test("issue period: the spec's examples", () => {
  const far = T("2027-06-01");
  const at = (now: string, paidEnd: number, current = false) => issuePeriod(T(now), paidEnd, current, false);
  assert.deepEqual(at("2026-11-10", far), { per: T("2026-11-01"), periodEnd: T("2026-12-01"), exp: T("2026-12-04") });
  assert.deepEqual(at("2026-11-26", far), { per: T("2026-12-01"), periodEnd: T("2027-01-01"), exp: T("2027-01-04") });
  assert.deepEqual(at("2026-12-02", far), at("2026-11-26", far)); // same month's token, same exp
  assert.equal(at("2026-11-26", T("2026-12-15")).per, T("2026-12-01")); // monthly, renewal 15th
  assert.equal(at("2026-11-26", T("2026-12-02")).exp, T("2027-01-04")); // renewal day 2nd
  assert.equal(at("2026-11-25", T("2026-11-28")).exp, T("2026-12-04")); // renewal 28th: November again
  assert.equal(at("2026-11-26", T("2026-12-01")).per, T("2026-11-01")); // paid end exactly on the 1st
  assert.equal(at("2026-11-24", far).per, T("2026-12-01")); // window opens 7 days before
  assert.equal(at("2026-11-23T23:59:59.999Z", far).per, T("2026-11-01"));
  assert.equal(at("2026-12-26", far, true).exp, T("2027-01-04")); // current: this month
  assert.equal(at("2026-12-26", far).exp, T("2027-02-04"));
  assert.deepEqual(issuePeriod(T("2026-11-20T15:00:00Z"), far, true, true), {
    per: T("2026-11-20"),
    periodEnd: T("2026-11-21"),
    exp: T("2026-11-21T01:00:00Z"),
  });
});

test("derived values: exact labels and byte layout", () => {
  const h = (...parts: Buffer[]) => createHmac("sha256", KEY).update(Buffer.concat(parts)).digest();
  const b = (s: string) => Buffer.from(s, "ascii");
  const z = Buffer.from([0]);
  const marker = h(b("sitr-claim v2 marker"), z, b("polar"), z, b(SUB));
  assert.deepEqual(deriveMarker(KEY, "polar", SUB), marker);
  const cs = Buffer.alloc(32, 3);
  assert.deepEqual(deriveBinder(KEY, marker, cs), h(b("sitr-claim v2 binder"), z, marker, cs));
  const be = (n: number) => {
    const x = Buffer.alloc(8);
    x.writeBigUInt64BE(BigInt(n));
    return x;
  };
  const pe = T("2027-01-01");
  const exp = T("2027-01-04");
  assert.deepEqual(
    deriveJti(KEY, marker, pe, exp, cs),
    h(b("sitr-claim v2 jti"), z, marker, be(pe), be(exp), cs).subarray(0, 16),
  );
  assert.notDeepEqual(deriveMarker(KEY, "apple-sandbox", "1"), deriveMarker(KEY, "apple", "1"));
});

/* ------------------------------ the route ------------------------------- */

test("claim: 200 with a verifiable token; CORS, no-store; one Polar call with the pinned version", async () => {
  const s = setup();
  const r = await s.claim({ credential: SUB.toUpperCase() });
  assert.equal(r.status, 200);
  assert.equal(r.headers["Access-Control-Allow-Origin"], "https://sitrshield.com");
  assert.equal(r.headers["Access-Control-Allow-Methods"], "POST, OPTIONS");
  assert.equal(r.headers["Access-Control-Allow-Headers"], "Content-Type");
  assert.equal(r.headers["Cache-Control"], "no-store");
  const v = new EntitlementChecker(kp.publicB64).verify(String(r.json["token"]));
  assert.ok(v.ok && v.token.v === 2);
  const p = payload(r.json["token"]);
  const marker = deriveMarker(KEY, "polar", SUB);
  assert.deepEqual(p, {
    v: 2,
    plan: "family",
    term: "year",
    per: T("2026-11-01"),
    exp: T("2026-12-04"),
    jti: deriveJti(KEY, marker, T("2026-12-01"), T("2026-12-04"), Buffer.alloc(32, 1)).toString("base64url"),
  });
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0]!.url, `https://api.polar.sh/v1/subscriptions/${SUB}`);
  assert.equal(s.calls[0]!.headers["Polar-Version"], POLAR_VERSION);
  assert.equal(POLAR_VERSION, "2026-10");
  assert.equal(s.calls[0]!.headers["Authorization"], "Bearer polar-test-token");
  const opt = await s.raw("", undefined, "OPTIONS");
  assert.equal(opt.status, 204);
  assert.equal(opt.headers["Access-Control-Allow-Methods"], "POST, OPTIONS");
  assert.deepEqual([(await s.raw("", undefined, "GET")).status, (await s.raw("", undefined, "GET")).json], [405, { error: "method-not-allowed" }]);
  const nf = await s.raw("", undefined, "GET", "/v1/entitlement/other");
  assert.deepEqual([nf.status, nf.json], [404, { error: "not-found" }]);
});

test("claim: bad-request and too-large, before any Polar call", async () => {
  const s = setup();
  const bad: (string | Record<string, unknown>)[] = [
    "not json",
    "[]",
    { source: "stripe" },
    { credential: undefined },
    { credential: "not-a-uuid" },
    { credential: "6f1c2a3b1d2e1f508a9b0c1d2e3f4a5b" }, // no hyphens
    { credential: "6f1c2a3b-1d2e-1f50-8a9b-0c1d2e3f4a5" }, // too short
    { credential: "6f1c2a3b-1d2e-1f50-8a9b-0c1d2e3f4a5g" }, // not hex
    { claim_secret: Buffer.alloc(31).toString("base64url") },
    { claim_secret: Buffer.alloc(32).toString("base64") },
    { replace: "yes" },
    { current: 1 },
  ];
  for (const b of bad) {
    const r = typeof b === "string" ? await s.raw(b) : await s.claim(b);
    assert.deepEqual([r.status, r.json], [400, { error: "bad-request" }], JSON.stringify(b));
  }
  const big = await s.raw(new Uint8Array(16 * 1024 + 1));
  assert.deepEqual([big.status, big.json], [413, { error: "too-large" }]);
  assert.equal(s.calls.length, 0);
});

test("claim: 503 claims-disabled when a key or a source's configuration is missing", async () => {
  for (const over of [{ claimKey: undefined }, { entitlementPrivKeyB64: undefined }, { polarAccessToken: undefined }, { polarProducts: new Map() }]) {
    const s = setup(over as Partial<Config>);
    assert.deepEqual([(await s.claim()).status, (await s.claim()).json], [503, { error: "claims-disabled" }]);
  }
  const s = setup();
  const noStore = new ClaimHandler(s.config, () => s.clock.t, fetch);
  const r = await noStore.handle({ method: "POST", path: "/v1/entitlement/claim", ip: "x", headers: {}, body: new Uint8Array() });
  assert.equal(r.status, 503);
  // Apple source not configured (no verifier, no bundle).
  const a = await s.raw(JSON.stringify({ source: "apple", credential: "a.b.c", claim_secret: secret(1) }));
  assert.deepEqual([a.status, a.json], [503, { error: "claims-disabled" }]);
});

test("Polar answers map to reasons; nothing is stored on failure", async () => {
  const cases: [Answer, number, string][] = [
    [{ status: 404 }, 404, "unknown-code"],
    [{ status: 500 }, 502, "billing-unavailable"],
    [{ throws: true }, 502, "billing-unavailable"],
    [{ body: "not an object" }, 402, "inactive"],
    [{ raw: "<html>gateway</html>" }, 502, "billing-unavailable"], // not JSON at all
    [{ raw: "" }, 502, "billing-unavailable"],
  ];
  for (const [a, status, error] of cases) {
    const s = setup();
    s.polar.set(`/v1/subscriptions/${SUB}`, a);
    const r = await s.claim();
    assert.deepEqual([r.status, r.json], [status, { error }], error);
    assert.deepEqual(s.rows(), []);
  }
  const subCases: [Record<string, unknown>, number, string][] = [
    [{ status: "past_due" }, 402, "payment-pending"],
    [{ status: "canceled" }, 402, "inactive"],
    [{ status: "incomplete" }, 402, "inactive"],
    [{ product_id: "prod_other" }, 422, "wrong-product"],
    [{ recurring_interval: "month" }, 422, "wrong-product"],
    [{ current_period_end: "2026-11-20T12:00:00Z" }, 402, "inactive"],
    [{ current_period_end: null }, 402, "inactive"],
    [{ product_id: undefined }, 402, "inactive"], // a field missing
    [{ product_id: 7 }, 402, "inactive"], // of the wrong type
    [{ recurring_interval: undefined }, 402, "inactive"],
    [{ current_period_end: "not a date" }, 402, "inactive"],
  ];
  for (const [over, status, error] of subCases) {
    const s = setup();
    s.polar.set(`/v1/subscriptions/${SUB}`, { body: s.sub(over) });
    const r = await s.claim();
    assert.deepEqual([r.status, r.json], [status, { error }], JSON.stringify(over));
    assert.deepEqual(s.rows(), []);
  }
});

test("allow-list: a Polar answer full of personal fields leaves nothing in the database, logs or token", async () => {
  const s = setup();
  s.polar.set(`/v1/subscriptions/${SUB}`, {
    body: s.sub({
      customer_id: "cus_SECRET1",
      customer: { email: "alice@example.org", name: "Alice Example", billing_address: { line1: "1 Main St" } },
      user: { email: "alice@example.org" },
      metadata: { ip: "198.51.100.77" },
    }),
  });
  const logged: unknown[] = [];
  const names = ["log", "error", "warn", "info", "debug"] as const;
  const saved = names.map((n) => console[n]);
  for (const n of names) console[n] = (...a: unknown[]) => void logged.push(a);
  let r;
  try {
    r = await s.claim();
  } finally {
    names.forEach((n, i) => (console[n] = saved[i]!));
  }
  assert.equal(r.status, 200);
  assert.deepEqual(logged, []);
  const dump = JSON.stringify(
    ["markers", "revoked_transactions", "v1_claims"].map((t) =>
      (s.store.db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[]).map((row) =>
        Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v])),
      ),
    ),
  );
  for (const needle of ["alice", "Alice", "Main St", "198.51.100.77", "cus_SECRET1", SUB, "prod_y"]) {
    assert.ok(!dump.includes(needle), needle);
    assert.ok(!Buffer.from(String(r.json["token"]).split(".")[1]!, "base64url").toString().includes(needle), needle);
  }
  assert.deepEqual(Object.keys(s.rows()[0]!).sort(), ["binder", "last_period_end", "marker", "replaced_day"]);
});

/* ------------------------------- binding -------------------------------- */

test("determinism: same secret, same period → byte-identical; claims on the 26th and the 2nd agree", async () => {
  const s = setup();
  const a = await s.claim();
  assert.equal((await s.claim()).json["token"], a.json["token"]);
  s.clock.t = T("2026-11-26T08:00:00Z");
  const dec26 = (await s.claim()).json["token"];
  s.clock.t = T("2026-12-02T08:00:00Z");
  const dec2 = (await s.claim()).json["token"];
  assert.equal(dec2, dec26);
  assert.deepEqual([payload(dec2)["per"], payload(dec2)["exp"]], [T("2026-12-01"), T("2027-01-04")]);
  assert.equal(s.rows()[0]!["last_period_end"], T("2027-01-01"));
});

test("binding: another secret gets bound-to-other-device; racing secrets, exactly one wins", async () => {
  const s = setup();
  assert.equal((await s.claim()).status, 200);
  const other = await s.claim({ claim_secret: secret(2) });
  assert.deepEqual([other.status, other.json], [409, { error: "bound-to-other-device" }]);
  const r = setup();
  const results = await Promise.all([r.claim({ claim_secret: secret(3) }), r.claim({ claim_secret: secret(4) })]);
  assert.deepEqual(results.map((x) => x.status).sort(), [200, 409]);
  // Same secret on two devices (iCloud Keychain): both get the same token.
  const won = results[0]!.status === 200 ? secret(3) : secret(4);
  const both = await Promise.all([r.claim({ claim_secret: won }), r.claim({ claim_secret: won })]);
  assert.deepEqual(both.map((x) => x.status), [200, 200]);
  assert.equal(both[0]!.json["token"], both[1]!.json["token"]);
});

test("two connections to one claim database: committed binding is seen; a held write lock refuses, never binds twice", async (ctx) => {
  const dir = mkdtempSync(join(tmpdir(), "sitr-claimdb-"));
  const db = join(dir, "claims.sqlite");
  const a = setup({}, {}, db);
  const b = setup({}, {}, db);
  ctx.after(() => {
    a.store.close();
    b.store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  b.store.db.exec("PRAGMA busy_timeout = 0"); // fail at once instead of waiting 5 s
  // Connection A is in the middle of a binding transaction for secret 1.
  const marker = deriveMarker(KEY, "polar", SUB);
  a.store.db.exec("BEGIN IMMEDIATE");
  a.store.bind(marker, deriveBinder(KEY, marker, Buffer.alloc(32, 1)), T("2026-12-01"), null);
  // B, a second connection, cannot take the write lock: its claim fails, nothing is written.
  await assert.rejects(b.claim({ claim_secret: secret(2) }), /locked|busy/i);
  a.store.db.exec("COMMIT");
  // After A's commit, B sees A's binding: another secret is refused, A's secret matches.
  const refused = await b.claim({ claim_secret: secret(2) });
  assert.deepEqual([refused.status, refused.json], [409, { error: "bound-to-other-device" }]);
  assert.equal((await b.claim()).status, 200);
  assert.equal(b.rows().length, 1);
});

test("refused claims do not count against the per-marker limit: the bound device still renews", async () => {
  const s = setup();
  assert.equal((await s.claim()).status, 200); // the bound device
  // A holder of the code without the claim secret, from many addresses.
  for (let i = 0; i < 30; i++) {
    const r = await s.claim({ claim_secret: secret(2) }, `198.51.100.${i}`);
    assert.equal(r.json["error"], "bound-to-other-device", `attempt ${i}`);
  }
  assert.equal((await s.claim()).status, 200);
  // Refused rebinds do not count either.
  await s.claim({ claim_secret: secret(3), replace: true }, "198.51.100.200"); // uses the rebind
  for (let i = 0; i < 15; i++) await s.claim({ claim_secret: secret(4), replace: true }, `198.51.101.${i}`);
  assert.equal((await s.claim({ claim_secret: secret(3) })).status, 200);
  // A single address is still bounded by the per-IP limit.
  const ip = setup({}, { SITR_CLAIM_PER_IP_HOUR: "3" });
  assert.equal((await ip.claim()).status, 200);
  for (let i = 0; i < 2; i++) assert.equal((await ip.claim({ claim_secret: secret(2) }, "203.0.113.50")).status, 409);
  assert.equal((await ip.claim({ claim_secret: secret(2) }, "203.0.113.50")).status, 409);
  assert.deepEqual((await ip.claim({ claim_secret: secret(2) }, "203.0.113.50")).json, { error: "slow-down" });
});

test("stale binding: a plain claim binds once the bound secret's newest token has expired", async () => {
  const s = setup();
  assert.equal((await s.claim()).status, 200); // last_period_end 1 December
  s.clock.t = T("2026-12-03T23:59:59.999Z");
  assert.equal((await s.claim({ claim_secret: secret(2) })).status, 409);
  s.clock.t = T("2026-12-04");
  assert.equal((await s.claim({ claim_secret: secret(2) })).status, 200);
  assert.equal(s.rows()[0]!["replaced_day"], null); // no rebind used
  assert.equal((await s.claim()).status, 409);
});

test("rebind once per SITR_REPLACEMENT_DAYS; replacement-used with retry_after; replace ignored when unbound", async () => {
  const s = setup();
  const first = await s.claim({ replace: true }); // first bind: uses nothing
  assert.equal(first.status, 200);
  assert.equal(s.rows()[0]!["replaced_day"], null);
  const b = await s.claim({ claim_secret: secret(2), replace: true });
  assert.equal(b.status, 200);
  const today = Math.floor(s.clock.t / DAY);
  assert.equal(s.rows()[0]!["replaced_day"], today);
  // The period rule's token for the new secret: same period, its own jti.
  assert.equal(payload(b.json["token"])["exp"], payload(first.json["token"])["exp"]);
  assert.notEqual(payload(b.json["token"])["jti"], payload(first.json["token"])["jti"]);
  assert.equal((await s.claim()).status, 409); // the old secret is now the other device
  const again = await s.claim({ replace: true });
  assert.deepEqual([again.status, again.json], [409, { error: "replacement-used", retry_after: (today + 180) * DAY }]);
  s.clock.t = (today + 180) * DAY + 1;
  s.polar.set(`/v1/subscriptions/${SUB}`, { body: s.sub({ current_period_end: "2028-01-01T00:00:00Z" }) });
  // B kept claiming, so its binding is fresh: A needs the rebind, now allowed again.
  assert.equal((await s.claim({ claim_secret: secret(2) })).status, 200);
  assert.equal((await s.claim({ replace: true })).status, 200);
});

test("lost everything after a recent rebind: wait for the stale binding, then a plain claim binds", async () => {
  const s = setup();
  await s.claim();
  await s.claim({ claim_secret: secret(2), replace: true }); // rebind used
  const c = await s.claim({ claim_secret: secret(3), replace: true });
  assert.equal(c.json["error"], "replacement-used");
  s.clock.t = T("2026-12-04");
  assert.equal((await s.claim({ claim_secret: secret(3) })).status, 200);
});

test("current: true in the last week gets this month's token, identical to an earlier plain claim", async () => {
  const s = setup();
  const nov = (await s.claim()).json["token"]; // 20 November
  s.clock.t = T("2026-11-26");
  assert.equal((await s.claim({ current: true })).json["token"], nov);
  assert.equal(payload((await s.claim()).json["token"])["per"], T("2026-12-01"));
});

test("monthly, paid end before the 1st in the last week: this month's token until the renewal", async () => {
  const s = setup();
  s.polar.set(`/v1/subscriptions/${SUB}`, {
    body: s.sub({ product_id: "prod_m", recurring_interval: "month", current_period_end: "2026-11-28T10:00:00Z" }),
  });
  s.clock.t = T("2026-11-25");
  const p = payload((await s.claim()).json["token"]);
  assert.deepEqual([p["per"], p["exp"], p["term"]], [T("2026-11-01"), T("2026-12-04"), "month"]);
  s.polar.set(`/v1/subscriptions/${SUB}`, {
    body: s.sub({ product_id: "prod_m", recurring_interval: "month", current_period_end: "2026-12-28T10:00:00Z" }),
  });
  s.clock.t = T("2026-11-28T12:00:00Z");
  assert.equal(payload((await s.claim()).json["token"])["exp"], T("2027-01-04"));
});

test("first purchase late in the month, cancelled at period end, monthly to yearly", async () => {
  const s = setup();
  s.clock.t = T("2026-11-27");
  assert.equal(payload((await s.claim()).json["token"])["per"], T("2026-12-01")); // early, creates
  s.polar.set(`/v1/subscriptions/${SUB}`, { body: s.sub({ current_period_end: "2026-12-15T00:00:00Z" }) }); // cancelled, still active
  assert.equal((await s.claim()).status, 200);
  // Monthly → yearly keeps the subscription ID, so the marker and binding.
  s.polar.set(`/v1/subscriptions/${SUB}`, { body: s.sub({ product_id: "prod_m", recurring_interval: "month" }) });
  assert.equal(payload((await s.claim()).json["token"])["term"], "month");
  assert.equal(s.rows().length, 1);
});

test("Institutions products through the same route", async () => {
  const s = setup();
  s.polar.set(`/v1/subscriptions/${SUB2}`, { body: s.sub({ product_id: "prod_inst", recurring_interval: "month" }) });
  const p = payload((await s.claim({ credential: SUB2 })).json["token"]);
  assert.deepEqual([p["plan"], p["term"]], ["inst-standard", "month"]);
});

test("limits: 10 claims an hour per marker, per-IP limit shared by all claim routes", async () => {
  const s = setup();
  for (let i = 0; i < 10; i++) assert.equal((await s.claim({}, `198.51.100.${i}`)).status, 200);
  assert.deepEqual((await s.claim({}, "198.51.100.99")).json, { error: "slow-down" });
  s.polar.set(`/v1/subscriptions/${SUB2}`, { body: s.sub() });
  assert.equal((await s.claim({ credential: SUB2, claim_secret: secret(2) }, "198.51.100.98")).status, 200);
  s.clock.t += 3_600_000;
  assert.equal((await s.claim({}, "198.51.100.99")).status, 200);

  const ip = setup({}, { SITR_CLAIM_PER_IP_HOUR: "3" });
  assert.equal((await ip.claim()).status, 200);
  assert.equal((await ip.raw("", "203.0.113.5", "GET", "/v1/entitlement/subscription/chk_1")).status, 404);
  assert.equal((await ip.raw("", "203.0.113.5", "GET", "/v1/entitlement/claim/chk_1")).status, 404);
  assert.deepEqual((await ip.claim()).json, { error: "slow-down" });
  assert.equal((await ip.raw("", "203.0.113.5", "GET", "/v1/entitlement/claim/chk_1")).status, 429);
  assert.equal((await ip.claim({}, "203.0.113.6")).status, 200);
});

/* --------------------------- exchange route ---------------------------- */

test("GET /v1/entitlement/subscription/{checkoutId}: code, reasons, CORS, stores nothing", async () => {
  const s = setup();
  const get = (id: string, method = "GET") => s.raw("", "203.0.113.8", method, `/v1/entitlement/subscription/${id}`);
  s.polar.set("/v1/checkouts/chk_ok", { body: { status: "succeeded", subscription_id: SUB.toUpperCase(), customer_email: "a@b.c" } });
  s.polar.set("/v1/checkouts/chk_confirmed", { body: { status: "confirmed", subscription_id: SUB } });
  s.polar.set("/v1/checkouts/chk_once", { body: { status: "succeeded" } });
  s.polar.set("/v1/checkouts/chk_down", { status: 503 });
  const ok = await get("chk_ok");
  assert.deepEqual([ok.status, ok.json], [200, { code: SUB }]);
  assert.equal(ok.headers["Access-Control-Allow-Methods"], "GET, OPTIONS");
  assert.equal(ok.headers["Cache-Control"], "no-store");
  assert.deepEqual((await get("chk_confirmed")).json, { error: "not-paid" });
  assert.equal((await get("chk_confirmed")).status, 402);
  assert.deepEqual([(await get("chk_once")).status, (await get("chk_once")).json], [422, { error: "not-a-subscription" }]);
  assert.deepEqual([(await get("chk_none")).status, (await get("chk_none")).json], [404, { error: "unknown-checkout" }]);
  assert.deepEqual([(await get("chk_down")).status, (await get("chk_down")).json], [502, { error: "billing-unavailable" }]);
  assert.equal((await get("chk_ok", "OPTIONS")).status, 204);
  assert.deepEqual((await get("chk_ok", "POST")).json, { error: "method-not-allowed" });
  assert.equal((await s.raw("", "x", "GET", "/v1/entitlement/subscription/bad id")).status, 404);
  assert.deepEqual(s.rows(), []);
  const off = setup({ polarAccessToken: undefined });
  assert.deepEqual((await off.raw("", "x", "GET", "/v1/entitlement/subscription/chk_ok")).json, { error: "claims-disabled" });
});

/* ------------------------- version 1 restrictions ----------------------- */

test("v1 route: active only, once per checkout, byte-identical until exp, then already-claimed; v1-ended", async () => {
  const s = setup();
  const v1 = (id: string) => s.raw("", "203.0.113.9", "GET", `/v1/entitlement/claim/${id}`);
  const count = () => (s.store.db.prepare("SELECT count(*) AS n FROM v1_claims").get() as { n: number }).n;
  s.polar.set("/v1/checkouts/chk_a", { body: { status: "succeeded", subscription_id: SUB } });
  s.polar.set("/v1/checkouts/chk_inactive", { body: { status: "succeeded", subscription_id: SUB2 } });
  s.polar.set(`/v1/subscriptions/${SUB2}`, { body: s.sub({ status: "canceled" }) });
  s.polar.set("/v1/checkouts/chk_onetime", { body: { status: "succeeded" } });
  const a = await v1("chk_a");
  assert.equal(a.status, 200);
  const token = String(a.json["token"]);
  assert.ok(token.startsWith("sitr-ent-v1."));
  assert.equal(payload(token)["exp"], s.clock.t + 7 * DAY); // default changed to 7 days
  s.clock.t += 3 * DAY;
  assert.equal((await v1("chk_a")).json["token"], token);
  s.clock.t = Number(payload(token)["exp"]);
  const used = await v1("chk_a");
  assert.deepEqual([used.status, used.text], [409, "already-claimed\n"]);
  for (const id of ["chk_inactive", "chk_onetime"]) {
    const r = await v1(id);
    assert.deepEqual([r.status, r.text], [402, "inactive\n"], id);
  }
  assert.equal(count(), 1);
  // Only a Family product mints a (Family) version 1 token.
  const SUB3 = "8b1c2a3b-1d2e-4f50-8a9b-0c1d2e3f4a5d";
  s.polar.set("/v1/checkouts/chk_inst", { body: { status: "succeeded", subscription_id: SUB3 } });
  for (const product of ["prod_inst", "prod_unlisted"]) {
    s.polar.set(`/v1/subscriptions/${SUB3}`, { body: s.sub({ product_id: product }) });
    const r = await v1("chk_inst");
    assert.deepEqual([r.status, r.text], [422, "wrong-product\n"], product);
  }
  assert.equal(count(), 1);
  const cut = setup({}, { SITR_V1_CUTOVER: "2026-11-20" });
  const ended = await cut.raw("", "x", "GET", "/v1/entitlement/claim/chk_a");
  assert.deepEqual([ended.status, ended.text], [410, "v1-ended\n"]);
});

/* ---------------------------- pruning, config --------------------------- */

test("hourly pruning: stale, no recent rebind → gone; otherwise kept", async () => {
  const s = setup();
  await s.claim(); // bound, last_period_end 1 December
  const R = s.config.replacementDays;
  assert.equal(s.store.prune(T("2026-12-03T23:00:00Z"), R), 0);
  assert.equal(s.store.prune(T("2026-12-04"), R), 1);
  // Recent rebind: kept R days.
  const m = Buffer.alloc(32, 1);
  s.store.bind(m, Buffer.alloc(32, 2), T("2026-12-01"), Math.floor(T("2026-12-01") / DAY));
  assert.equal(s.store.prune(T("2027-05-29"), R), 0);
  assert.equal(s.store.prune(T("2026-12-01") + R * DAY, R), 1);
});

test("config: claim variables parse, defaults, and refuse malformed values", () => {
  const c = configFromEnv({
    SITR_CLAIM_KEY: Buffer.alloc(32, 1).toString("base64"),
    SITR_POLAR_PRODUCTS: "p1=family:month, p2=inst-starter:year",
    SITR_APPLE_PRODUCTS: "com.example.family.month=family:month",
    SITR_APPLE_BUNDLE_ID: "com.example.sitr",
    SITR_APPLE_SANDBOX: "1",
    SITR_CLAIM_DB: "/tmp/x.sqlite",
  });
  assert.equal(c.claimKey?.length, 32);
  assert.deepEqual(c.polarProducts.get("p2"), { plan: "inst-starter", term: "year" });
  assert.equal(c.appleProducts.size, 1);
  assert.deepEqual([c.appleBundleId, c.appleSandbox, c.claimDbPath], ["com.example.sitr", true, "/tmp/x.sqlite"]);
  const d = configFromEnv({});
  assert.deepEqual([d.replacementDays, d.claimPerIpPerHour, d.entitlementDays, d.claimKey, d.polarProducts.size], [180, 60, 7, undefined, 0]);
  assert.throws(() => configFromEnv({ SITR_CLAIM_KEY: "c2hvcnQ=" }));
  assert.throws(() => configFromEnv({ SITR_POLAR_PRODUCTS: "p1=gold:month" }));
  assert.throws(() => configFromEnv({ SITR_APPLE_PRODUCTS: "p1=family:week" }));
});

test("mint.js --verify prints plan, term, exp and validity", () => {
  // Fixed tokens far on either side of any real date the CLI may run on.
  const priv = privateKeyFromB64(kp.privateB64);
  const fields = { v: 2, plan: "family", term: "year", jti: "AAAAAAAAAAAAAAAAAAAAAA" } as const;
  const token = mintTokenV2(priv, { ...fields, per: Date.UTC(2998, 11, 1), exp: Date.UTC(2999, 0, 4) });
  const past = mintTokenV2(priv, { ...fields, per: Date.UTC(2000, 0, 1), exp: Date.UTC(2000, 1, 4) });
  const mint = fileURLToPath(new URL("../../server/sync/dist/mint.js", import.meta.url));
  const run = (t: string) =>
    spawnSync(process.execPath, [mint, "--verify", t], { env: { ...process.env, SITR_ENTITLEMENT_PUBKEY: kp.publicB64 }, encoding: "utf8" });
  const ok = run(token);
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, "plan family\nterm year\nexp 2999-01-04T00:00:00.000Z\nvalid now\n");
  const old = run(past);
  assert.equal(old.status, 1);
  assert.match(old.stdout, /exp 2000-02-04T00:00:00.000Z\nnot valid now/);
  const bad = run(token.slice(0, -4) + "AAAA");
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /invalid \(token-invalid\)/);
});

test("claim: a well-formed UUID of any version reaches Polar (version 1, 4, 7)", async () => {
  for (const id of ["6f1c2a3b-1d2e-1f50-8a9b-0c1d2e3f4a5b", SUB, "019a1c2a-3b1d-7e4f-8a9b-0c1d2e3f4a5b"]) {
    const s = setup();
    s.polar.set(`/v1/subscriptions/${id}`, { body: s.sub() });
    assert.equal((await s.claim({ credential: id })).status, 200, id);
    assert.deepEqual(s.calls.map((c) => c.url), [`https://api.polar.sh/v1/subscriptions/${id}`]);
  }
});

test("v1 route: an empty, missing or malformed subscription ID from Polar is inactive and never reaches a URL", async () => {
  const s = setup();
  for (const [id, sid] of [["chk_e", ""], ["chk_m", undefined], ["chk_x", "../checkouts/x"], ["chk_s", "sub-1"]] as const) {
    s.polar.set(`/v1/checkouts/${id}`, { body: { status: "succeeded", subscription_id: sid } });
    const r = await s.raw("", "203.0.113.9", "GET", `/v1/entitlement/claim/${id}`);
    assert.deepEqual([r.status, r.text], [402, "inactive\n"], String(sid));
  }
  assert.deepEqual(s.calls.filter((c) => c.url.includes("/subscriptions")), []);
});

test("v1_claims is emptied by the prune once the cut-over has passed, not before", async () => {
  const s = setup({}, { SITR_V1_CUTOVER: "2026-12-01" });
  s.polar.set("/v1/checkouts/chk_a", { body: { status: "succeeded", subscription_id: SUB } });
  assert.equal((await s.raw("", "203.0.113.9", "GET", "/v1/entitlement/claim/chk_a")).status, 200);
  const count = () => (s.store.db.prepare("SELECT count(*) AS n FROM v1_claims").get() as { n: number }).n;
  s.store.prune(T("2026-11-30T23:59:59Z"), 180, s.config.v1CutoverMs);
  assert.equal(count(), 1);
  s.store.prune(T("2026-12-01"), 180, s.config.v1CutoverMs);
  assert.equal(count(), 0);
});
