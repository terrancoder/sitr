// The development server (tests/src/devClaimServer.ts): its Polar stub
// produces every Polar claim outcome without an outbound request, and the
// started process walks a household through renewal, lapse and reopening
// with SITR_DEV_CLOCK_OFFSET_MS, over real local sockets.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { POLAR_STUB_BASE, STUB_PRODUCTS, parsePolarSubs, polarStubFetch } from "./devClaimServer.js";
import { ClaimHandler } from "../../server/sync/dist/claim.js";
import { ClaimStore } from "../../server/sync/dist/claim-store.js";
import { configFromEnv } from "../../server/sync/dist/config.js";
import { keygen } from "../../server/sync/dist/mint.js";

const T = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SECRET = Buffer.alloc(32, 7).toString("base64url");
const payload = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;

test("dev Polar stub: refuses every URL outside the stub, and any request to a real host", async () => {
  const f = polarStubFetch(parsePolarSubs(`${u(1)}=active:month:2030-01-01`));
  for (const url of ["https://api.polar.sh/v1/subscriptions/" + u(1), "https://claim.sitrshield.com/", "http://127.0.0.1:1/", `${POLAR_STUB_BASE}.evil.example/v1/subscriptions/${u(1)}`]) {
    await assert.rejects(f(url), /outbound request refused/, url);
  }
  assert.equal((await f(`${POLAR_STUB_BASE}/v1/subscriptions/${u(1)}`)).status, 200);
  assert.equal((await f(`${POLAR_STUB_BASE}/v1/checkouts/x`)).status, 404);
  assert.throws(() => parsePolarSubs(`${u(1)}=active:week:2030-01-01`), /SITR_DEV_POLAR_SUBS/);
  assert.throws(() => parsePolarSubs("nope=active:month:2030-01-01"), /SITR_DEV_POLAR_SUBS/);
});

test("dev Polar stub: every Polar claim outcome of the specification can be produced", async () => {
  const subs = parsePolarSubs(
    [
      `${u(1)}=active:month:2030-02-15`,
      `${u(2)}=active:year:2030-12-01`,
      `${u(3)}=past_due:month:2030-02-15`,
      `${u(4)}=canceled:month:2030-02-15`,
      `${u(5)}=active:month:2030-01-05`,
      `${u(6)}=active:month:2030-02-15:inst-starter`,
      `${u(7)}=active:year:2030-12-01:inst-standard`,
      `${u(8)}=active:month:2030-02-15:other`,
      `${u(9)}=down:month:2030-02-15`,
    ].join(","),
  );
  const config = {
    ...configFromEnv({}),
    entitlementPrivKeyB64: keygen().privateB64,
    claimKey: Buffer.alloc(32, 1),
    polarAccessToken: "dev-stub",
    polarApiBase: POLAR_STUB_BASE,
    polarProducts: STUB_PRODUCTS,
  };
  const h = new ClaimHandler(config, () => T("2030-01-10"), polarStubFetch(subs), { store: new ClaimStore(":memory:") });
  const claim = async (code: string) => {
    const r = await h.handle({
      method: "POST", path: "/v1/entitlement/claim", ip: "127.0.0.1", headers: {},
      body: new TextEncoder().encode(JSON.stringify({ source: "polar", credential: code, claim_secret: SECRET })),
    });
    const j = JSON.parse(new TextDecoder().decode(r.body)) as Record<string, string>;
    return j["token"] !== undefined ? { status: r.status, plan: payload(j["token"])["plan"], term: payload(j["token"])["term"] } : { status: r.status, error: j["error"] };
  };
  assert.deepEqual(await claim(u(1)), { status: 200, plan: "family", term: "month" });
  assert.deepEqual(await claim(u(2)), { status: 200, plan: "family", term: "year" });
  assert.deepEqual(await claim(u(3)), { status: 402, error: "payment-pending" });
  assert.deepEqual(await claim(u(4)), { status: 402, error: "inactive" });
  assert.deepEqual(await claim(u(5)), { status: 402, error: "inactive" }); // current_period_end has passed
  assert.deepEqual(await claim(u(6)), { status: 200, plan: "inst-starter", term: "month" });
  assert.deepEqual(await claim(u(7)), { status: 200, plan: "inst-standard", term: "year" });
  assert.deepEqual(await claim(u(8)), { status: 422, error: "wrong-product" });
  assert.deepEqual(await claim(u(9)), { status: 502, error: "billing-unavailable" });
  assert.deepEqual(await claim(u(10)), { status: 404, error: "unknown-code" });
});

