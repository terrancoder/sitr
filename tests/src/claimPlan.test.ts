/**
 * Entitlement version 2 on the client (extension/src/lib/entitlement.ts;
 * docs/sync-protocol.md §What each client must do). Fixed clocks and fixed
 * "random" values. apps/shared/fixtures/claim.json pins the same rules for
 * Android and iOS; these tests read on their own.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TEXTS,
  claimOutcome,
  classifyCodeInput,
  created,
  emptyClaimState,
  forcesWrite,
  forgetClaims,
  isVersion1Token,
  next,
  notice,
  observe,
  offersReplace,
  parseToken,
  record,
  retriesCreate,
  sanitizeClaimState,
  tokenToSend,
  userRetry,
  type ClaimOutcome,
  type ClaimState,
  type EntitlementToken,
  type SyncAnswer,
} from "../../extension/dist/lib/entitlement.js";
import { DAY, HOUR, endNotice, parseEndHeader, parseSyncRefusal } from "../../extension/dist/lib/householdEnd.js";

const MIN = 60_000;
const nov1 = Date.UTC(2026, 10, 1);
const nov10 = Date.UTC(2026, 10, 10);
const nov24 = Date.UTC(2026, 10, 24);
const nov29 = Date.UTC(2026, 10, 29);
const dec1 = Date.UTC(2026, 11, 1);
const dec3 = Date.UTC(2026, 11, 3);
const dec4 = Date.UTC(2026, 11, 4);
const dec25 = Date.UTC(2026, 11, 25);
const dec26 = Date.UTC(2026, 11, 26);
const jan1 = Date.UTC(2027, 0, 1);
const jan4 = Date.UTC(2027, 0, 4);
const feb4 = Date.UTC(2027, 1, 4);
const H = "h1";

function token(per: number, exp: number, extra: Record<string, unknown> = {}): EntitlementToken {
  const payload = { v: 2, plan: "family", term: "month", per, exp, jti: "AAAAAAAAAAAAAAAAAAAAAA", ...extra };
  const t = parseToken(`sitr-ent-v2.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2ln`);
  assert.ok(t !== null);
  return t;
}
const NOV = token(nov1, dec4);
const DEC = token(dec1, jan4);
const JAN = token(jan1, feb4);

const applied = (entExp: number, more: Partial<ClaimState> = {}): ClaimState => ({
  ...emptyClaimState(),
  appliedHousehold: H,
  entExp,
  ...more,
});
const decide = (s: ClaimState, now: number, random = 0, householdId = H) =>
  next(s, now, householdId, () => random).decision;
const answer = (entExp: number | null, more: Partial<SyncAnswer> = {}): SyncAnswer => ({
  entExp,
  lapsed: false,
  succeeded: true,
  forced: null,
  ...more,
});
const refused = (reason: string, retryAfter: number | null = null): ClaimOutcome =>
  ({ kind: "refused", reason, retryAfter }) as ClaimOutcome;
const NONE = { kind: "none" };
const CLAIM = { kind: "claim", replace: false, current: false };
const CURRENT = { kind: "claim", replace: false, current: true };
const wait = (until: number) => ({ kind: "wait", until });

/* token and input */

test("a version 2 token is read without its signature; anything else is not", () => {
  const t = token(dec1, jan4, { term: "year", test: true });
  assert.deepEqual({ ...t, raw: "" }, { raw: "", plan: "family", term: "year", per: dec1, exp: jan4, test: true });
  assert.equal(parseToken(t.raw.replace("sitr-ent-v2", "sitr-ent-v1")), null);
  assert.equal(parseToken("sitr-ent-v2.e30"), null);
  assert.equal(parseToken(`${t.raw}.x`), null);
  assert.equal(token(dec1, jan4, { plan: "inst-starter" }).plan, "inst-starter");
});

