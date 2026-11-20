// Entitlement version 2 on the sync server: docs/sync-protocol.md
// §Entitlement version 2 → Token format, Stored data, Sync-server rules.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  EntitlementChecker,
  type EntitlementPayloadV2,
} from "../../server/sync/dist/entitlement.js";
import {
  keygen,
  mintToken,
  mintTokenV2,
  privateKeyFromB64,
} from "../../server/sync/dist/mint.js";
import { SyncStore } from "../../server/sync/dist/store.js";
import { SyncHandler, type SyncResponse } from "../../server/sync/dist/http.js";
import { configFromEnv } from "../../server/sync/dist/config.js";

const DAY = 86_400_000;
const T = (iso: string): number => Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
const kp = keygen();
const priv = privateKeyFromB64(kp.privateB64);
const AUTH = "a".repeat(64);
const WRONG = "b".repeat(64);
const HDR = "X-Sitr-Entitlement-Expires";
const sha = (hex: string): Uint8Array =>
  new Uint8Array(createHash("sha256").update(Buffer.from(hex, "hex")).digest());

let jtiCounter = 0;
function newJti(): string {
  const b = Buffer.alloc(16);
  b.writeUInt32BE(++jtiCounter, 12);
  return b.toString("base64url");
}

/** A November production token unless overridden. */
function v2(o: Partial<EntitlementPayloadV2> = {}): string {
  return mintTokenV2(priv, {
    v: 2,
    plan: "family",
    term: "month",
    per: T("2026-11-01"),
    exp: T("2026-12-04"),
    jti: newJti(),
    ...o,
  });
}
const DEC = { per: T("2026-12-01"), exp: T("2027-01-04") };
const JAN = { per: T("2027-01-01"), exp: T("2027-02-04") };

function signRaw(prefix: string, payload: unknown): string {
  const bytes = Buffer.from(JSON.stringify(payload));
  return `${prefix}.${bytes.toString("base64url")}.${sign(null, bytes, priv).toString("base64url")}`;
}

function setup(opts: { cutover?: string; db?: string; open?: boolean; creates?: number } = {}) {
  const clock = { t: T("2026-11-20T12:00:00Z") };
  const store = new SyncStore(opts.db ?? ":memory:");
  const config = {
    ...configFromEnv(opts.cutover ? { SITR_V1_CUTOVER: opts.cutover } : {}),
    entitlementPubKeyB64: opts.open ? undefined : kp.publicB64,
    createsPerIpPerHour: opts.creates ?? 1e6,
    requestsPerIdPerMinute: 1e6,
  };
  const h = new SyncHandler(store, config, () => clock.t);
  let n = 0;
  const id = (): string => (++n).toString(16).padStart(32, "0");
  const put = (hid: string, pre: Record<string, string>, token?: string, auth = AUTH) =>
    h.handle({
      method: "PUT",
      path: `/v1/blob/${hid}`,
      ip: "203.0.113.7",
      headers: { authorization: `Bearer ${auth}`, ...pre, "x-sitr-entitlement": token },
      body: new Uint8Array([1]),
    });
  const create = (hid: string, token?: string, auth = AUTH) =>
    put(hid, { "if-none-match": "*" }, token, auth);
  const update = (hid: string, etag: number, token?: string, auth = AUTH) =>
    put(hid, { "if-match": `"${etag}"` }, token, auth);
  const call = (method: string, hid: string, auth = AUTH) =>
    h.handle({
      method,
      path: `/v1/blob/${hid}`,
      ip: "203.0.113.7",
      headers: { authorization: `Bearer ${auth}` },
      body: new Uint8Array(0),
    });
  return { clock, store, h, id, create, update, put, call };
}

const reason = (r: SyncResponse): string => new TextDecoder().decode(r.body).split("\n")[0]!;
function is402(r: SyncResponse, code: string): void {
  assert.equal(r.status, 402);
  assert.equal(r.headers["Content-Type"], "text/plain; charset=utf-8");
  assert.equal(reason(r), code);
}

/* ------------------------------ token module ----------------------------- */

