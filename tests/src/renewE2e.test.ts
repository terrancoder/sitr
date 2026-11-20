// The extension's background renewal round (lib/sync/renew.ts) against the
// real claim and sync handlers in process, with a fake clock. Polar is a
// stub; every test asserts that no request went anywhere but the two
// in-process hosts, and the global fetch throws if anything reaches it.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { renewAndSync, newClaimSecret, type RenewResult } from "../../extension/dist/lib/sync/renew.js";
import { emptyClaimState, parseToken, type ClaimState } from "../../extension/dist/lib/entitlement.js";
import { deriveKeys, generateRootSecret } from "../../extension/dist/lib/sync/crypto.js";
import { bumpRev, emptyHouseholdState, type HouseholdState } from "../../extension/dist/lib/household.js";
import { ClaimHandler } from "../../server/sync/dist/claim.js";
import { ClaimStore } from "../../server/sync/dist/claim-store.js";
import { SyncHandler, type SyncRequest, type SyncResponse } from "../../server/sync/dist/http.js";
import { SyncStore } from "../../server/sync/dist/store.js";
import { configFromEnv } from "../../server/sync/dist/config.js";
import { keygen, mintToken, privateKeyFromB64 } from "../../server/sync/dist/mint.js";

const CLAIM = "https://claim.test";
const SYNC = "https://sync.test";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (iso: string) => Date.parse(iso);
const YEARLY = "6f1c2a3b-1d2e-4f50-8a9b-0c1d2e3f4a5b";
const MONTHLY = "6f1c2a3b-1d2e-4f50-8a9b-000000000010";
const INST = "6f1c2a3b-1d2e-4f50-8a9b-000000000011";

let realFetch: typeof fetch;
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("global fetch used");
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

function toResponse(res: SyncResponse): Response {
  return new Response(res.body.length > 0 ? (res.body as unknown as BodyInit) : null, {
    status: res.status,
    headers: res.headers,
  });
}

function toRequest(input: RequestInfo | URL, init?: RequestInit): SyncRequest {
  const headers = new Headers(init?.headers);
  const body = init?.body;
  return {
    method: init?.method ?? "GET",
    path: new URL(String(input)).pathname,
    ip: "192.0.2.1",
    headers: {
      authorization: headers.get("authorization") ?? undefined,
      "if-match": headers.get("if-match") ?? undefined,
      "if-none-match": headers.get("if-none-match") ?? undefined,
      "x-sitr-entitlement": headers.get("x-sitr-entitlement") ?? undefined,
    },
    body:
      body === undefined || body === null
        ? new Uint8Array(0)
        : typeof body === "string"
          ? new TextEncoder().encode(body)
          : new Uint8Array(body as ArrayBufferLike & Uint8Array),
  };
}

interface Sent {
  url: string;
  init: RequestInit | undefined;
  t: number;
}

type Polar = Record<string, { status: string; interval: string; end: string; product?: string } | "down">;

/** Both handlers behind one fetch; any other host throws. `polar` may be
 * changed during a test (a renewal, a failed payment, an outage). */