test("the one input field tells a subscription code from a version 1 token by shape", () => {
  assert.deepEqual(classifyCodeInput(" 3F2B8C4E-9D1A-4E7B-A6C5-0F1E2D3C4B5A\n"), {
    kind: "code",
    code: "3f2b8c4e-9d1a-4e7b-a6c5-0f1e2d3c4b5a",
  });
  assert.equal(classifyCodeInput("01932c07-209c-7a5e-8b3f-1234567890ab").kind, "code", "any version");
  assert.equal(classifyCodeInput("3f2b8c4e9d1a4e7ba6c50f1e2d3c4b5a").kind, "invalid");
  assert.deepEqual(classifyCodeInput("sitr-ent-v1.e30.c2ln"), { kind: "v1-token", token: "sitr-ent-v1.e30.c2ln" });
  assert.equal(isVersion1Token("sitr-ent-v1.e30"), false);
  assert.equal(classifyCodeInput(DEC.raw).kind, "invalid", "a version 2 token is not typed in");
});

/* claim answers */

test("claim answers map to outcomes", () => {
  const err = (e: string, more = {}) => JSON.stringify({ error: e, ...more });
  assert.deepEqual(claimOutcome(200, JSON.stringify({ token: DEC.raw })), { kind: "token", token: DEC });
  const inst = token(dec1, jan4, { plan: "inst-standard" });
  assert.deepEqual(claimOutcome(200, JSON.stringify({ token: inst.raw })), { kind: "not-family", plan: "inst-standard" });
  assert.deepEqual(claimOutcome(409, err("replacement-used", { retry_after: 123 })), refused("replacement-used", 123));
  assert.deepEqual(claimOutcome(422, err("family-sharing")), refused("family-sharing"));
  assert.deepEqual(claimOutcome(404, err("not-found")), refused("unrecognized"));
  for (const status of [429, 500, 502, 503]) assert.deepEqual(claimOutcome(status, "{}"), { kind: "unavailable" });
  assert.deepEqual(claimOutcome(0, null), { kind: "unavailable" }, "no network");
  assert.deepEqual(claimOutcome(404, "not found\n"), { kind: "unavailable" }, "not the claim API's JSON");
  assert.deepEqual(claimOutcome(200, JSON.stringify({ token: "garbage" })), { kind: "unavailable" });
});

test("sync 402 reasons, including the version 1 server's bodies", () => {
  assert.equal(parseSyncRefusal(402, "lapsed\n"), "lapsed");
  assert.equal(parseSyncRefusal(402, "plan-not-accepted\nmore"), "plan-not-accepted");
  assert.equal(parseSyncRefusal(402, "entitlement required\n"), "token-required");
  assert.equal(parseSyncRefusal(402, "malformed entitlement token\n"), "token-invalid");
  assert.equal(parseSyncRefusal(402, "entitlement expired — please renew\n"), "token-expired");
  assert.equal(parseSyncRefusal(402, "server responded"), null);
  assert.equal(parseSyncRefusal(409, "lapsed"), null);
  assert.ok(retriesCreate("token-used") && !retriesCreate("v1-ended") && !retriesCreate("lapsed"));
});

/* when to claim */

test("(b) claims at once in a household this device never applied a token to", () => {
  assert.deepEqual(decide({ ...emptyClaimState(), entExp: dec4 }, nov10), CLAIM);
  assert.deepEqual(decide(applied(dec4, { appliedHousehold: "other" }), nov10), CLAIM);
  assert.deepEqual(decide({ ...emptyClaimState(), tokens: [NOV] }, nov10), NONE, "not while a token is held");
});

test("(c) waits for a random time in the first 5 days, then claims; from E − 5 days at once", () => {
  const s = applied(dec4);
  const first = next(s, nov24 - 1, H, () => 0.5);
  assert.deepEqual(first.decision, wait(nov24 + 2.5 * DAY));
  assert.equal(first.state.windowFor, dec4);
  // The drawn time is kept, not redrawn.
  assert.deepEqual(decide(first.state, nov24 + 2.5 * DAY - 1, 0), wait(nov24 + 2.5 * DAY));
  assert.deepEqual(decide(first.state, nov24 + 2.5 * DAY), CLAIM);
  assert.deepEqual(decide(s, nov29, 0.75), CLAIM);
});