test("v2 token: signed payload has the spec's key order, test last", () => {
  const t = mintTokenV2(priv, {
    jti: "AAAAAAAAAAAAAAAAAAAAAA",
    test: true,
    exp: 1801699200000,
    per: 1798761600000,
    term: "year",
    plan: "family",
    v: 2,
  });
  const [prefix, payload] = t.split(".");
  assert.equal(prefix, "sitr-ent-v2");
  assert.equal(
    Buffer.from(payload!, "base64url").toString(),
    '{"v":2,"plan":"family","term":"year","per":1798761600000,"exp":1801699200000,"jti":"AAAAAAAAAAAAAAAAAAAAAA","test":true}',
  );
  const checker = new EntitlementChecker(kp.publicB64);
  const r = checker.verify(t);
  assert.ok(r.ok && r.token.v === 2 && r.token.payload.test === true);
  const noTest = checker.verify(v2());
  assert.ok(noTest.ok && noTest.token.v === 2 && !("test" in noTest.token.payload));
});

test("verifier: v must match the prefix, fields must be valid", () => {
  const checker = new EntitlementChecker(kp.publicB64);
  const good = { v: 2, plan: "family", term: "month", per: T("2026-11-01"), exp: T("2026-12-04"), jti: newJti() };
  assert.equal(checker.verify(signRaw("sitr-ent-v2", good)).ok, true);
  const bad: [string, unknown][] = [
    ["v2 prefix, v 1", { ...good, v: 1 }],
    ["per not midnight", { ...good, per: good.per + 1 }],
    ["per = exp", { ...good, exp: good.per }],
    ["jti too short", { ...good, jti: "AAAA" }],
    ["jti bad chars", { ...good, jti: "A".repeat(21) + "=" }],
    ["test false", { ...good, test: false }],
    ["unknown plan", { ...good, plan: "gold" }],
    ["bad term", { ...good, term: "week" }],
    ["exp not integer", { ...good, exp: good.exp + 0.5 }],
  ];
  for (const [name, p] of bad) {
    assert.deepEqual(checker.verify(signRaw("sitr-ent-v2", p)), { ok: false, reason: "token-invalid" }, name);
  }
  // A v1 prefix carrying a v2 payload, and the reverse.
  assert.equal(checker.verify(signRaw("sitr-ent-v1", good)).ok, false);
  assert.equal(checker.verify(signRaw("sitr-ent-v2", { v: 1, plan: "family", exp: good.exp })).ok, false);
  assert.equal(checker.verify(signRaw("sitr-ent-v1", { v: 1, plan: "family", exp: good.exp })).ok, true);
  assert.deepEqual(checker.verify(undefined), { ok: false, reason: "token-required" });
  assert.deepEqual(checker.verify(""), { ok: false, reason: "token-required" });
  // The signer refuses what the verifier would refuse.
  assert.throws(() => v2({ per: T("2026-11-01") + 1 }));
});

test("SITR_V1_CUTOVER: YYYY-MM-DD as UTC midnight, anything else throws", () => {
  assert.equal(configFromEnv({}).v1CutoverMs, undefined);
  assert.equal(configFromEnv({ SITR_V1_CUTOVER: "2027-03-01" }).v1CutoverMs, T("2027-03-01"));
  for (const v of ["2027-3-1", "2027-02-30", "2027-03-01T00:00:00Z", "soon"]) {
    assert.throws(() => configFromEnv({ SITR_V1_CUTOVER: v }), v);
  }
});

/* --------------------------------- create -------------------------------- */