function world(opts: { enforcing?: boolean } = {}) {
  const clock = { t: at("2026-11-20T12:00:00Z") };
  const polar: Polar = {
    [YEARLY]: { status: "active", interval: "year", end: "2027-06-01T00:00:00Z" },
    [MONTHLY]: { status: "active", interval: "month", end: "2026-11-28T00:00:00Z" },
    [INST]: { status: "active", interval: "year", end: "2027-06-01T00:00:00Z", product: "prod_i" },
  };
  const polarFetch = (async (input: RequestInfo | URL) => {
    const a = polar[String(input).split("/").pop()!];
    if (a === undefined) return new Response("{}", { status: 404 });
    if (a === "down") return new Response("{}", { status: 500 });
    const product = a.product ?? (a.interval === "year" ? "prod_y" : "prod_m");
    return Response.json({ status: a.status, product_id: product, recurring_interval: a.interval, current_period_end: a.end });
  }) as unknown as typeof fetch;
  const kp = keygen();
  const base = configFromEnv({ SITR_POLAR_PRODUCTS: "prod_y=family:year,prod_m=family:month,prod_i=inst-starter:year" });
  const claimHandler = new ClaimHandler(
    { ...base, entitlementPrivKeyB64: kp.privateB64, polarAccessToken: "t", claimKey: Buffer.alloc(32, 4) },
    () => clock.t,
    polarFetch,
    { store: new ClaimStore(":memory:") },
  );
  const syncConfig = opts.enforcing === false ? configFromEnv({}) : { ...base, entitlementPubKeyB64: kp.publicB64 };
  const syncHandler = new SyncHandler(new SyncStore(":memory:"), syncConfig, () => clock.t);
  const sent: Sent[] = [];
  const route = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, init, t: clock.t });
    const origin = new URL(url).origin;
    if (origin === CLAIM) return toResponse(await claimHandler.handle(toRequest(input, init)));
    if (origin === SYNC) return toResponse(syncHandler.handle(toRequest(input, init)));
    throw new TypeError(`no such host: ${origin}`);
  }) as typeof fetch;
  const v1Token = (exp: number) => mintToken(privateKeyFromB64(kp.privateB64), "family", exp);
  return { clock, polar, sent, fetch: route, v1Token };
}
type World = ReturnType<typeof world>;

interface Device {
  root: Uint8Array;
  local: HouseholdState;
  maxSeenRev: number;
  deviceId: string;
  code: string | null;
  secret: string | null;
  role: string | undefined;
  claimState: ClaimState;
  v1: string | undefined;
  allowed: boolean;
  /** This device's clock minus the servers'. */
  skew: number;
}

function creator(code: string | null, more: Partial<Device> = {}): Device {
  return {
    root: generateRootSecret(),
    local: { ...emptyHouseholdState("dev-a", 1000), blockDomains: ["a.example"] },
    maxSeenRev: 0,
    deviceId: "dev-a",
    code,
    secret: code === null ? null : newClaimSecret(),
    role: "guardian",
    claimState: emptyClaimState(),
    v1: undefined,
    allowed: true,
    skew: 0,
    ...more,
  };
}

/** A device that joins `of`'s household by pairing code. */
const joiner = (of: Device, code: string | null, more: Partial<Device> = {}): Device =>
  creator(code, { root: of.root, local: emptyHouseholdState("dev-b", 0), deviceId: "dev-b", ...more });

async function round(w: World, d: Device, random = 0.5): Promise<RenewResult> {
  const now = () => w.clock.t + d.skew;
  const r = await renewAndSync(
    {
      sync: { rootSecret: d.root, local: d.local, maxSeenRev: d.maxSeenRev, deviceId: d.deviceId, entitlement: d.v1 },
      code: d.code,
      claimSecret: d.secret,
      role: d.role,
      claimState: d.claimState,
    },
    { fetch: w.fetch, now, baseUrl: SYNC, claimBaseUrl: CLAIM, random: () => random, claimAllowed: async () => d.allowed },
  );
  if (r.outcome.status.state === "ok") {
    d.local = r.outcome.state;
    d.maxSeenRev = r.outcome.maxSeenRev;
  }
  d.claimState = r.claimState;
  if (r.forgetCode) {
    d.code = null;
    d.secret = null;
  }
  return r;
}

/** Rounds every `step` (the 30-minute alarm) from now up to and including `until`. */
async function rounds(w: World, d: Device, until: number, step = 30 * MIN, random = 0.5): Promise<void> {
  for (; w.clock.t <= until; w.clock.t += step) await round(w, d, random);
  w.clock.t -= step;
}