test("a token that does not move E: again a day later; one that does: wait for the write", () => {
  const now = nov29;
  const same = record(applied(dec4), { kind: "token", token: NOV }, false, now);
  assert.equal(same.notBefore, now + DAY);
  assert.deepEqual(decide(same, now + DAY - 1), wait(now + DAY));
  const moved = record(applied(dec4), { kind: "token", token: DEC }, false, now);
  assert.equal(moved.notBefore, null);
  assert.deepEqual(decide(moved, now + 1), NONE);
  assert.ok(forcesWrite(moved));
  const after = observe(moved, answer(jan4, { forced: DEC.raw }), H, now + 2);
  assert.deepEqual(after.tokens, []);
  assert.ok(!forcesWrite(after));
});

test("two tokens: the one that is not early goes first", () => {
  const s = applied(dec4, { tokens: [JAN, DEC] });
  assert.equal(tokenToSend(s), DEC);
  assert.equal(tokenToSend(observe(s, answer(jan4), H, dec26)), JAN);
});

test("(d) lapsed: a claim with current: true, then the window again once reopened", () => {
  let s = applied(dec4);
  assert.deepEqual(decide(s, dec26), CURRENT);
  assert.deepEqual(decide(applied(dec4 + 40 * DAY, { lapsed: true }), dec26), CURRENT, "a 402 lapsed counts");
  s = record(s, { kind: "token", token: DEC }, true, dec26);
  assert.deepEqual(decide(s, dec26 + 1), NONE, "waits for the current token to reach the server");
  s = observe(s, answer(jan4, { forced: DEC.raw }), H, dec26 + 2);
  assert.ok(!s.lapsed && !s.lapseClaimed);
  assert.deepEqual(decide(s, dec26 + 3, 0), CLAIM, "the January window is already open (25 December)");
  assert.equal(next(s, dec26 + 3, H, () => 0).state.windowAt, dec25);
});

test("payment-pending, inactive, revoked: at most once a day, or when the user asks", () => {
  for (const reason of ["payment-pending", "inactive", "revoked"]) {
    const s = record(applied(dec4), refused(reason), false, dec3);
    assert.ok(!s.stopped && s.lastRefusal === reason);
    assert.deepEqual(decide(s, dec3 + HOUR), wait(dec4));
    assert.deepEqual(decide(s, dec4), CURRENT, "lapsed from E on, and the day has passed");
    assert.deepEqual(decide(userRetry(s), dec3 + HOUR), CLAIM);
  }
});

test("reasons that stop: no claim until the user acts, even when lapsed", () => {
  for (const reason of ["unknown-code", "wrong-product", "invalid-receipt", "test-purchase", "family-sharing", "bad-request", "unrecognized"]) {
    const s = record(applied(dec4), refused(reason), false, dec3);
    assert.ok(s.stopped);
    assert.deepEqual(decide(s, dec4 + DAY), NONE);
    assert.deepEqual(decide(userRetry(s), dec4 + DAY), CURRENT);
  }
});

test("429, 5xx, no network: backoff from 5 minutes, doubling, at most 6 hours", () => {
  let s = applied(dec4);
  const waits: number[] = [];
  for (let i = 0; i < 9; i++) {
    s = record(s, { kind: "unavailable" }, false, nov29);
    waits.push((s.notBefore ?? 0) - nov29);
  }
  assert.deepEqual(waits.map((w) => w / MIN), [5, 10, 20, 40, 80, 160, 320, 360, 360]);
  assert.equal(record(s, { kind: "token", token: DEC }, false, nov29).backoff, null);
});

/* bound-to-other-device */