test("create: every 402 reason, text/plain, code alone on the first line, no row", () => {
  const s = setup({ cutover: "2027-03-01" });
  const other = privateKeyFromB64(keygen().privateB64);
  const cases: [string, string | undefined][] = [
    ["token-required", undefined],
    ["token-required", ""],
    ["token-invalid", "garbage"],
    ["token-invalid", "sitr-ent-v9.a.b"],
    ["token-invalid", mintToken(other, "family", s.clock.t + DAY)],
    ["token-invalid", signRaw("sitr-ent-v2", { v: 1, plan: "family", exp: s.clock.t + DAY })],
    ["token-expired", v2({ exp: s.clock.t })],
    ["token-expired", mintToken(priv, "family", s.clock.t)],
    ["plan-not-accepted", v2({ plan: "inst-starter" })],
    ["plan-not-accepted", v2({ plan: "inst-standard" })],
  ];
  for (const [code, token] of cases) {
    const hid = s.id();
    is402(s.create(hid, token), code);
    assert.equal(s.call("GET", hid).status, 404, code);
  }
  // token-used: one jti, two households.
  const t = v2();
  assert.equal(s.create(s.id(), t).status, 201);
  const hid = s.id();
  is402(s.create(hid, t), "token-used");
  assert.equal(s.call("GET", hid).status, 404);
  // v1-ended: a valid version 1 token on the cut-over date.
  s.clock.t = T("2027-03-01");
  is402(s.create(s.id(), mintToken(priv, "family", s.clock.t + 300 * DAY)), "v1-ended");
});

test("create with v2: 201, ent_exp = exp, header on 201 and GET; early token creates", () => {
  const s = setup();
  const hid = s.id();
  const r = s.create(hid, v2());
  assert.equal(r.status, 201);
  assert.equal(r.headers[HDR], String(T("2026-12-04")));
  assert.equal(s.call("GET", hid).headers[HDR], String(T("2026-12-04")));
  // 27 November: December token, early until 1 December, creates.
  s.clock.t = T("2026-11-27T09:00:00Z");
  const early = s.create(s.id(), v2(DEC));
  assert.equal(early.status, 201);
  assert.equal(early.headers[HDR], String(DEC.exp));
});

test("create-rate limit: after the token check, counts If-Match creations, a 429 burns nothing", () => {
  const s = setup({ creates: 2 });
  const old = mintToken(priv, "family", s.clock.t + 300 * DAY);
  assert.equal(s.update(s.id(), 1, old).status, 201);
  assert.equal(s.update(s.id(), 1, old).status, 201);
  assert.equal(s.update(s.id(), 1, old).status, 429);
  const t1 = setup({ creates: 1 });
  is402(t1.create(t1.id()), "token-required"); // a 402 is not counted
  const t = v2();
  assert.equal(t1.create(t1.id(), t).status, 201);
  const fresh = v2();
  const hid = t1.id();
  assert.equal(t1.create(hid, fresh).status, 429);
  t1.clock.t += 3_600_000;
  assert.equal(t1.create(hid, fresh).status, 201);
});

test("create: reason order and v2 after the cut-over", () => {
  const s = setup({ cutover: "2027-03-01" });
  s.clock.t = T("2027-03-10");
  is402(s.create(s.id(), v2({ plan: "inst-starter", per: T("2027-02-01"), exp: T("2027-03-04") })), "token-expired");
  is402(s.create(s.id(), mintToken(priv, "family", T("2027-03-05"))), "token-expired");
  const r = s.create(s.id(), v2({ per: T("2027-03-01"), exp: T("2027-04-04") }));
  assert.equal(r.status, 201);
  assert.equal(r.headers[HDR], String(T("2027-04-04")));
});

test("create limit: charged only for a real creation; a lost-201 retry or a wrong credential is never 429", () => {
  for (const open of [true, false]) {
    const s = setup({ open, creates: 1 });
    const hid = s.id();
    const t = open ? undefined : v2();
    assert.equal(s.create(hid, t).status, 201); // the whole budget
    for (let i = 0; i < 3; i++) {
      const retry = s.create(hid, t);
      assert.deepEqual([retry.status, retry.headers["ETag"]], [409, '"1"'], `open=${open} retry ${i}`);
      assert.equal(s.create(hid, t, WRONG).status, 401);
    }
    assert.equal(s.create(s.id(), open ? undefined : v2()).status, 429); // a new household: over budget
  }
});

test("open mode: an If-Match creation also counts against the per-IP create limit", () => {
  const s = setup({ open: true, creates: 1 });
  assert.equal(s.update(s.id(), 1).status, 201);
  assert.equal(s.create(s.id()).status, 429);
});

