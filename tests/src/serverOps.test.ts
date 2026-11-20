// Operational behaviour of the two server processes: start-up checks,
// the mint CLI, the shared node:http listener, and the store's request path.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { X509Certificate, createPrivateKey, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { DatabaseSync, StatementSync } from "node:sqlite";
import type { AddressInfo } from "node:net";

import { checkClaimConfig, configFromEnv } from "../../server/sync/dist/config.js";
import { SyncHandler, guarded, syncListener, type SyncRequest } from "../../server/sync/dist/http.js";
import { SyncStore } from "../../server/sync/dist/store.js";
import { keygen, mintTokenV2, privateKeyFromB64 } from "../../server/sync/dist/mint.js";
import { ClaimHandler } from "../../server/sync/dist/claim.js";
import { ClaimStore } from "../../server/sync/dist/claim-store.js";

const DAY = 86_400_000;
const dist = (f: string) => fileURLToPath(new URL(`../../server/sync/dist/${f}`, import.meta.url));
const kp = keygen();
const CLAIM_KEY = Buffer.alloc(32, 3).toString("base64");

/* ------------------------------ configuration ---------------------------- */

test("a set but unusable variable throws, naming the variable and never its value", () => {
  const cases: [Record<string, string>, RegExp, string][] = [
    [{ SITR_SYNC_PORT: "80a" }, /SITR_SYNC_PORT must be a positive integer/, "80a"],
    [{ SITR_SYNC_CREATES_PER_IP_HOUR: "0" }, /SITR_SYNC_CREATES_PER_IP_HOUR/, "xx-never"],
    [{ SITR_CLAIM_PER_IP_HOUR: "lots" }, /SITR_CLAIM_PER_IP_HOUR/, "lots"],
    [{ SITR_ENTITLEMENT_DAYS: "-1" }, /SITR_ENTITLEMENT_DAYS/, "-1"],
    [{ SITR_TRUSTED_PROXY: "yes" }, /SITR_TRUSTED_PROXY must be 1 or 0/, "yes"],
    [{ SITR_APPLE_SANDBOX: "on" }, /SITR_APPLE_SANDBOX/, "on"],
    [{ SITR_POLAR_API: "api.polar.sh" }, /SITR_POLAR_API/, "api.polar.sh"],
    [{ SITR_CLAIM_ORIGIN: "https://sitrshield.com/welcome" }, /SITR_CLAIM_ORIGIN must be an origin/, "welcome"],
    [{ SITR_CLAIM_KEY: "c2hvcnQ=" }, /SITR_CLAIM_KEY/, "c2hvcnQ="],
    [{ SITR_V1_CUTOVER: "soon" }, /SITR_V1_CUTOVER/, "soon"],
  ];
  for (const [env, re, value] of cases) {
    assert.throws(() => configFromEnv(env), (e: Error) => re.test(e.message) && !e.message.includes(value), JSON.stringify(env));
  }
  assert.equal(configFromEnv({ SITR_TRUSTED_PROXY: "true" }).trustedProxy, true);
  assert.equal(configFromEnv({ SITR_TRUSTED_PROXY: "0" }).trustedProxy, false);
});