test("bound elsewhere, E in the future: no claim by (b), in the window, or daily", () => {
  const s = record(applied(dec4), refused("bound-to-other-device"), false, nov29);
  assert.equal(s.notBefore, null);
  for (const now of [nov29 + HOUR, nov29 + DAY, dec3]) assert.deepEqual(decide(s, now), NONE);
  assert.deepEqual(decide(s, dec3, 0, "h2"), NONE, "not by rule (b)");
  assert.deepEqual(decide(userRetry(s), dec3), NONE, "Try again does not lift it");
  assert.deepEqual(decide({ ...emptyClaimState(), lastRefusal: "bound-to-other-device" }, nov10), NONE, "no E");
  assert.ok(!offersReplace(s, nov29));
  assert.ok(offersReplace(s, dec3), "E − now < 2 days");
});

test("bound elsewhere, E passed: one claim with current at once, then daily; stops when E moves", () => {
  let s = record(applied(dec4), refused("bound-to-other-device"), false, dec4 - HOUR);
  assert.deepEqual(decide(s, dec4 + MIN), CURRENT, "less than a day after the refusal");
  assert.ok(!offersReplace(s, dec4 + MIN), "not before the claim without replace was refused");
  s = record(s, refused("bound-to-other-device"), true, dec4 + MIN);
  assert.ok(offersReplace(s, dec4 + HOUR));
  assert.equal(notice(s, dec4 + HOUR, true), "waiting");
  assert.deepEqual(decide(s, dec4 + HOUR), wait(dec4 + MIN + DAY));
  assert.deepEqual(decide(s, dec4 + MIN + DAY), CURRENT);
  s = observe(s, answer(jan4), H, dec4 + 2 * HOUR);
  assert.deepEqual(decide(s, dec4 + 3 * HOUR), NONE);
  assert.ok(!offersReplace(s, dec4 + 3 * HOUR));
});

test("bound elsewhere is forgotten after a token or when the code is entered again", () => {
  const s = applied(dec4, { lastRefusal: "bound-to-other-device" });
  assert.equal(record(s, { kind: "token", token: DEC }, true, dec4 + MIN).lastRefusal, null);
  assert.deepEqual(decide(forgetClaims(s), nov29), CLAIM);
});

test("replacement-used keeps the date and the bound rule: one claim once E has passed", () => {
  const until = dec4 + 6 * DAY;
  let s = record(applied(dec4, { lastRefusal: "bound-to-other-device" }), refused("replacement-used", until), false, dec3);
  assert.equal(s.retryAfter, until);
  assert.ok(!offersReplace(s, dec3));
  assert.equal(notice(s, dec3, true), "replacement-used");
  assert.deepEqual(decide(s, dec3 + MIN), NONE);
  assert.deepEqual(decide(s, dec4 + MIN), CURRENT);
  s = record(s, refused("bound-to-other-device"), true, dec4 + MIN);
  assert.ok(!offersReplace(s, dec4 + HOUR), "not before retry_after");
  assert.ok(offersReplace(s, until), "from retry_after on");
});

test("householdEnd: the header, the neutral notice, a version 1 household never read-only", () => {
  assert.equal(parseEndHeader(" 1796342400000 "), dec4);
  for (const bad of [null, "", "12a", "-1", "1".repeat(17)]) assert.equal(parseEndHeader(bad), null);
  const end = { entExp: dec4, lapsed: false, testHousehold: false };
  assert.equal(endNotice(end, dec3 - DAY), "none");
  assert.equal(endNotice(end, dec3), "waiting");
  assert.equal(endNotice({ ...end, entExp: null }, dec26), "none");
  assert.equal(TEXTS.waiting, TEXTS.waiting.replace(/subscri|purchase|polar|checkout|upgrade/gi, ""));
});

/* other rules */