test("If-Match on an unknown id follows the create rules (no household without a token)", () => {
  const s = setup();
  const hid = s.id();
  is402(s.update(hid, 1), "token-required");
  assert.equal(s.call("GET", hid).status, 404);
  assert.equal(s.update(hid, 1, v2()).status, 201);
});

test("lost-201 retry: If-None-Match * on an existing row is 409/401, token not checked or burned", () => {
  const s = setup();
  const hid = s.id();
  const t = v2();
  assert.equal(s.create(hid, t).status, 201);
  const retry = s.create(hid, t);
  assert.equal(retry.status, 409);
  assert.equal(retry.headers["ETag"], '"1"');
  assert.equal(retry.headers[HDR], undefined);
  assert.equal(s.create(hid, undefined, WRONG).status, 401);
  // A fresh token sent this way is not burned: it still extends later.
  const fresh = v2(DEC);
  assert.equal(s.create(hid, fresh).status, 409);
  const r = s.update(hid, 1, fresh);
  assert.equal(r.status, 200);
  assert.equal(r.headers[HDR], String(DEC.exp));
});

/* ------------------------------ version 1 ------------------------------- */

test("v1: old tokens (exp - now > 8 days) reusable, new ones single-use; boundary at 8 days", () => {
  const s = setup();
  const old = mintToken(priv, "family", s.clock.t + 366 * DAY);
  for (let i = 0; i < 3; i++) {
    const r = s.create(s.id(), old);
    assert.equal(r.status, 201);
    assert.equal(r.headers[HDR], undefined); // legacy, no cut-over: no end
  }
  const fresh = mintToken(priv, "family", s.clock.t + 7 * DAY);
  assert.equal(s.create(s.id(), fresh).status, 201);
  is402(s.create(s.id(), fresh), "token-used");
  const edge = mintToken(priv, "family", s.clock.t + 8 * DAY);
  assert.equal(s.create(s.id(), edge).status, 201);
  is402(s.create(s.id(), edge), "token-used");
  const justOld = mintToken(priv, "family", s.clock.t + 8 * DAY + 1);
  assert.equal(s.create(s.id(), justOld).status, 201);
  assert.equal(s.create(s.id(), justOld).status, 201);
  // An old token in its own last 8 days: first use there recorded, then refused.
  s.clock.t += 359 * DAY;
  assert.equal(s.create(s.id(), old).status, 201);
  is402(s.create(s.id(), old), "token-used");
});

test("legacy household without cut-over: untouched, no end, no header", () => {
  const s = setup();
  const hid = s.id();
  assert.equal(s.create(hid, mintToken(priv, "family", s.clock.t + 300 * DAY)).status, 201);
  s.clock.t += 1000 * DAY;
  const r = s.update(hid, 1);
  assert.equal(r.status, 200);
  assert.equal(r.headers[HDR], undefined);
  // A version 1 token on update counts as no token.
  assert.equal(s.update(hid, 2, mintToken(priv, "family", s.clock.t + 300 * DAY)).status, 200);
});

test("legacy conversion: any usable v2 token, early or not, makes it tracked", () => {
  const s = setup();
  const hid = s.id();
  assert.equal(s.create(hid, mintToken(priv, "family", s.clock.t + 300 * DAY)).status, 201);
  const r = s.update(hid, 1, v2(DEC)); // early on 20 November
  assert.equal(r.status, 200);
  assert.equal(r.headers[HDR], String(DEC.exp)); // exp, not max with anything
  s.clock.t = DEC.exp;
  const lapsed = s.update(hid, 2);
  is402(lapsed, "lapsed");
  assert.equal(lapsed.headers[HDR], String(DEC.exp));
});