const claimsSent = (w: World) => w.sent.filter((s) => new URL(s.url).origin === CLAIM);
const claimBodies = (w: World) => claimsSent(w).map((s) => JSON.parse(String(s.init?.body)) as Record<string, unknown>);
const puts = (w: World) => w.sent.filter((s) => s.init?.method === "PUT");
const sentToken = (s: Sent) => parseToken(new Headers(s.init?.headers).get("X-Sitr-Entitlement") ?? "");
const householdId = async (d: Device) => {
  const k = await deriveKeys(d.root);
  assert.ok(k.ok);
  return k.value.householdId;
};

function onlyLocalHosts(w: World): void {
  assert.ok(w.sent.length > 0);
  for (const s of w.sent) assert.ok([CLAIM, SYNC].includes(new URL(s.url).origin), s.url);
}

test("create with a code, nothing due sends nothing to the claim host, then the window renews by a forced write", async () => {
  const w = world();
  const a = creator(YEARLY);
  const r = await round(w, a);
  assert.equal(r.outcome.status.state, "ok");
  assert.equal(claimsSent(w).length, 1, "rule (b) before the creating write");
  assert.equal(new Headers(puts(w)[0]!.init?.headers).get("If-None-Match"), "*");
  assert.equal(sentToken(puts(w)[0]!)?.exp, at("2026-12-04"));
  assert.equal(a.claimState.entExp, at("2026-12-04"));
  assert.equal(a.claimState.appliedHousehold, await householdId(a));
  assert.deepEqual(a.claimState.tokens, []);

  // random 0.5: the first attempt at E − 10 days + 2.5 days = 26 Nov 12:00.
  w.clock.t += 30 * MIN;
  await rounds(w, a, at("2026-11-26T11:30:00Z"));
  assert.equal(claimsSent(w).length, 1, "no claim before the drawn time");
  assert.equal(a.claimState.windowAt, at("2026-11-26T12:00:00Z"));
  const putsBefore = puts(w).length;
  w.clock.t = at("2026-11-26T12:00:00Z");
  await round(w, a);
  assert.equal(claimsSent(w).length, 2);
  assert.equal(claimBodies(w)[1]!.current, false);
  assert.equal(puts(w).length, putsBefore + 1, "the forced write");
  const dec = sentToken(puts(w).at(-1)!);
  assert.deepEqual([dec?.per, dec?.exp], [at("2026-12-01"), at("2027-01-04")]);
  assert.equal(a.claimState.entExp, at("2027-01-04"), "the end date moved");
  assert.deepEqual(a.claimState.tokens, []);

  w.clock.t += 30 * MIN;
  await rounds(w, a, at("2026-12-20T00:00:00Z"));
  assert.equal(claimsSent(w).length, 2, "nothing due until the next window");
  assert.equal(puts(w).length, putsBefore + 1, "and nothing written");
  onlyLocalHosts(w);
});

test("a monthly token whose exp is not later than E: again a day later, then next month's", async () => {
  const w = world();
  const a = creator(MONTHLY);
  await round(w, a, 0);
  assert.equal(a.claimState.entExp, at("2026-12-04"));
  w.clock.t = at("2026-11-24T00:00:00Z"); // random 0: the window's first instant
  await rounds(w, a, at("2026-11-27T23:30:00Z"), 30 * MIN, 0);
  // Paid end 28 Nov is not after 1 Dec: the November token again, daily.
  assert.deepEqual(
    claimsSent(w).slice(1).map((s) => s.t),
    ["24", "25", "26", "27"].map((d) => at(`2026-11-${d}T00:00:00Z`)),
  );
  assert.equal(a.claimState.entExp, at("2026-12-04"));
  // Polar renews it on the 28th.
  w.polar[MONTHLY] = { status: "active", interval: "month", end: "2026-12-28T00:00:00Z" };
  w.clock.t = at("2026-11-28T00:00:00Z");
  await round(w, a, 0);
  assert.equal(claimsSent(w).length, 6);
  assert.equal(a.claimState.entExp, at("2027-01-04"));
  onlyLocalHosts(w);
});