test("an Institutions code: the claim's token is dropped with everything this device knew about claims", () => {
  const s = applied(dec4, { lastRefusal: "bound-to-other-device", tokens: [DEC] });
  const after = record(s, { kind: "not-family", plan: "inst-starter" }, false, nov10);
  assert.deepEqual(after, { ...emptyClaimState(), entExp: dec4 });
  assert.equal(TEXTS["plan-not-accepted"], "This is a code for Sitr for Institutions.");
});

test("no expires header: a version 1 household — one claim, then none while the token is held", () => {
  let s = observe(emptyClaimState(), answer(null), H, nov10);
  assert.deepEqual(decide(s, nov10), CLAIM);
  s = record(s, { kind: "token", token: NOV }, false, nov10);
  assert.equal(s.notBefore, null);
  s = observe(s, answer(null, { forced: NOV.raw }), H, nov10 + MIN);
  assert.equal(s.tokens.length, 1);
  assert.deepEqual(decide(s, nov29), NONE);
  assert.equal(notice(s, nov29, true), "none");
  s = observe(s, answer(null), H, dec4);
  assert.deepEqual(decide(s, dec4 + MIN), CLAIM, "after the held token's exp");
});

test("a successful round without the header ends E; a failed one does not", () => {
  const s = applied(dec4, { lapsed: true });
  assert.equal(observe(s, answer(null, { succeeded: false }), H, dec26).entExp, dec4);
  const v1 = observe(s, answer(null), H, dec26);
  assert.ok(v1.entExp === null && !v1.lapsed);
  assert.equal(notice(v1, dec26, true), "none");
});

test("a test household claims when E is less than an hour away, and gets no 2-day notice", () => {
  const nov21 = Date.UTC(2026, 10, 21);
  const t = token(Date.UTC(2026, 10, 20), nov21 + HOUR, { test: true });
  const s = created(record(emptyClaimState(), { kind: "token", token: t }, false, nov10), t, H, nov21 + HOUR);
  assert.ok(s.testHousehold && s.tokens.length === 0);
  assert.deepEqual(decide(s, nov21), wait(nov21 + 1), "exactly an hour away is not less");
  assert.deepEqual(decide(s, nov21 + 1), CLAIM);
  assert.equal(notice(s, nov21, true), "none");
});

test("notices: neutral unless this device's claim said otherwise; the legacy notice without a code", () => {
  const s = applied(dec4);
  assert.equal(notice(s, dec4 - 3 * DAY, true), "none");
  assert.equal(notice(s, dec4 - DAY, true), "waiting");
  assert.equal(notice({ ...s, lastRefusal: "inactive" }, dec4, true), "ended");
  assert.equal(notice({ ...s, lastRefusal: "payment-pending" }, dec4, true), "payment-problem");
  const mar1 = Date.UTC(2027, 2, 1);
  const legacy = observe(emptyClaimState(), answer(mar1), H, nov10);
  assert.equal(notice(legacy, nov10, false), "enter-code");
  assert.equal(notice(legacy, mar1 - 30 * DAY, false), "enter-code", "once seen more than 41 days away");
  assert.equal(notice(legacy, nov10, true), "none", "a device with the code renews instead");
  assert.equal(notice(applied(mar1 - 30 * DAY), nov10 + 50 * DAY, false), "none");
});

test("stored state: round-trips, fills missing fields, and falls back to empty when malformed", () => {
  const s = record(applied(dec4), { kind: "token", token: DEC }, true, dec26);
  assert.deepEqual(sanitizeClaimState(JSON.parse(JSON.stringify(s))), s);
  assert.deepEqual(sanitizeClaimState({ entExp: dec4 }), { ...emptyClaimState(), entExp: dec4 });
  assert.deepEqual(sanitizeClaimState({ entExp: "soon" }), emptyClaimState());
  assert.deepEqual(sanitizeClaimState({ lastRefusal: "nope" }), emptyClaimState());
  assert.deepEqual(sanitizeClaimState({ tokens: [{ raw: "x" }] }), emptyClaimState());
  assert.deepEqual(sanitizeClaimState(null), emptyClaimState());
});