test("cut-over: legacy lapsed from the date, header shows it, v2 current token reopens", () => {
  const s = setup({ cutover: "2027-03-01" });
  const hid = s.id();
  const c = s.create(hid, mintToken(priv, "family", s.clock.t + 300 * DAY));
  assert.equal(c.status, 201);
  assert.equal(c.headers[HDR], String(T("2027-03-01")));
  s.clock.t = T("2027-02-28T23:59:59Z");
  assert.equal(s.update(hid, 1).status, 200);
  s.clock.t = T("2027-03-01");
  const lapsed = s.update(hid, 2);
  is402(lapsed, "lapsed");
  assert.equal(lapsed.headers[HDR], String(T("2027-03-01")));
  // Early April token cannot reopen it; the March one can.
  s.clock.t = T("2027-03-26");
  const april = v2({ per: T("2027-04-01"), exp: T("2027-05-04") });
  is402(s.update(hid, 2, april), "lapsed");
  const r = s.update(hid, 2, v2({ per: T("2027-03-01"), exp: T("2027-04-04") }));
  assert.equal(r.status, 200);
  assert.equal(r.headers[HDR], String(T("2027-04-04")));
  assert.equal(s.update(hid, 3, april).headers[HDR], String(T("2027-05-04")));
});

/* --------------------------------- update -------------------------------- */

test("extend: ent_exp = max(ent_exp, exp); a reused jti counts as no token", () => {
  const s = setup();
  const hid = s.id();
  const nov = v2();
  assert.equal(s.create(hid, nov).status, 201);
  s.clock.t = T("2026-11-26");
  const d = v2(DEC);
  assert.equal(s.update(hid, 1, d).headers[HDR], String(DEC.exp)); // early, live household
  const again = s.update(hid, 2, d);
  assert.equal(again.status, 200);
  assert.equal(again.headers[HDR], String(DEC.exp));
  // A usable but older token does not move the end back.
  assert.equal(s.update(hid, 3, v2()).headers[HDR], String(DEC.exp));
  // Used on another household: no token there either.
  const other = s.id();
  assert.equal(s.create(other, v2()).status, 201);
  assert.equal(s.update(other, 1, d).headers[HDR], String(T("2026-12-04")));
});

test("other tokens on update count as no token: expired, invalid, v1, Institutions", () => {
  const s = setup();
  const hid = s.id();
  assert.equal(s.create(hid, v2()).status, 201);
  const end = String(T("2026-12-04"));
  const tokens = [
    "garbage",
    v2({ ...DEC, plan: "inst-starter" }),
    mintToken(priv, "family", T("2027-06-01")),
    v2({ per: T("2026-10-01"), exp: T("2026-11-04") }),
  ];
  let etag = 1;
  for (const t of tokens) {
    const r = s.update(hid, etag++, t);
    assert.equal(r.status, 200);
    assert.equal(r.headers[HDR], end);
  }
});

test("early token on a lapsed household: 402, not burned, works from its per", () => {
  const s = setup();
  const hid = s.id();
  assert.equal(s.create(hid, v2()).status, 201); // ent_exp 4 December
  s.clock.t = T("2026-12-26");
  const jan = v2(JAN);
  is402(s.update(hid, 1, jan), "lapsed");
  s.clock.t = JAN.per; // now = per: no longer early
  const r = s.update(hid, 1, jan);
  assert.equal(r.status, 200);
  assert.equal(r.headers[HDR], String(JAN.exp));
});

test("current token reopens a lapsed household, then the early one extends it", () => {
  const s = setup();
  const hid = s.id();
  assert.equal(s.create(hid, v2()).status, 201);
  s.clock.t = T("2026-12-26");
  assert.equal(s.update(hid, 1, v2(DEC)).headers[HDR], String(DEC.exp));
  assert.equal(s.update(hid, 2, v2(JAN)).headers[HDR], String(JAN.exp));
});