test("a blank variable counts as unset only where that is harmless; blank keys, token, cut-over and database paths are refused", () => {
  const names = [
    "SITR_SYNC_PORT", "SITR_SYNC_DB", "SITR_ENTITLEMENT_PUBKEY", "SITR_V1_CUTOVER", "SITR_SYNC_CREATES_PER_IP_HOUR",
    "SITR_SYNC_REQS_PER_ID_MIN", "SITR_TRUSTED_PROXY", "SITR_CLAIM_PORT", "SITR_ENTITLEMENT_PRIVKEY", "SITR_CLAIM_KEY",
    "SITR_CLAIM_DB", "SITR_POLAR_TOKEN", "SITR_POLAR_API", "SITR_POLAR_PRODUCTS", "SITR_APPLE_BUNDLE_ID",
    "SITR_APPLE_PRODUCTS", "SITR_APPLE_SANDBOX", "SITR_REPLACEMENT_DAYS", "SITR_CLAIM_PER_IP_HOUR",
    "SITR_ENTITLEMENT_DAYS", "SITR_CLAIM_ORIGIN",
  ];
  const unset = JSON.stringify(configFromEnv({}), (_k, v) => (v instanceof Map ? [...v] : v));
  for (const name of names) {
    for (const blank of ["", " \t "]) {
      if (["SITR_SYNC_DB", "SITR_CLAIM_DB", "SITR_ENTITLEMENT_PUBKEY", "SITR_ENTITLEMENT_PRIVKEY", "SITR_CLAIM_KEY", "SITR_POLAR_TOKEN", "SITR_V1_CUTOVER"].includes(name)) {
        assert.throws(() => configFromEnv({ [name]: blank }), new RegExp(`^Error: ${name} is set but empty$`), name);
      } else {
        const c = JSON.stringify(configFromEnv({ [name]: blank }), (_k, v) => (v instanceof Map ? [...v] : v));
        assert.equal(c, unset, name);
      }
    }
  }
  // A blank optional setting does not hide a broken combination.
  assert.throws(() => checkClaimConfig(configFromEnv({ SITR_POLAR_TOKEN: "t", SITR_POLAR_PRODUCTS: " " })), /SITR_POLAR_TOKEN and SITR_POLAR_PRODUCTS/);
  assert.throws(() => configFromEnv({ SITR_POLAR_PRODUCTS: " , " }), /SITR_POLAR_PRODUCTS is set but lists no product/);
  assert.throws(() => configFromEnv({ SITR_SYNC_DB: ":memory:" }), /SITR_SYNC_DB must be a file path/);
  assert.throws(() => configFromEnv({ SITR_CLAIM_DB: ":memory:" }), /SITR_CLAIM_DB must be a file path/);
  // Tests pass ":memory:" to the stores' constructors instead.
  assert.ok(new SyncStore(":memory:") && new ClaimStore(":memory:"));
  // A malformed product entry is refused without echoing the entry.
  assert.throws(() => configFromEnv({ SITR_APPLE_PRODUCTS: "secret-product-id" }), (e: Error) => !e.message.includes("secret-product-id"));
});

test("SITR_POLAR_API must be an origin: a trailing slash or a path is refused", () => {
  for (const v of ["https://api.polar.sh/", "https://api.polar.sh/v1", "https://api.polar.sh/?x=1"]) {
    assert.throws(() => configFromEnv({ SITR_POLAR_API: v }), /SITR_POLAR_API must be an origin/, v);
  }
  assert.equal(configFromEnv({ SITR_POLAR_API: "https://sandbox-api.polar.sh" }).polarApiBase, "https://sandbox-api.polar.sh");
});

test("checkClaimConfig refuses combinations that cannot work", () => {
  const full = {
    SITR_ENTITLEMENT_PRIVKEY: kp.privateB64,
    SITR_CLAIM_KEY: CLAIM_KEY,
    SITR_POLAR_TOKEN: "t",
    SITR_POLAR_PRODUCTS: "p=family:year",
    SITR_APPLE_BUNDLE_ID: "com.example.sitr",
    SITR_APPLE_PRODUCTS: "a=family:month",
    SITR_APPLE_SANDBOX: "1",
  };
  checkClaimConfig(configFromEnv(full));
  checkClaimConfig(configFromEnv({})); // nothing configured: every route answers 503
  const without = (k: keyof typeof full) => Object.fromEntries(Object.entries(full).filter(([n]) => n !== k));
  const cases: [Record<string, string>, RegExp][] = [
    [{ ...full, SITR_ENTITLEMENT_DAYS: "8" }, /SITR_ENTITLEMENT_DAYS must be at most 7/],
    [without("SITR_CLAIM_KEY"), /SITR_ENTITLEMENT_PRIVKEY and SITR_CLAIM_KEY must be set together/],
    [{ SITR_POLAR_TOKEN: "t", SITR_POLAR_PRODUCTS: "p=family:year" }, /billing source is configured but SITR_ENTITLEMENT_PRIVKEY/],
    [without("SITR_POLAR_PRODUCTS"), /SITR_POLAR_TOKEN and SITR_POLAR_PRODUCTS/],
    [without("SITR_POLAR_TOKEN"), /SITR_POLAR_TOKEN and SITR_POLAR_PRODUCTS/],
    [without("SITR_APPLE_BUNDLE_ID"), /SITR_APPLE_BUNDLE_ID and SITR_APPLE_PRODUCTS/],
    [without("SITR_APPLE_PRODUCTS"), /SITR_APPLE_BUNDLE_ID and SITR_APPLE_PRODUCTS/],
    [{ SITR_ENTITLEMENT_PRIVKEY: kp.privateB64, SITR_CLAIM_KEY: CLAIM_KEY, SITR_APPLE_SANDBOX: "1" }, /SITR_APPLE_SANDBOX needs/],
  ];
  for (const [env, re] of cases) assert.throws(() => checkClaimConfig(configFromEnv(env)), re, JSON.stringify(Object.keys(env)));
});