/** Starts the dev server on free ports; resolves once it has printed its URLs. */
function startDev(env: Record<string, string>): Promise<{ sync: string; claim: string; out: string; stop: () => Promise<void> }> {
  const child = spawn(
    process.execPath,
    ["--experimental-sqlite", "--no-warnings=ExperimentalWarning", fileURLToPath(new URL("./devClaimServer.js", import.meta.url))],
    { env: { PATH: process.env["PATH"] ?? "", SITR_DEV_SYNC_PORT: "0", SITR_DEV_CLAIM_PORT: "0", ...env } },
  );
  const stop = () => new Promise<void>((ok) => (child.exitCode !== null ? ok() : (child.once("exit", () => ok()), child.kill())));
  return new Promise((ok, no) => {
    let out = "";
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      const sync = /dev sync server  (http:\/\/127\.0\.0\.1:\d+)/.exec(out)?.[1];
      const claim = /dev claim server (http:\/\/127\.0\.0\.1:\d+)/.exec(out)?.[1];
      if (sync && claim && out.includes("data folder")) ok({ sync, claim, out, stop });
    });
    child.on("exit", () => no(new Error(`dev server exited: ${out}`)));
  });
}

test("dev server: claim → create → next month's extension → lapse → current: true reopens, with the clock offset", async (ctx) => {
  const dir = mkdtempSync(join(tmpdir(), "sitr-devserver-"));
  ctx.after(() => rmSync(dir, { recursive: true, force: true }));
  const code = u(42);
  const id = "a".repeat(32);
  const auth = { Authorization: `Bearer ${"b".repeat(64)}` };
  const at = async (iso: string) => {
    const s = await startDev({
      SITR_DEV_DIR: dir,
      SITR_DEV_POLAR_SUBS: `${code}=active:month:2030-06-15`,
      SITR_DEV_CLOCK_OFFSET_MS: String(Date.parse(iso) - Date.now()),
    });
    assert.doesNotMatch(s.out, /PRIVKEY|privateB64|claimKey|BEGIN/);
    const claim = async (current = false) => {
      const r = await fetch(`${s.claim}/v1/entitlement/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "polar", credential: code, claim_secret: SECRET, current }),
      });
      const j = (await r.json()) as { token: string };
      assert.equal(r.status, 200);
      return j.token;
    };
    const put = async (headers: Record<string, string>) => {
      const r = await fetch(`${s.sync}/v1/blob/${id}`, { method: "PUT", headers: { ...auth, ...headers }, body: new Uint8Array([1, 2, 3]) });
      return { status: r.status, etag: r.headers.get("ETag"), expires: Number(r.headers.get("X-Sitr-Entitlement-Expires")) };
    };
    return { ...s, claim, put };
  };

  // Mid-month: this month's token creates the household.
  let s = await at("2030-03-10T12:00:00Z");
  let token = await s.claim();
  assert.deepEqual([payload(token)["per"], payload(token)["exp"]], [T("2030-03-01"), T("2030-04-04")]);
  let r = await s.put({ "If-None-Match": "*", "X-Sitr-Entitlement": token });
  assert.deepEqual([r.status, r.expires], [201, T("2030-04-04")]);
  let etag = r.etag!;
  await s.stop();

  // Last week of the month: the claim gives next month, which extends it.
  s = await at("2030-03-27T12:00:00Z");
  token = await s.claim();
  assert.equal(payload(token)["per"], T("2030-04-01"));
  r = await s.put({ "If-Match": etag, "X-Sitr-Entitlement": token });
  assert.deepEqual([r.status, r.expires], [200, T("2030-05-04")]);
  etag = r.etag!;
  await s.stop();

  // Lapsed: read-only; next month's early token cannot reopen it; current: true does.
  s = await at("2030-05-28T12:00:00Z");
  r = await s.put({ "If-Match": etag });
  assert.deepEqual([r.status, r.expires], [402, T("2030-05-04")]);
  const early = await s.claim();
  assert.equal(payload(early)["per"], T("2030-06-01"));
  assert.equal((await s.put({ "If-Match": etag, "X-Sitr-Entitlement": early })).status, 402);
  token = await s.claim(true);
  assert.equal(payload(token)["per"], T("2030-05-01"));
  r = await s.put({ "If-Match": etag, "X-Sitr-Entitlement": token });
  assert.deepEqual([r.status, r.expires], [200, T("2030-06-04")]);
  await s.stop();
});

test("dev server: the Polar stub needs no StoreKit certificate, and a bad entry stops it", async (ctx) => {
  const s = await startDev({ SITR_DEV_POLAR_SUBS: `${u(1)}=active:year:2099-01-01` });
  ctx.after(() => s.stop());
  assert.match(s.out, /Polar stub \(1 codes\)/);
  const r = await fetch(`${s.claim}/v1/entitlement/claim`, {
    method: "POST",
    body: JSON.stringify({ source: "polar", credential: u(2), claim_secret: SECRET }),
  });
  assert.deepEqual([r.status, await r.json()], [404, { error: "unknown-code" }]);
  await assert.rejects(startDev({ SITR_DEV_POLAR_SUBS: "x=active" }), /SITR_DEV_POLAR_SUBS/);
});