test("lapse: a claim with current: true reopens the household, then the open window extends it", async () => {
  const w = world();
  const a = creator(YEARLY);
  await round(w, a);
  w.clock.t = at("2026-12-26T00:00:00Z"); // off since creation; E = 4 Dec has passed
  await round(w, a, 0);
  assert.equal(claimBodies(w)[1]!.current, true);
  assert.equal(a.claimState.entExp, at("2027-01-04"), "the December token reopened it");
  assert.equal(a.claimState.lapsed, false);
  w.clock.t += 30 * MIN;
  await round(w, a, 0);
  assert.equal(claimBodies(w)[2]!.current, false);
  assert.equal(a.claimState.entExp, at("2027-02-04"), "the early January token extends the open household");
  onlyLocalHosts(w);
});

test("a legacy version 1 household converts at the next round after its owner enters a code", async () => {
  const w = world();
  const a = creator(null, { v1: w.v1Token(w.clock.t + 7 * DAY) });
  await round(w, a);
  assert.equal(a.claimState.entExp, null, "no end header: legacy");
  await rounds(w, a, at("2026-11-22T00:00:00Z"));
  assert.equal(claimsSent(w).length, 0, "no code: nothing to the claim host");
  a.code = YEARLY;
  a.secret = newClaimSecret();
  w.clock.t += 30 * MIN;
  await round(w, a);
  assert.equal(claimsSent(w).length, 1);
  assert.equal(a.claimState.entExp, at("2026-12-04"), "the token turned it into a tracked household");
  assert.equal(a.claimState.appliedHousehold, await householdId(a));
  w.clock.t += 30 * MIN;
  await rounds(w, a, at("2026-11-23T00:00:00Z"));
  assert.equal(claimsSent(w).length, 1);
  onlyLocalHosts(w);
});

test("no end header (open mode): one claim, then none while the token is held, again once it expired", async () => {
  const w = world({ enforcing: false });
  const a = creator(YEARLY);
  await round(w, a);
  assert.equal(claimsSent(w).length, 1);
  w.clock.t += 6 * HOUR;
  await rounds(w, a, at("2026-12-03T23:00:00Z"), 6 * HOUR);
  assert.equal(claimsSent(w).length, 1);
  w.clock.t = at("2026-12-04T00:00:00Z");
  await round(w, a);
  assert.equal(claimsSent(w).length, 2, "the held token's exp passed");
  onlyLocalHosts(w);
});

test("bound to another device: no automatic claim while E is in the future; a 402 lapsed claims at once with current: true", async () => {
  const w = world();
  const a = creator(YEARLY);
  await round(w, a);
  const b = joiner(a, YEARLY);
  w.clock.t = at("2026-11-21T00:00:00Z");
  await round(w, b, 0);
  assert.equal(claimsSent(w).length, 2);
  assert.equal(b.claimState.lastRefusal, "bound-to-other-device");
  assert.equal(b.claimState.entExp, at("2026-12-04"));
  w.clock.t += 30 * MIN;
  await rounds(w, b, at("2026-12-03T23:30:00Z"), 30 * MIN, 0);
  assert.equal(claimsSent(w).length, 2, "not by rule (b), not in the window, no daily retry");

  // A is off; the household lapsed on 4 Dec. B's clock runs two days slow,
  // so only the server's 402 tells it, on a local change.
  w.clock.t = at("2026-12-06T00:00:00Z");
  b.skew = -2 * DAY - HOUR;
  b.local = bumpRev({ ...b.local, blockDomains: ["b.example"] }, "dev-b", w.clock.t + b.skew);
  const r = await round(w, b, 0);
  assert.equal(claimsSent(w).length, 3);
  assert.equal(claimBodies(w)[2]!.current, true);
  assert.equal(claimBodies(w)[2]!.replace, false);
  assert.equal(r.outcome.status.state, "ok", "the stale binding rebinds, the token reopens, the change syncs");
  assert.equal(b.claimState.entExp, at("2027-01-04"));
  assert.deepEqual(b.local.blockDomains, ["b.example"]);
  onlyLocalHosts(w);
});