function start(entry: string, env: Record<string, string>) {
  return spawnSync(process.execPath, ["--experimental-sqlite", "--no-warnings=ExperimentalWarning", dist(entry)], {
    env: { PATH: process.env["PATH"] ?? "", SITR_SYNC_PORT: "18901", SITR_CLAIM_PORT: "18902", ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
}

test("both processes fail fast at start-up with a message naming the variable, never its value", (ctx) => {
  const secret = "NOT-A-REAL-DIR-4f3a";
  const dir = mkdtempSync(join(tmpdir(), "sitr-startup-"));
  ctx.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "db.sqlite");
  const cases: [string, Record<string, string>, RegExp, string][] = [
    ["claim-server.js", { SITR_ENTITLEMENT_PRIVKEY: kp.privateB64, SITR_CLAIM_KEY: CLAIM_KEY, SITR_CLAIM_DB: `/${secret}/claims.sqlite` }, /^sitr-claim: SITR_CLAIM_DB: cannot open/, secret],
    ["claim-server.js", { SITR_APPLE_PRODUCTS: "a=family:month" }, /SITR_APPLE_BUNDLE_ID and SITR_APPLE_PRODUCTS/, "a=family"],
    ["claim-server.js", { SITR_ENTITLEMENT_DAYS: "366" }, /SITR_ENTITLEMENT_DAYS must be at most 7/, "366"],
    ["claim-server.js", { SITR_ENTITLEMENT_PRIVKEY: "c2hvcnQ=", SITR_CLAIM_KEY: CLAIM_KEY, SITR_CLAIM_DB: db }, /SITR_ENTITLEMENT_PRIVKEY must be 32 bytes/, "c2hvcnQ="],
    ["claim-server.js", { SITR_ENTITLEMENT_PRIVKEY: kp.privateB64, SITR_CLAIM_KEY: CLAIM_KEY, SITR_CLAIM_DB: "" }, /SITR_CLAIM_DB is set but empty/, "xx-never"],
    ["claim-server.js", { SITR_ENTITLEMENT_PRIVKEY: kp.privateB64, SITR_CLAIM_KEY: CLAIM_KEY, SITR_CLAIM_DB: ":memory:" }, /SITR_CLAIM_DB must be a file path/, ":memory:"],
    ["server.js", { SITR_SYNC_DB: `/${secret}/blobs.sqlite` }, /^sitr-sync: SITR_SYNC_DB: cannot open/, secret],
    ["server.js", { SITR_ENTITLEMENT_PUBKEY: "c2hvcnQ=", SITR_SYNC_DB: db }, /SITR_ENTITLEMENT_PUBKEY must be 32 bytes/, "c2hvcnQ="],
    ["server.js", { SITR_TRUSTED_PROXY: "yes", SITR_SYNC_DB: db }, /SITR_TRUSTED_PROXY must be 1 or 0/, "yes"],
    ["server.js", { SITR_SYNC_DB: "  " }, /SITR_SYNC_DB is set but empty/, "xx-never"],
    ["server.js", { SITR_ENTITLEMENT_PUBKEY: " ", SITR_SYNC_DB: db }, /^sitr-sync: SITR_ENTITLEMENT_PUBKEY is set but empty/, "xx-never"],
    ["server.js", { SITR_SYNC_DB: ":memory:" }, /SITR_SYNC_DB must be a file path/, ":memory:"],
  ];
  for (const [entry, env, re, value] of cases) {
    const r = start(entry, env);
    assert.equal(r.status, 1, `${entry} ${Object.keys(env).join(",")}: ${r.stderr}`);
    assert.match(r.stderr, re);
    assert.ok(!r.stderr.includes(value), r.stderr);
  }
});

/* -------------------------------- mint CLI ------------------------------- */

function mint(args: string[], env: Record<string, string> = { SITR_ENTITLEMENT_PRIVKEY: kp.privateB64 }) {
  return spawnSync(process.execPath, [dist("mint.js"), ...args], {
    env: { PATH: process.env["PATH"] ?? "", ...env },
    encoding: "utf8",
  });
}
const expOf = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.trim().split(".")[1]!, "base64url").toString());