test("test flag must match: test vs production household and the reverse", () => {
  const s = setup();
  const prod = s.id();
  const testH = s.id();
  assert.equal(s.create(prod, v2()).status, 201);
  const tc = s.create(testH, v2({ test: true, per: T("2026-11-20"), exp: T("2026-11-21T01:00:00Z") }));
  assert.equal(tc.status, 201);
  assert.equal(tc.headers[HDR], String(T("2026-11-21T01:00:00Z")));
  // Sandbox token on the production household: no token.
  const sandbox = v2({ test: true, ...DEC });
  assert.equal(s.update(prod, 1, sandbox).headers[HDR], String(T("2026-12-04")));
  // Production token on the test household: no token, not burned.
  const prodTok = v2(DEC);
  assert.equal(s.update(testH, 1, prodTok).headers[HDR], String(T("2026-11-21T01:00:00Z")));
  assert.equal(s.update(prod, 2, prodTok).headers[HDR], String(DEC.exp));
  // Sandbox token on the test household extends it; the burnt-in delete day stays.
  s.clock.t = T("2026-11-21T00:30:00Z");
  const next = v2({ test: true, per: T("2026-11-21"), exp: T("2026-11-22T01:00:00Z") });
  assert.equal(s.update(testH, 2, next).headers[HDR], String(T("2026-11-22T01:00:00Z")));
  s.store.gc(T("2026-11-27T12:00:00Z"), 540 * DAY); // day of creation + 7: kept
  assert.equal(s.store.lookup(testH, sha(AUTH)).kind, "ok");
  s.store.gc(T("2026-11-28T00:00:00Z"), 540 * DAY);
  assert.equal(s.store.lookup(testH, sha(AUTH)).kind, "not-found");
  assert.equal(s.store.lookup(prod, sha(AUTH)).kind, "ok");
});

test("lapse: GET and DELETE still work; PUT 402 with header; 401 before 402; 402 before 409", () => {
  const s = setup();
  const hid = s.id();
  assert.equal(s.create(hid, v2()).status, 201);
  s.clock.t = T("2026-12-04"); // E = now: lapsed
  const lapsed = s.update(hid, 1);
  is402(lapsed, "lapsed");
  assert.equal(lapsed.headers[HDR], String(T("2026-12-04")));
  is402(s.update(hid, 99), "lapsed"); // stale etag: still 402
  assert.equal(s.update(hid, 1, undefined, WRONG).status, 401);
  assert.equal(s.update(hid, 1, v2(JAN), WRONG).status, 401);
  const got = s.call("GET", hid);
  assert.equal(got.status, 200);
  assert.equal(got.headers[HDR], String(T("2026-12-04")));
  assert.equal(s.call("DELETE", hid).status, 204);
  assert.equal(s.call("GET", hid).status, 404);
});

test("stale If-Match with a fresh token: 409, token not burned", () => {
  const s = setup();
  const hid = s.id();
  assert.equal(s.create(hid, v2()).status, 201);
  const d = v2(DEC);
  const r = s.update(hid, 5, d);
  assert.equal(r.status, 409);
  assert.equal(r.headers[HDR], undefined);
  assert.equal(s.update(hid, 1, d).headers[HDR], String(DEC.exp));
});

/* ------------------------- transactions, GC, schema ---------------------- */

function tmpDb(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "sitr-ent-v2-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "sync.sqlite");
}

