// The extension's claim call and the version 2 side of its sync round,
// against the real claim and sync handlers in process. Polar is a stub;
// no request leaves this process.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { claim, type ClaimRequest } from "../../extension/dist/lib/sync/claimClient.js";
import { syncOnce } from "../../extension/dist/lib/sync/client.js";
import { deriveKeys, generateRootSecret } from "../../extension/dist/lib/sync/crypto.js";
import { bumpRev, emptyHouseholdState, type HouseholdState } from "../../extension/dist/lib/household.js";
import { ClaimHandler } from "../../server/sync/dist/claim.js";
import { ClaimStore } from "../../server/sync/dist/claim-store.js";
import { SyncHandler, type SyncRequest, type SyncResponse } from "../../server/sync/dist/http.js";
import { SyncStore } from "../../server/sync/dist/store.js";
import { configFromEnv } from "../../server/sync/dist/config.js";
import { keygen } from "../../server/sync/dist/mint.js";

const ROOT = resolve(import.meta.dirname, "../..");
const CLAIM = "https://claim.test";
const SYNC = "https://sync.test";
const SUB = "6f1c2a3b-1d2e-4f50-8a9b-0c1d2e3f4a5b";
const sub = (last: string) => `6f1c2a3b-1d2e-4f50-8a9b-${last}`;
const SECRET = Buffer.alloc(32, 8).toString("base64url");
const OTHER_SECRET = Buffer.alloc(32, 9).toString("base64url");

/** Polar's answers by subscription ID. */
const POLAR: Record<string, { status: number; body?: unknown }> = {
  [SUB]: { status: 200, body: { status: "active", product_id: "prod_y", recurring_interval: "year", current_period_end: "2027-06-01T00:00:00Z" } },
  [sub("000000000001")]: { status: 200, body: { status: "active", product_id: "prod_i", recurring_interval: "year", current_period_end: "2027-06-01T00:00:00Z" } },
  [sub("000000000002")]: { status: 200, body: { status: "canceled", product_id: "prod_y", recurring_interval: "year", current_period_end: "2027-06-01T00:00:00Z" } },
  [sub("000000000003")]: { status: 200, body: { status: "past_due", product_id: "prod_y", recurring_interval: "year", current_period_end: "2027-06-01T00:00:00Z" } },
  [sub("000000000004")]: { status: 500 },
};
const polar = (async (input: RequestInfo | URL) => {
  const id = String(input).split("/").pop()!;
  const a = POLAR[id] ?? { status: 404 };
  return new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status });
}) as unknown as typeof fetch;

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
}

/** Both handlers behind one fetch; any other host throws. */
function world(opts: { v2?: boolean } = {}) {
  const clock = { t: Date.parse("2026-11-20T12:00:00Z") };
  const kp = keygen();
  const base = configFromEnv({ SITR_POLAR_PRODUCTS: "prod_y=family:year,prod_i=inst-starter:year" });
  const claimHandler = new ClaimHandler(
    { ...base, entitlementPrivKeyB64: kp.privateB64, polarAccessToken: "t", claimKey: Buffer.alloc(32, 4) },
    () => clock.t,
    polar,
    { store: new ClaimStore(":memory:") },
  );
  const syncConfig = opts.v2 === false ? configFromEnv({}) : { ...base, entitlementPubKeyB64: kp.publicB64 };
  const syncHandler = new SyncHandler(new SyncStore(":memory:"), syncConfig, () => clock.t);
  const sent: Sent[] = [];
  const route = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, init });
    const origin = new URL(url).origin;
    if (origin === CLAIM) return toResponse(await claimHandler.handle(toRequest(input, init)));
    if (origin === SYNC) return toResponse(syncHandler.handle(toRequest(input, init)));
    throw new TypeError(`no such host: ${origin}`);
  }) as typeof fetch;
  return { clock, sent, fetch: route, claimDeps: { fetch: route, baseUrl: CLAIM }, syncDeps: { fetch: route, now: () => clock.t, baseUrl: SYNC } };
}

const req = (credential: string, extra: Partial<ClaimRequest> = {}): ClaimRequest => ({
  credential,
  claimSecret: SECRET,
  replace: false,
  current: false,
  ...extra,
});

function household(deviceId: string, now: number, domains: string[] = ["a.example"]): HouseholdState {
  return { ...emptyHouseholdState(deviceId, now), blockDomains: domains };
}

