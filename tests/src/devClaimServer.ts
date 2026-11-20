/**
 * DEVELOPMENT ONLY — a local claim server and sync server for clients under
 * development (iOS Debug builds, the extension, Android). Lives under
 * tests/, so it is never part of the server build or its Docker image, and
 * the deployed entry points never read its settings.
 *
 * It never reaches a real host: the claim handler's only outbound path
 * (Polar) gets a fetch that answers from SITR_DEV_POLAR_SUBS and throws for
 * any other URL, in every mode. Both services listen on 127.0.0.1 only,
 * sign with a throwaway key pair and keep their databases in a temp folder.
 *
 *   npm run build:server && npx tsc -p tests/tsconfig.json
 *   SITR_DEV_POLAR_SUBS=6f1c2a3b-1d2e-4f50-8a9b-0c1d2e3f4a5b=active:month:2026-12-15 \
 *   node --experimental-sqlite tests/dist/devClaimServer.js
 *
 * It prints the two base URLs (sync on 8787, claim on 8788, or a free port
 * when one is taken) and the data folder, nothing secret.
 *
 * Polar stub: SITR_DEV_POLAR_SUBS, comma-separated entries
 *   <code>=<status>:<term>:<YYYY-MM-DD>[:<plan>]
 *   code    a subscription code (UUID); a code not listed → unknown-code
 *   status  Polar's status, passed through: active; past_due →
 *           payment-pending; canceled (or any other) → inactive;
 *           down → the stub answers 500 → billing-unavailable
 *   term    month | year (the subscription's interval)
 *   date    current_period_end, 00:00 UTC; on or before now → inactive
 *   plan    family (default) | inst-starter | inst-standard, each a
 *           configured product; other → a product not configured →
 *           wrong-product
 *
 * Apple (iOS): pass Xcode's StoreKit test certificate as the first argument
 * or SITR_DEV_STOREKIT_CERT. The claim server then trusts that certificate
 * (Xcode signs local StoreKit transactions with it; Apple documents it as a
 * root with no chain) and accepts only the environment `Xcode`, whose
 * tokens carry `test: true` like Sandbox ones. Without SITR_DEV_POLAR_SUBS
 * the certificate is required. Getting it (owner, once, in Xcode):
 *   1. In the Project navigator, select apps/ios/Configs/Sitr.storekit.
 *   2. Choose Editor > Save Public Certificate and save it as StoreKitTestCertificate.cer.
 *   3. Pass that file's path (keep it out of the repository), with
 *      SITR_APPLE_BUNDLE_ID=com.example.sitr SITR_APPLE_PRODUCTS=com.example.family.month=family:month
 * Still to confirm against a real Xcode receipt: the x5c chain may hold 1
 * to 3 certificates and must end in exactly this certificate.
 *
 * Optional:
 *   SITR_DEV_CLOCK_OFFSET_MS  milliseconds added to both servers' clock
 *                             (may be negative), to walk through renewal
 *                             windows, lapse and the 180-day rule
 *   SITR_DEV_DIR              data folder (databases, dev keys) to reuse,
 *                             so a restart with a new offset keeps the
 *                             households and bindings; default a new temp
 *                             folder, removed on exit
 *   SITR_DEV_SYNC_PORT (8787), SITR_DEV_CLAIM_PORT (8788)
 */
import { createServer, type Server } from "node:http";
import { X509Certificate, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";

import { AppleVerifier } from "../../server/sync/dist/apple.js";
import { ClaimHandler, claimListener } from "../../server/sync/dist/claim.js";
import { ClaimStore } from "../../server/sync/dist/claim-store.js";
import { SyncHandler, syncListener } from "../../server/sync/dist/http.js";
import { SyncStore } from "../../server/sync/dist/store.js";
import { configFromEnv, type Product } from "../../server/sync/dist/config.js";
import { keygen } from "../../server/sync/dist/mint.js";

/** `.invalid` never resolves; the stub fetch answers it and nothing else. */
export const POLAR_STUB_BASE = "http://polar-stub.invalid";
const PLANS = ["family", "inst-starter", "inst-standard"] as const;
/** The stub's products: `dev-<plan>-<term>` for every plan and term. */
export const STUB_PRODUCTS = new Map<string, Product>(
  PLANS.flatMap((plan) => (["month", "year"] as const).map((term) => [`dev-${plan}-${term}`, { plan, term }] as const)),
);

interface StubSub { status: string; term: string; end: string; product: string }

/** Parses SITR_DEV_POLAR_SUBS; throws naming the bad entry. */
export function parsePolarSubs(v: string): Map<string, StubSub> {
  const out = new Map<string, StubSub>();
  for (const entry of v.split(",").map((e) => e.trim()).filter((e) => e !== "")) {
    const m =
      /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12})=([a-z_]+):(month|year):(\d{4}-\d{2}-\d{2})(?::(family|inst-starter|inst-standard|other))?$/i.exec(entry);
    if (m === null || Number.isNaN(Date.parse(`${m[4]}T00:00:00Z`))) {
      throw new Error(`SITR_DEV_POLAR_SUBS: "${entry}" is not <uuid>=<status>:<month|year>:<YYYY-MM-DD>[:<plan>]`);
    }
    const plan = m[5] ?? "family";
    out.set(m[1]!.toLowerCase(), {
      status: m[2]!,
      term: m[3]!,
      end: `${m[4]}T00:00:00Z`,
      product: plan === "other" ? "dev-other" : `dev-${plan}-${m[3]}`,
    });
  }
  return out;
}