test("payment pending: at most one claim a day", async () => {
  const w = world();
  const a = creator(YEARLY);
  await round(w, a);
  w.polar[YEARLY] = { status: "past_due", interval: "year", end: "2027-06-01T00:00:00Z" };
  w.clock.t = at("2026-11-24T00:00:00Z");
  await rounds(w, a, at("2026-11-27T23:30:00Z"), 30 * MIN, 0);
  const times = claimsSent(w).slice(1).map((s) => s.t);
  assert.equal(times.length, 4);
  for (let i = 1; i < times.length; i++) assert.ok(times[i]! - times[i - 1]! >= DAY);
  assert.equal(a.claimState.lastRefusal, "payment-pending");
  onlyLocalHosts(w);
});

test("backoff after 5xx: 5 minutes, doubling, at most 6 hours", async () => {
  const w = world();
  const a = creator(YEARLY);
  await round(w, a);
  w.polar[YEARLY] = "down";
  w.clock.t = at("2026-11-24T00:00:00Z");
  await rounds(w, a, at("2026-11-25T12:00:00Z"), 5 * MIN, 0);
  const times = claimsSent(w).slice(1).map((s) => s.t);
  assert.ok(times.length >= 9, String(times.length));
  for (let i = 1; i < times.length; i++) {
    const want = Math.min(5 * MIN * 2 ** (i - 1), 6 * HOUR);
    assert.equal(times[i]! - times[i - 1]!, want, `gap ${i}`);
  }
  assert.equal(a.claimState.entExp, at("2026-12-04"), "the household keeps working");
  onlyLocalHosts(w);
});

test("claimAllowed false: zero requests to the claim host, at creation, in the window and after the lapse", async () => {
  const w = world();
  const lone = creator(YEARLY, { allowed: false });
  const created = await round(w, lone);
  assert.equal(created.outcome.refusal, "token-required", "no claim, so no creation");
  const a = creator(YEARLY);
  await round(w, a);
  const claimsBefore = claimsSent(w).length;
  const b = joiner(a, YEARLY, { secret: newClaimSecret(), allowed: false });
  await rounds(w, b, at("2026-12-26T00:00:00Z"), 6 * HOUR, 0);
  assert.equal(claimsSent(w).length, claimsBefore);
  assert.equal(claimsBefore, 1, "only the allowed creator's own claim");
  onlyLocalHosts(w);
});

test("a child device never claims", async () => {
  const w = world();
  const a = creator(YEARLY);
  await round(w, a);
  const child = joiner(a, YEARLY, { role: "child" });
  await rounds(w, child, at("2026-12-26T00:00:00Z"), 6 * HOUR, 0);
  assert.equal(claimsSent(w).length, 1, "only the creator's");
  assert.equal(child.claimState.entExp, at("2026-12-04"), "it still learns the end date");
  onlyLocalHosts(w);
});

test("a code of an Institutions plan is forgotten after one claim and creates nothing", async () => {
  const w = world();
  const a = creator(INST);
  const r = await round(w, a);
  assert.equal(r.forgetCode, true);
  assert.equal(a.code, null);
  await rounds(w, a, at("2026-11-22T00:00:00Z"));
  assert.equal(claimsSent(w).length, 1);
  assert.ok(puts(w).every((s) => sentToken(s) === null), "the token is never sent");
  onlyLocalHosts(w);
});

test("creation refused as token-used: claim once more, retry the creation once", async () => {
  const w = world();
  const a = creator(YEARLY);
  await round(w, a);
  // Same code and claim secret, a new household in the same month: the same token.
  const c = creator(YEARLY, { secret: a.secret, deviceId: "dev-c" });
  const before = { claims: claimsSent(w).length, puts: puts(w).length };
  const r = await round(w, c);
  assert.equal(r.outcome.refusal, "token-used");
  assert.equal(claimsSent(w).length - before.claims, 2);
  assert.equal(puts(w).length - before.puts, 2);
  onlyLocalHosts(w);
});