test("mint.js: parsed flags, default 7 days, more than 7 only with --old-style-token", () => {
  const before = Date.now();
  const plain = mint(["--plan", "family"]);
  assert.equal(plain.status, 0, plain.stderr);
  const p = expOf(plain.stdout);
  assert.equal(p["plan"], "family");
  assert.ok(Number(p["exp"]) >= before + 7 * DAY && Number(p["exp"]) <= Date.now() + 7 * DAY);
  const daysOnly = mint(["--days", "3"]);
  assert.equal(daysOnly.status, 0, daysOnly.stderr);
  assert.equal(expOf(daysOnly.stdout)["plan"], "family"); // not "--days"
  const long = mint(["--days", "30"]);
  assert.equal(long.status, 2);
  assert.match(long.stderr, /old-style token.*\n.*--old-style-token/);
  const deliberate = mint(["--days", "30", "--old-style-token"]);
  assert.equal(deliberate.status, 0, deliberate.stderr);
  assert.ok(Number(expOf(deliberate.stdout)["exp"]) >= before + 30 * DAY);
  for (const bad of [["--days", "abc"], ["--days", "0"], ["--bogus"], ["--verify"]]) {
    const r = mint(bad);
    assert.equal(r.status, 2, `${bad.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, "");
  }
  const noKey = mint(["--days", "7"], {});
  assert.equal(noKey.status, 1);
  assert.match(noKey.stderr, /set SITR_ENTITLEMENT_PRIVKEY/);
  const badKey = mint(["--days", "7"], { SITR_ENTITLEMENT_PRIVKEY: "c2hvcnQ=" });
  assert.equal(badKey.status, 1);
  assert.match(badKey.stderr, /^set SITR_ENTITLEMENT_PRIVKEY/);
  assert.doesNotMatch(badKey.stderr, /at |Error/); // no stack trace
  assert.match(mint(["--keygen"], {}).stdout, /^SITR_ENTITLEMENT_PRIVKEY=.*\nSITR_ENTITLEMENT_PUBKEY=/);
});

test("mint.js --verify without a usable public key says so with its own exit code", () => {
  const token = mintTokenV2(privateKeyFromB64(kp.privateB64), {
    v: 2, plan: "family", term: "year", per: Date.UTC(2998, 11, 1), exp: Date.UTC(2999, 0, 4), jti: "AAAAAAAAAAAAAAAAAAAAAA",
  });
  for (const env of [{}, { SITR_ENTITLEMENT_PUBKEY: "" }, { SITR_ENTITLEMENT_PUBKEY: "c2hvcnQ=" }] as Record<string, string>[]) {
    const r = mint(["--verify", token], env);
    assert.equal(r.status, 3, JSON.stringify(env));
    assert.equal(r.stderr, "set SITR_ENTITLEMENT_PUBKEY to the 32-byte base64 public key to verify a token\n");
    assert.equal(r.stdout, "");
  }
  const ok = mint(["--verify", token], { SITR_ENTITLEMENT_PUBKEY: kp.publicB64 });
  assert.equal(ok.status, 0);
  const forged = mint(["--verify", token.slice(0, -4) + "AAAA"], { SITR_ENTITLEMENT_PUBKEY: kp.publicB64 });
  assert.deepEqual([forged.status, forged.stdout], [1, "invalid (token-invalid)\n"]);
});

/* --------------------------- listener and store ------------------------- */

/** Records BEGIN/COMMIT/ROLLBACK and every statement run while `fn` runs. */
function trace(fn: () => void): string[] {
  const log: string[] = [];
  const exec = DatabaseSync.prototype.exec;
  const get = StatementSync.prototype.get;
  const run = StatementSync.prototype.run;
  const all = StatementSync.prototype.all;
  const prepare = DatabaseSync.prototype.prepare;
  const sql = (st: StatementSync) => (st as unknown as { sourceSQL: string }).sourceSQL.replace(/\s+/g, " ").trim();
  DatabaseSync.prototype.exec = function (this: DatabaseSync, q: string) {
    log.push(q.trim());
    return exec.call(this, q);
  };
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, q: string) {
    log.push(`PREPARE ${q.replace(/\s+/g, " ").trim()}`);
    return prepare.call(this, q);
  } as typeof prepare;
  for (const [name, orig] of [["get", get], ["run", run], ["all", all]] as const) {
    (StatementSync.prototype as unknown as Record<string, unknown>)[name] = function (this: StatementSync, ...a: unknown[]) {
      log.push(sql(this));
      return (orig as (...x: unknown[]) => unknown).apply(this, a);
    };
  }
  try {
    fn();
  } finally {
    Object.assign(DatabaseSync.prototype, { exec, prepare });
    Object.assign(StatementSync.prototype, { get, run, all });
  }
  return log;
}

test("PUT: the row is read and authorised once, inside the same transaction as the write", () => {
  const store = new SyncStore(":memory:");
  const h = new SyncHandler(store, configFromEnv({}), () => 1_000_000);
  const put = (headers: Record<string, string>) =>
    h.handle({
      method: "PUT",
      path: `/v1/blob/${"d".repeat(32)}`,
      ip: "203.0.113.1",
      headers: { authorization: `Bearer ${"a".repeat(64)}`, ...headers },
      body: new Uint8Array([1]),
    });
  assert.equal(put({ "if-none-match": "*" }).status, 201);
  const log = trace(() => assert.equal(put({ "if-match": '"1"' }).status, 200));
  assert.equal(log.length, 4, log.join("\n"));
  assert.equal(log[0], "BEGIN IMMEDIATE");
  assert.match(log[1]!, /^SELECT auth_hash, write_counter/);
  assert.match(log[2]!, /^UPDATE blobs SET blob/);
  assert.equal(log[3], "COMMIT");
});

test("ClaimStore: a claim, a notification and a v1 claim prepare no statement", async () => {
  const store = new ClaimStore(":memory:");
  const config = {
    ...configFromEnv({ SITR_POLAR_PRODUCTS: "prod_y=family:year" }),
    entitlementPrivKeyB64: kp.privateB64,
    polarAccessToken: "t",
    claimKey: Buffer.alloc(32, 9),
  };
  const sub = { status: "active", product_id: "prod_y", recurring_interval: "year", current_period_end: "2027-06-01T00:00:00Z" };
  const polar = (async (u: RequestInfo | URL) =>
    new Response(JSON.stringify(String(u).includes("/checkouts/") ? { status: "succeeded", subscription_id: "6f1c2a3b-1d2e-4f50-8a9b-0c1d2e3f4a5c" } : sub))) as typeof fetch;
  const h = new ClaimHandler(config, () => Date.parse("2026-11-20T12:00:00Z"), polar, { store });
  const req = (method: string, path: string, body = "") =>
    h.handle({ method, path, ip: "203.0.113.2", headers: {}, body: new TextEncoder().encode(body) });
  const claim = JSON.stringify({ source: "polar", credential: "6f1c2a3b-1d2e-4f50-8a9b-0c1d2e3f4a5b", claim_secret: Buffer.alloc(32, 1).toString("base64url") });
  assert.equal((await req("POST", "/v1/entitlement/claim", claim)).status, 200); // warm-up: none prepared lazily either
  const prepared: string[] = [];
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, q: string) {
    prepared.push(q);
    return prepare.call(this, q);
  } as typeof prepare;
  try {
    assert.equal((await req("POST", "/v1/entitlement/claim", claim)).status, 200);
    assert.equal((await req("GET", "/v1/entitlement/claim/chk_1")).status, 200);
    store.notice(new Uint8Array(32), 1, 1, true);
    store.notice(new Uint8Array(32), 1, 2, false);
    store.isRevoked(new Uint8Array(32));
    store.prune(Date.now(), 180, 0);
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
  assert.deepEqual(prepared, []);
});


test("sync listener: a handler fault answers 500 with one log line holding no request data", async (ctx) => {
  const throwing = { handle: (_r: SyncRequest) => { throw new Error("blob-bytes-and-secrets"); } } as unknown as SyncHandler;
  const server = createServer(syncListener(throwing, configFromEnv({})));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  ctx.after(() => server.close());
  const logged: unknown[][] = [];
  const saved = console.error;
  console.error = (...a: unknown[]) => void logged.push(a);
  let status: number;
  try {
    status = (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/blob/${"a".repeat(32)}`)).status;
  } finally {
    console.error = saved;
  }
  assert.equal(status, 500);
  assert.deepEqual(logged, [["sitr-sync: internal error (Error)"]]);
});