/** A fetch that answers Polar's subscription route from `subs` and throws for any other host. */
export function polarStubFetch(subs: Map<string, StubSub>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(`${POLAR_STUB_BASE}/`)) throw new Error("devClaimServer: outbound request refused");
    const m = /^\/v1\/subscriptions\/([^/]+)$/.exec(url.slice(POLAR_STUB_BASE.length));
    const s = m === null ? undefined : subs.get(m[1]!);
    if (s === undefined) return new Response("{}", { status: 404 });
    if (s.status === "down") return new Response("{}", { status: 500 });
    return Response.json({ status: s.status, product_id: s.product, recurring_interval: s.term, current_period_end: s.end });
  }) as typeof fetch;
}

/** Listens on 127.0.0.1:`port`, or on a free port when it is taken. */
const listen = (server: Server, port: number): Promise<number> =>
  new Promise((ok, no) => {
    const done = () => ok((server.address() as AddressInfo).port);
    server.once("error", (e: NodeJS.ErrnoException) => {
      if (e.code !== "EADDRINUSE") return no(e);
      server.listen(0, "127.0.0.1", done);
    });
    server.listen(port, "127.0.0.1", done);
  });

function fail(message: string): never {
  console.error(`devClaimServer: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const env = process.env;
  const subsRaw = env["SITR_DEV_POLAR_SUBS"];
  let subs = new Map<string, StubSub>();
  try {
    if (subsRaw !== undefined) subs = parsePolarSubs(subsRaw);
  } catch (e) {
    fail((e as Error).message);
  }
  const offsetRaw = env["SITR_DEV_CLOCK_OFFSET_MS"] ?? "0";
  if (!/^-?\d{1,15}$/.test(offsetRaw)) fail("SITR_DEV_CLOCK_OFFSET_MS must be an integer (milliseconds)");
  const offset = Number(offsetRaw);
  const now = () => Date.now() + offset;

  const certPath = process.argv[2] ?? env["SITR_DEV_STOREKIT_CERT"];
  let apple: AppleVerifier | undefined;
  if (certPath !== undefined && certPath !== "") {
    let testRoot: X509Certificate | undefined;
    try {
      testRoot = new X509Certificate(readFileSync(certPath)); // DER (.cer) or PEM
    } catch {
      // reported below
    }
    if (testRoot !== undefined) {
      // Environment `Xcode` is not `Production`, so the claim handler treats
      // it as Sandbox: source apple-sandbox, `test: true`, no binding.
      apple = new AppleVerifier({ testRoot }, new Set(["Xcode"]));
    }
  }
  if (apple === undefined && (subsRaw === undefined || (certPath !== undefined && certPath !== ""))) {
    fail(
      "StoreKit test certificate missing or unreadable. In Xcode select " +
        "apps/ios/Configs/Sitr.storekit, choose Editor > Save Public Certificate, then pass the " +
        "saved StoreKitTestCertificate.cer path as the first argument or as SITR_DEV_STOREKIT_CERT " +
        "(or set SITR_DEV_POLAR_SUBS to run with the Polar stub only).",
    );
  }

  const given = env["SITR_DEV_DIR"];
  const dir = given !== undefined && given !== "" ? given : mkdtempSync(join(tmpdir(), "sitr-dev-"));
  if (dir !== given) {
    process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));
  }
  // Throwaway keys, kept in the data folder so a restart on it still accepts
  // tokens minted before.
  const keyFile = join(dir, "dev-keys.json");
  if (!existsSync(keyFile)) {
    const kp = keygen();
    const keys = { privateB64: kp.privateB64, publicB64: kp.publicB64, claimKey: randomBytes(32).toString("base64") };
    writeFileSync(keyFile, JSON.stringify(keys), { mode: 0o600 });
  }
  const keys = JSON.parse(readFileSync(keyFile, "utf8")) as { privateB64: string; publicB64: string; claimKey: string };

  const base = configFromEnv({ ...env, SITR_POLAR_TOKEN: undefined, SITR_POLAR_PRODUCTS: undefined, SITR_POLAR_API: undefined });
  const claimConfig = {
    ...base,
    entitlementPrivKeyB64: keys.privateB64,
    claimKey: Buffer.from(keys.claimKey, "base64"),
    polarApiBase: POLAR_STUB_BASE,
    // Without SITR_DEV_POLAR_SUBS no Polar token: Polar claims are claims-disabled.
    polarAccessToken: subsRaw === undefined ? undefined : "dev-stub",
    polarProducts: subsRaw === undefined ? new Map<string, Product>() : STUB_PRODUCTS,
  };
  const syncConfig = { ...base, entitlementPubKeyB64: keys.publicB64, entitlementPrivKeyB64: undefined };
  const claims = new ClaimHandler(claimConfig, now, polarStubFetch(subs), {
    store: new ClaimStore(join(dir, "claim.sqlite")),
    ...(apple ? { apple } : {}),
  });
  const sync = new SyncHandler(new SyncStore(join(dir, "sync.sqlite")), syncConfig, now);
  const port = (name: string, dflt: number): number => {
    const v = env[name] ?? String(dflt);
    if (!/^\d{1,5}$/.test(v)) fail(`${name} must be a port number`);
    return Number(v);
  };
  const syncPort = await listen(createServer(syncListener(sync, syncConfig)), port("SITR_DEV_SYNC_PORT", 8787));
  const claimPort = await listen(createServer(claimListener(claims, false)), port("SITR_DEV_CLAIM_PORT", 8788));
  const modes = [subsRaw === undefined ? "" : `Polar stub (${subs.size} codes)`, apple ? "Xcode receipts" : ""];
  console.log(`dev sync server  http://127.0.0.1:${syncPort}`);
  console.log(`dev claim server http://127.0.0.1:${claimPort} (${modes.filter((m) => m !== "").join(", ")})`);
  console.log(`data folder ${dir}${dir === given ? "" : " (removed on exit)"}; clock offset ${offset} ms`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