const puts = (sent: Sent[]) => sent.filter((s) => s.init?.method === "PUT").length;

test("claim: each outcome", async () => {
  const w = world();
  const t = await claim(req(SUB), w.claimDeps);
  assert.equal(t.kind, "token");
  assert.equal(t.kind === "token" && t.token.exp, Date.parse("2026-12-04"));
  const inst = await claim(req(sub("000000000001")), w.claimDeps);
  assert.deepEqual(inst, { kind: "not-family", plan: "inst-starter" });
  const refused = async (credential: string, extra: Partial<ClaimRequest> = {}) => {
    const o = await claim(req(credential, extra), w.claimDeps);
    return o.kind === "refused" ? o.reason : o.kind;
  };
  assert.equal(await refused(sub("000000000002")), "inactive");
  assert.equal(await refused(sub("000000000003")), "payment-pending");
  assert.equal(await refused(sub("0000000000ff")), "unknown-code");
  assert.equal(await refused(SUB, { claimSecret: OTHER_SECRET }), "bound-to-other-device");
  assert.equal(await refused(SUB, { claimSecret: "short" }), "bad-request");
  // 502 billing-unavailable, no host, an answer that is not the claim API's JSON.
  assert.equal(await refused(sub("000000000004")), "unavailable");
  assert.deepEqual(await claim(req(SUB), { fetch: w.fetch, baseUrl: "https://nowhere.test" }), { kind: "unavailable" });
  const html = (async () => new Response("<html>gateway</html>", { status: 200 })) as unknown as typeof fetch;
  assert.deepEqual(await claim(req(SUB), { fetch: html }), { kind: "unavailable" });
  const notJson404 = (async () => new Response("Not Found", { status: 404 })) as unknown as typeof fetch;
  assert.deepEqual(await claim(req(SUB), { fetch: notJson404 }), { kind: "unavailable" });
});

test("claim: the request is exactly the specified body, with no household ID or sync credential", async () => {
  const w = world();
  const root = generateRootSecret();
  const keys = await deriveKeys(root);
  assert.ok(keys.ok);
  await claim(req(SUB, { replace: true, current: true }), w.claimDeps);
  assert.equal(w.sent.length, 1);
  const { url, init } = w.sent[0]!;
  assert.equal(url, `${CLAIM}/v1/entitlement/claim`);
  assert.equal(init?.method, "POST");
  assert.deepEqual([...new Headers(init?.headers).keys()], ["content-type"]);
  assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
  const body = String(init?.body);
  assert.deepEqual(JSON.parse(body), { source: "polar", credential: SUB, claim_secret: SECRET, replace: true, current: true });
  assert.ok(!body.includes(keys.value.householdId));
  assert.ok(!body.includes(keys.value.authToken));
});

test("sync: create with a version 2 token; a forced write delivers the next token and moves entExp", async () => {
  const w = world();
  const root = generateRootSecret();
  const nov = await claim(req(SUB), w.claimDeps);
  assert.ok(nov.kind === "token");
  const created = await syncOnce(
    { rootSecret: root, local: household("dev-a", 1000), maxSeenRev: 0, deviceId: "dev-a", entitlement: nov.token.raw },
    w.syncDeps,
  );
  assert.equal(created.status.state, "ok");
  assert.equal(created.entExp, Date.parse("2026-12-04"));
  assert.equal(created.refusal, null);

  w.clock.t = Date.parse("2026-11-26T09:00:00Z");
  const dec = await claim(req(SUB), w.claimDeps);
  assert.ok(dec.kind === "token");
  const input = { rootSecret: root, local: created.state, maxSeenRev: created.maxSeenRev, deviceId: "dev-a", entitlement: dec.token.raw };

  // Nothing changed: no write, the end stays.
  let before = puts(w.sent);
  const plain = await syncOnce(input, w.syncDeps);
  assert.equal(puts(w.sent), before);
  assert.equal(plain.entExp, Date.parse("2026-12-04"));

  // Forced: one write of equal content, the caller's object back, E moved.
  before = puts(w.sent);
  const forced = await syncOnce({ ...input, forceWrite: true }, w.syncDeps);
  assert.equal(puts(w.sent), before + 1);
  assert.equal(forced.status.state, "ok");
  assert.equal(forced.state, input.local);
  assert.equal(forced.entExp, Date.parse("2027-01-04"));
  const sentToken = new Headers(w.sent.at(-1)!.init?.headers).get("X-Sitr-Entitlement");
  assert.equal(sentToken, dec.token.raw);
});