test("store: a PUT prepares no statement and never reads the blob it replaces", () => {
  const store = new SyncStore(":memory:");
  const h = new SyncHandler(store, configFromEnv({}), () => 1_000_000);
  const put = (headers: Record<string, string>) =>
    h.handle({
      method: "PUT",
      path: `/v1/blob/${"c".repeat(32)}`,
      ip: "203.0.113.1",
      headers: { authorization: `Bearer ${"a".repeat(64)}`, ...headers },
      body: new Uint8Array([1, 2, 3]),
    });
  assert.equal(put({ "if-none-match": "*" }).status, 201);
  const prepared: string[] = [];
  const read: string[] = [];
  const prepare = DatabaseSync.prototype.prepare;
  const get = StatementSync.prototype.get;
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    prepared.push(sql);
    return prepare.call(this, sql);
  } as typeof prepare;
  StatementSync.prototype.get = function (this: StatementSync, ...a: unknown[]) {
    read.push((this as unknown as { sourceSQL: string }).sourceSQL); // a string at run time
    return (get as (...x: unknown[]) => unknown).apply(this, a);
  } as typeof get;
  try {
    assert.equal(put({ "if-match": '"1"' }).status, 200);
    assert.equal(store.isUsed(new Uint8Array(32)), false); // the token check of an enforcing PUT
  } finally {
    DatabaseSync.prototype.prepare = prepare;
    StatementSync.prototype.get = get;
  }
  assert.deepEqual(prepared, []);
  assert.ok(read.length > 0);
  for (const sql of read) assert.doesNotMatch(sql, /SELECT\s+blob\b/);
});