test("a failing write burns nothing (create and update)", (ctx) => {
  const db = tmpDb(ctx);
  const s = setup({ db });
  const raw = new DatabaseSync(db);
  const hid = s.id();
  const t = v2();
  raw.exec("CREATE TRIGGER no_insert BEFORE INSERT ON blobs BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  assert.throws(() => s.create(hid, t), /boom/);
  raw.exec("DROP TRIGGER no_insert");
  assert.equal((raw.prepare("SELECT count(*) AS n FROM used_tokens").get() as { n: number }).n, 0);
  assert.equal(s.create(hid, t).status, 201);

  const d = v2(DEC);
  raw.exec("CREATE TRIGGER no_update BEFORE UPDATE ON blobs BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  assert.throws(() => s.update(hid, 1, d), /boom/);
  raw.exec("DROP TRIGGER no_update");
  assert.equal((raw.prepare("SELECT count(*) AS n FROM used_tokens").get() as { n: number }).n, 1);
  assert.equal(s.update(hid, 1, d).headers[HDR], String(DEC.exp));
  raw.close();
  s.store.close();
});

test("GC: test households by test_delete_day, used_tokens once exp < now; lapsed kept", (ctx) => {
  const db = tmpDb(ctx);
  const s = setup({ db });
  const raw = new DatabaseSync(db);
  const count = (sql: string) => (raw.prepare(sql).get() as { n: number }).n;
  const prod = s.id();
  const testH = s.id();
  assert.equal(s.create(prod, v2()).status, 201);
  assert.equal(s.create(testH, v2({ test: true, per: T("2026-11-20"), exp: T("2026-11-21T01:00:00Z") })).status, 201);
  assert.equal(count("SELECT test_delete_day AS n FROM blobs WHERE test_delete_day IS NOT NULL"), Math.floor(T("2026-11-27") / DAY));
  assert.equal(count("SELECT count(*) AS n FROM used_tokens"), 2);
  // 21 Nov 01:00: the Sandbox token's exp is not < now yet.
  s.store.gc(T("2026-11-21T01:00:00Z"), 540 * DAY);
  assert.equal(count("SELECT count(*) AS n FROM used_tokens"), 2);
  s.store.gc(T("2026-11-21T01:00:00.001Z"), 540 * DAY);
  assert.equal(count("SELECT count(*) AS n FROM used_tokens"), 1);
  // Day 27 (= test_delete_day) keeps it; day 28 deletes it. The production
  // household, lapsed since 4 December, stays.
  assert.equal(s.store.gc(T("2026-11-27T23:00:00Z"), 540 * DAY), 0);
  assert.equal(s.store.gc(T("2026-12-20"), 540 * DAY), 1);
  assert.equal(count("SELECT count(*) AS n FROM used_tokens"), 0);
  assert.equal(count("SELECT count(*) AS n FROM blobs"), 1);
  assert.equal(s.store.lookup(prod, sha(AUTH)).kind, "ok");
  // The 18-month idle rule still applies.
  assert.equal(s.store.gc(T("2026-11-20") + 541 * DAY, 540 * DAY), 1);
  raw.close();
  s.store.close();
});

test("migration: a version 1 database file upgrades in place, twice, rows become legacy", (ctx) => {
  const db = tmpDb(ctx);
  const raw = new DatabaseSync(db);
  raw.exec(`CREATE TABLE blobs (
    id TEXT PRIMARY KEY, auth_hash BLOB NOT NULL, blob BLOB NOT NULL,
    write_counter INTEGER NOT NULL, last_write_day INTEGER NOT NULL) STRICT;`);
  const hid = "f".repeat(32);
  raw.prepare("INSERT INTO blobs VALUES (?, ?, ?, 3, ?)").run(hid, sha(AUTH), new Uint8Array([7]), 20000);
  raw.close();
  new SyncStore(db).close();
  const s = setup({ db, cutover: "2027-03-01" });
  const check = new DatabaseSync(db);
  const cols = (check.prepare("PRAGMA table_info(blobs)").all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(cols.slice(-2), ["ent_exp", "test_delete_day"]);
  assert.ok(check.prepare("SELECT name FROM sqlite_master WHERE name = 'used_tokens'").get());
  check.close();
  const lk = s.store.lookup(hid, sha(AUTH));
  assert.ok(lk.kind === "ok" && lk.entExp === null && lk.test === false);
  const r = s.update(hid, 3);
  assert.equal(r.status, 200);
  assert.equal(r.headers[HDR], String(T("2027-03-01")));
  s.store.close();
});

test("open mode: checks nothing, stores no end, sends no header, even with a cut-over set", () => {
  const s = setup({ open: true, cutover: "2026-01-01" });
  const hid = s.id();
  const c = s.create(hid, "garbage");
  assert.equal(c.status, 201);
  assert.equal(c.headers[HDR], undefined);
  const u = s.update(hid, 1, v2());
  assert.equal(u.status, 200);
  assert.equal(u.headers[HDR], undefined);
  assert.equal(s.call("GET", hid).headers[HDR], undefined);
  const lk = s.store.lookup(hid, sha(AUTH));
  assert.ok(lk.kind === "ok" && lk.entExp === null);
  // As today: If-Match on an unknown id creates.
  assert.equal(s.update(s.id(), 1).status, 201);
});