test("sync: a lapsed household's write is refused as lapsed, with its end", async () => {
  const w = world();
  const root = generateRootSecret();
  const nov = await claim(req(SUB), w.claimDeps);
  assert.ok(nov.kind === "token");
  const created = await syncOnce(
    { rootSecret: root, local: household("dev-a", 1000), maxSeenRev: 0, deviceId: "dev-a", entitlement: nov.token.raw },
    w.syncDeps,
  );
  w.clock.t = Date.parse("2026-12-05T00:00:00Z");
  const local = bumpRev({ ...created.state, blockDomains: ["b.example"] }, "dev-a", w.clock.t);
  const out = await syncOnce({ rootSecret: root, local, maxSeenRev: created.maxSeenRev, deviceId: "dev-a" }, w.syncDeps);
  assert.equal(out.status.state, "error");
  assert.equal(out.status.error, "server responded 402");
  assert.equal(out.refusal, "lapsed");
  assert.equal(out.entExp, Date.parse("2026-12-04"));
  assert.equal(out.state, local);
});

test("sync: a version 1 server sends no end, and its old 402 bodies are read", async () => {
  const w = world({ v2: false });
  const out = await syncOnce(
    { rootSecret: generateRootSecret(), local: household("dev-a", 1000), maxSeenRev: 0, deviceId: "dev-a", entitlement: "sitr-ent-v2.x.y" },
    w.syncDeps,
  );
  assert.equal(out.status.state, "ok");
  assert.equal(out.entExp, null);
  assert.equal(out.refusal, null);

  // The deployed server's creation refusals, as the fixture lists them.
  const fixture = JSON.parse(readFileSync(join(ROOT, "apps/shared/fixtures/claim.json"), "utf8")) as {
    syncRefusals: { name: string; status: number; body: string; refusal: string | null }[];
  };
  for (const r of fixture.syncRefusals) {
    const stub = (async (_: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "PUT"
        ? new Response(r.body, { status: r.status, headers: { "Content-Type": "text/plain; charset=utf-8" } })
        : new Response("no blob", { status: 404 })) as typeof fetch;
    const o = await syncOnce(
      { rootSecret: generateRootSecret(), local: household("dev-a", 1000), maxSeenRev: 0, deviceId: "dev-a" },
      { fetch: stub, now: () => 1000, baseUrl: SYNC },
    );
    if (r.status === 402) assert.equal(o.status.error, "server responded 402", r.name);
    assert.equal(o.refusal, r.refusal, r.name);
    assert.equal(o.entExp, null, r.name);
  }
});

test("sync: a forced write never makes a join placeholder create the household", async () => {
  const w = world();
  const placeholder = emptyHouseholdState("dev-b", 0);
  const out = await syncOnce(
    { rootSecret: generateRootSecret(), local: placeholder, maxSeenRev: 0, deviceId: "dev-b", entitlement: "x", forceWrite: true },
    w.syncDeps,
  );
  assert.equal(out.status.state, "not-found");
  assert.equal(out.state, placeholder);
  assert.equal(puts(w.sent), 0);
});

test("no request goes to any host but the two in-process handlers", async (ctx) => {
  const real = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("global fetch used");
  }) as typeof fetch;
  ctx.after(() => {
    globalThis.fetch = real;
  });
  const w = world();
  const root = generateRootSecret();
  const nov = await claim(req(SUB), w.claimDeps);
  assert.ok(nov.kind === "token");
  const created = await syncOnce(
    { rootSecret: root, local: household("dev-a", 1000), maxSeenRev: 0, deviceId: "dev-a", entitlement: nov.token.raw },
    w.syncDeps,
  );
  await syncOnce(
    { rootSecret: root, local: created.state, maxSeenRev: created.maxSeenRev, deviceId: "dev-a", entitlement: nov.token.raw, forceWrite: true },
    w.syncDeps,
  );
  assert.ok(w.sent.length >= 5);
  for (const s of w.sent) assert.ok([CLAIM, SYNC].includes(new URL(s.url).origin), s.url);
  assert.deepEqual(
    [...new Set(w.sent.map((s) => new URL(s.url).pathname.split("/").slice(0, 3).join("/")))].sort(),
    ["/v1/blob", "/v1/entitlement"],
  );
});