test("the hourly clean-up guard logs only the kind of error and never throws", () => {
  const logged: unknown[][] = [];
  const saved = console.error;
  console.error = (...a: unknown[]) => void logged.push(a);
  try {
    guarded("sitr-claim", "hourly clean-up", () => {
      throw new RangeError("row-data-and-secrets");
    });
  } finally {
    console.error = saved;
  }
  assert.deepEqual(logged, [["sitr-claim: hourly clean-up failed (RangeError)"]]);
  for (const f of ["server.ts", "claim-server.ts"]) {
    const src = readFileSync(new URL(`../../server/sync/src/${f}`, import.meta.url), "utf8");
    assert.match(src, /setInterval\(\s*(\(\) => guarded\(|prune,)/, f);
  }
});

test("listener: a response that cannot be written is logged by kind and the process keeps serving", async (ctx) => {
  let bad = true;
  const h = { handle: () => ({ status: 200, headers: bad ? { "X-Bad": "a\nb" } : {}, body: new Uint8Array([1]) }) } as unknown as SyncHandler;
  const server = createServer(syncListener(h, configFromEnv({})));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  ctx.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const logged: unknown[][] = [];
  const saved = console.error;
  console.error = (...a: unknown[]) => void logged.push(a);
  try {
    await fetch(url).then(() => assert.fail("expected the connection to drop"), () => {});
  } finally {
    console.error = saved;
  }
  assert.deepEqual(logged, [["sitr-sync: response write failed (TypeError)"]]);
  bad = false;
  assert.equal((await fetch(url)).status, 200);
});

test("the deployed claim service ignores the dev server's StoreKit certificate setting", async (ctx) => {
  for (const f of ["server.ts", "claim-server.ts", "config.ts", "apple.ts", "claim.ts"]) {
    const src = readFileSync(new URL(`../../server/sync/src/${f}`, import.meta.url), "utf8");
    assert.ok(!/SITR_DEV_|process\.argv/.test(src), f);
  }
  const dir = mkdtempSync(join(tmpdir(), "sitr-devcert-"));
  const leaf = fileURLToPath(new URL("../fixtures/apple/leaf.pem", import.meta.url));
  const child = spawn(process.execPath, ["--experimental-sqlite", "--no-warnings=ExperimentalWarning", dist("claim-server.js"), leaf], {
    env: {
      PATH: process.env["PATH"] ?? "",
      SITR_CLAIM_PORT: "18903",
      SITR_DEV_STOREKIT_CERT: leaf,
      SITR_ENTITLEMENT_PRIVKEY: kp.privateB64,
      SITR_CLAIM_KEY: CLAIM_KEY,
      SITR_CLAIM_DB: join(dir, "c.sqlite"),
      SITR_APPLE_BUNDLE_ID: "com.example.sitr",
      SITR_APPLE_PRODUCTS: "com.example.family.month=family:month",
      SITR_APPLE_SANDBOX: "1",
    },
  });
  ctx.after(() => {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>((ok, no) => {
    child.stdout.on("data", (d: Buffer) => d.toString().includes("listening") && ok());
    child.on("exit", () => no(new Error("claim-server exited")));
  });
  const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const pem = (n: string) => readFileSync(new URL(`../fixtures/apple/${n}.pem`, import.meta.url));
  for (const environment of ["Xcode", "Sandbox"]) {
    const h = b64u({ alg: "ES256", x5c: [new X509Certificate(pem("leaf")).raw.toString("base64")] });
    const p = b64u({
      bundleId: "com.example.sitr", environment, productId: "com.example.family.month", originalTransactionId: "1",
      transactionId: "2", expiresDate: Date.now() + DAY, inAppOwnershipType: "PURCHASED", signedDate: Date.now(),
    });
    const sig = sign("sha256", Buffer.from(`${h}.${p}`), { key: createPrivateKey(pem("leaf-key")), dsaEncoding: "ieee-p1363" });
    const r = await fetch("http://127.0.0.1:18903/v1/entitlement/claim", {
      method: "POST",
      body: JSON.stringify({ source: "apple", credential: `${h}.${p}.${sig.toString("base64url")}`, claim_secret: Buffer.alloc(32, 1).toString("base64url") }),
    });
    assert.deepEqual([r.status, await r.json()], [422, { error: "invalid-receipt" }], environment);
  }
});

test("the dev claim server stops with the owner steps when the StoreKit certificate is missing", () => {
  const r = spawnSync(process.execPath, ["--experimental-sqlite", "--no-warnings=ExperimentalWarning",
    fileURLToPath(new URL("./devClaimServer.js", import.meta.url)), "/nonexistent/StoreKitTestCertificate.cer"], {
    env: { PATH: process.env["PATH"] ?? "" }, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Editor > Save Public Certificate/);
});
