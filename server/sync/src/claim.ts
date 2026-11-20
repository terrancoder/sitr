/**
 * Entitlement claim handling — runs in its OWN process (claim-server.ts),
 * separate from the sync server, so the Ed25519 minting key and the claim
 * key never live in the process that parses untrusted blob traffic. The
 * sync process keeps only the public key.
 *
 * docs/sync-protocol.md §Entitlement version 2 → Claim API. Routes:
 *   POST /v1/entitlement/claim                     version 2 claim
 *   GET  /v1/entitlement/subscription/{checkoutId} checkout → subscription code
 *   POST /v1/entitlement/apple/notifications       App Store Server Notifications V2
 *   GET  /v1/entitlement/claim/{checkoutId}        version 1, until the cut-over
 * Nothing here logs a request or a billing answer.
 */
import { createHmac, timingSafeEqual, type KeyObject } from "node:crypto";
import type { Config, Product } from "./config.js";
import { WindowCounter, hashIp } from "./ratelimit.js";
import { mintToken, mintTokenV2, privateKeyFromB64 } from "./mint.js";
import { EMPTY, NO_STORE, jsonObject, nodeListener, text, type SyncRequest, type SyncResponse } from "./http.js";
import type { ClaimStore } from "./claim-store.js";
import type { AppleVerifier } from "./apple.js";
import { DAY } from "./entitlement.js";

const HOUR = 3_600_000;
/** Changed only together with a review of the Polar fields read below. */
export const POLAR_VERSION = "2026-10";
const CLAIM_BODY_MAX = 16 * 1024;
const NOTIFY_BODY_MAX = 64 * 1024;
const PER_MARKER_HOUR = 10;
const NOTIFY_PER_IP_HOUR = 600;

const V1_RE = /^\/v1\/entitlement\/claim\/([A-Za-z0-9_-]{1,128})$/;
const SUB_RE = /^\/v1\/entitlement\/subscription\/([A-Za-z0-9_-]{1,128})$/;
const CLAIM_PATH = "/v1/entitlement/claim";
const NOTIFY_PATH = "/v1/entitlement/apple/notifications";
/** Any UUID version (Polar may issue others than 4), canonical form, RFC 4122 variant. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Source = "polar" | "apple" | "apple-sandbox";
type Fail = { status: number; error: string; retry_after?: number };
type Verified = Product & {
  source: Source;
  subscriptionId: string;
  paidEnd: number;
  /** Apple only: the receipt's own transaction, checked against refunds. */
  transactionId?: string;
};

/* ----------------------------- issue period ----------------------------- */

export const monthStart = (t: number): number => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};
export const nextMonth = (t: number): number => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};
export const nextDay = (t: number): number => Math.floor(t / DAY) * DAY + DAY;

/** §The issue period. */
export function issuePeriod(
  now: number,
  paidEnd: number,
  current: boolean,
  sandbox: boolean,
): { per: number; periodEnd: number; exp: number } {
  if (sandbox) {
    const periodEnd = nextDay(now);
    return { per: periodEnd - DAY, periodEnd, exp: periodEnd + HOUR };
  }
  const m = nextMonth(now);
  const next = now >= m - 7 * DAY && paidEnd > m && !current;
  const periodEnd = next ? nextMonth(m) : m;
  return { per: next ? m : monthStart(now), periodEnd, exp: periodEnd + 3 * DAY };
}

/* ---------------------------- derived values ---------------------------- */

const hmac = (key: Buffer, ...parts: (string | Uint8Array)[]): Buffer => {
  const h = createHmac("sha256", key);
  for (const p of parts) h.update(p);
  return h.digest();
};
const Z = Buffer.from([0]);
const be64 = (n: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};

export const deriveMarker = (key: Buffer, source: Source, subscriptionId: string): Buffer =>
  hmac(key, "sitr-claim v2 marker", Z, source, Z, subscriptionId);
export const deriveBinder = (key: Buffer, marker: Uint8Array, claimSecret: Uint8Array): Buffer =>
  hmac(key, "sitr-claim v2 binder", Z, marker, claimSecret);
export const deriveJti = (
  key: Buffer,
  marker: Uint8Array,
  periodEnd: number,
  exp: number,
  claimSecret: Uint8Array,
): Buffer =>
  hmac(key, "sitr-claim v2 jti", Z, marker, be64(periodEnd), be64(exp), claimSecret).subarray(0, 16);
const checkoutHash = (key: Buffer, checkoutId: string): Buffer =>
  hmac(key, "sitr-claim v1 checkout", Z, checkoutId);
/** Keyed hash of a refunded Apple transaction; the raw ID is never stored. */
export const deriveRevokedTx = (key: Buffer, source: Source, transactionId: string): Buffer =>
  hmac(key, "sitr-claim v2 revoked transaction", Z, source, Z, transactionId);

/* ------------------------------- helpers -------------------------------- */

function json(status: number, body: object, headers: Record<string, string> = {}): SyncResponse {
  return {
    status,
    headers: { ...NO_STORE, ...headers, "Content-Type": "application/json; charset=utf-8" },
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
}
const empty = (status: number): SyncResponse => ({ status, headers: { ...NO_STORE }, body: EMPTY });
const options = (cors: Record<string, string>): SyncResponse => ({ status: 204, headers: { ...NO_STORE, ...cors }, body: EMPTY });

/** A request body as a JSON object; invalid UTF-8 counts as not JSON. */
function parseObject(body: Uint8Array): Record<string, unknown> | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
  return jsonObject(text);
}
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Only the allow-listed fields of a Polar answer survive this function. */
function pickSubscription(b: unknown) {
  const o = (typeof b === "object" && b !== null ? b : {}) as Record<string, unknown>;
  const end = str(o["current_period_end"]);
  return {
    status: str(o["status"]),
    productId: str(o["product_id"]),
    interval: str(o["recurring_interval"]),
    paidEnd: end === undefined ? NaN : Date.parse(end),
  };
}
function pickCheckout(b: unknown) {
  const o = (typeof b === "object" && b !== null ? b : {}) as Record<string, unknown>;
  return { status: str(o["status"]), subscriptionId: str(o["subscription_id"]) };
}

/* ------------------------------- handler -------------------------------- */

export class ClaimHandler {
  private readonly perIp: WindowCounter;
  private readonly perMarker = new WindowCounter(HOUR, PER_MARKER_HOUR);
  private readonly notifyPerIp = new WindowCounter(HOUR, NOTIFY_PER_IP_HOUR);
  private readonly signKey: KeyObject | undefined;
  private readonly store: ClaimStore | undefined;
  private readonly apple: AppleVerifier | undefined;

  constructor(
    private readonly config: Config,
    private readonly now: () => number = Date.now,
    /** Injected for tests; the only outbound calls (Polar API). */
    private readonly fetchImpl: typeof fetch = fetch,
    opts: { store?: ClaimStore; apple?: AppleVerifier } = {},
  ) {
    this.perIp = new WindowCounter(HOUR, config.claimPerIpPerHour);
    this.signKey =
      config.entitlementPrivKeyB64 === undefined ? undefined : privateKeyFromB64(config.entitlementPrivKeyB64);
    this.store = opts.store;
    this.apple = opts.apple;
  }

  private cors(methods: string, extra: Record<string, string> = {}): Record<string, string> {
    return { "Access-Control-Allow-Origin": this.config.claimAllowedOrigin, "Access-Control-Allow-Methods": methods, ...extra };
  }

  async handle(req: SyncRequest): Promise<SyncResponse> {
    if (req.path === CLAIM_PATH) return this.claim(req);
    if (SUB_RE.test(req.path)) return this.exchange(req);
    if (req.path === NOTIFY_PATH) return this.notify(req);
    if (V1_RE.test(req.path)) return this.handleClaim(req);
    return json(404, { error: "not-found" });
  }

  /** One Polar GET with the pinned API version and a 10 s timeout. */
  private async polarGet(path: string): Promise<{ status: 200; body: unknown } | { status: 404 } | null> {
    try {
      const res = await this.fetchImpl(`${this.config.polarApiBase}${path}`, {
        headers: {
          Authorization: `Bearer ${this.config.polarAccessToken}`,
          "Polar-Version": POLAR_VERSION,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 404) return { status: 404 };
      if (!res.ok) return null;
      return { status: 200, body: await res.json() };
    } catch {
      return null;
    }
  }

  /* ---------------------- POST /v1/entitlement/claim --------------------- */

  private async claim(req: SyncRequest): Promise<SyncResponse> {
    const cors = this.cors("POST, OPTIONS", { "Access-Control-Allow-Headers": "Content-Type" });
    const fail = (f: Fail): SyncResponse => {
      const { status, ...body } = f;
      return json(status, body, cors);
    };
    if (req.method === "OPTIONS") return options(cors);
    if (req.method !== "POST") return fail({ status: 405, error: "method-not-allowed" });
    const key = this.config.claimKey;
    if (this.signKey === undefined || key === undefined || this.store === undefined) {
      return fail({ status: 503, error: "claims-disabled" });
    }
    const now = this.now();
    if (!this.perIp.allow(hashIp(req.ip), now)) return fail({ status: 429, error: "slow-down" });
    if (req.body.length > CLAIM_BODY_MAX) return fail({ status: 413, error: "too-large" });
    const b = parseObject(req.body);
    const secret = Buffer.from(str(b?.["claim_secret"]) ?? "", "base64url");
    const source = b?.["source"];
    const credential = str(b?.["credential"]);
    const replace = b?.["replace"] ?? false;
    const current = b?.["current"] ?? false;
    if (
      b === null ||
      (source !== "polar" && source !== "apple") ||
      credential === undefined ||
      !/^[A-Za-z0-9_-]{43}$/.test(str(b["claim_secret"]) ?? "") ||
      secret.length !== 32 ||
      typeof replace !== "boolean" ||
      typeof current !== "boolean" ||
      (source === "polar" && !UUID_RE.test(credential))
    ) {
      return fail({ status: 400, error: "bad-request" });
    }
    const configured =
      source === "polar"
        ? this.config.polarAccessToken !== undefined && this.config.polarProducts.size > 0
        : this.apple !== undefined && this.config.appleBundleId !== undefined && this.config.appleProducts.size > 0;
    if (!configured) return fail({ status: 503, error: "claims-disabled" });

    const v =
      source === "polar"
        ? await this.verifyPolar(credential.toLowerCase(), now)
        : this.verifyApple(credential, now);
    if ("error" in v) return fail(v);
    const marker = deriveMarker(key, v.source, v.subscriptionId);
    // The per-marker limit counts issued claims only, so refused claims by a
    // holder of the code (limited per IP) cannot lock out the bound device.
    const markerKey = marker.toString("hex");
    if (this.perMarker.blocked(markerKey, now)) return fail({ status: 429, error: "slow-down" });
    // A refunded or revoked Apple transaction (§Revocation), per transaction.
    if (v.transactionId !== undefined && this.store.isRevoked(deriveRevokedTx(key, v.source, v.transactionId))) {
      return fail({ status: 402, error: "revoked" });
    }

    const sandbox = v.source === "apple-sandbox";
    const { per, periodEnd, exp } = issuePeriod(now, v.paidEnd, current, sandbox);
    // Sandbox: no binding, nothing stored (§Claim API → Sandbox).
    if (!sandbox) {
      const refused = this.bind(marker, deriveBinder(key, marker, secret), periodEnd, replace, now);
      if (refused !== null) return fail(refused);
    }
    this.perMarker.allow(markerKey, now);
    const jti = deriveJti(key, marker, periodEnd, exp, secret).toString("base64url");
    const token = mintTokenV2(this.signKey, {
      v: 2,
      plan: v.plan,
      term: v.term,
      per,
      exp,
      jti,
      ...(sandbox ? { test: true as const } : {}),
    });
    return json(200, { token }, cors);
  }

  /** §Claim API → Binding rules, in one BEGIN IMMEDIATE transaction. */
  private bind(marker: Buffer, binder: Buffer, periodEnd: number, replace: boolean, now: number): Fail | null {
    const store = this.store!;
    const R = this.config.replacementDays;
    const today = Math.floor(now / DAY);
    return store.tx(() => {
      const row = store.marker(marker);
      const stale =
        row !== undefined &&
        row.binder !== null &&
        (row.last_period_end === null || row.last_period_end + 3 * DAY <= now);
      if (row === undefined || row.binder === null || stale) {
        store.bind(marker, binder, periodEnd, row?.replaced_day ?? null);
        return null;
      }
      if (row.binder.length === binder.length && timingSafeEqual(row.binder, binder)) {
        store.setLastPeriodEnd(marker, Math.max(row.last_period_end ?? 0, periodEnd));
        return null;
      }
      if (!replace) return { status: 409, error: "bound-to-other-device" };
      if (row.replaced_day === null || today - row.replaced_day >= R) {
        store.bind(marker, binder, periodEnd, today);
        return null;
      }
      return { status: 409, error: "replacement-used", retry_after: (row.replaced_day + R) * DAY };
    });
  }

  private async verifyPolar(subscriptionId: string, now: number): Promise<Verified | Fail> {
    const r = await this.polarGet(`/v1/subscriptions/${subscriptionId}`);
    if (r === null) return { status: 502, error: "billing-unavailable" };
    if (r.status === 404) return { status: 404, error: "unknown-code" };
    const s = pickSubscription(r.body);
    if (s.status === "past_due") return { status: 402, error: "payment-pending" };
    if (s.status !== "active") return { status: 402, error: "inactive" };
    // A JSON answer with a field missing or of the wrong type is inactive; a
    // body that is not JSON at all was billing-unavailable in polarGet.
    if (s.productId === undefined || s.interval === undefined || Number.isNaN(s.paidEnd)) {
      return { status: 402, error: "inactive" };
    }
    const product = this.config.polarProducts.get(s.productId);
    if (product === undefined || s.interval !== product.term) return { status: 422, error: "wrong-product" };
    if (!(s.paidEnd > now)) return { status: 402, error: "inactive" };
    return { ...product, source: "polar", subscriptionId, paidEnd: s.paidEnd };
  }

  /** Steps 1 to 19 of §Apple verification. */
  private verifyApple(jws: string, now: number): Verified | Fail {
    const p = this.apple!.verify(jws);
    const invalid = { status: 422, error: "invalid-receipt" };
    if (p === null || p["bundleId"] !== this.config.appleBundleId) return invalid;
    const env = str(p["environment"]);
    if (env === undefined || !this.apple!.environments.has(env)) return { status: 422, error: "test-purchase" };
    const productId = str(p["productId"]);
    const product = productId === undefined ? undefined : this.config.appleProducts.get(productId);
    if (product === undefined) return { status: 422, error: "wrong-product" };
    if (p["inAppOwnershipType"] !== "PURCHASED") return { status: 422, error: "family-sharing" };
    if (p["revocationDate"] !== undefined) return { status: 402, error: "revoked" };
    const expires = p["expiresDate"];
    if (typeof expires !== "number" || !(expires > now)) return { status: 402, error: "inactive" };
    const otid = str(p["originalTransactionId"]);
    const transactionId = str(p["transactionId"]);
    if (otid === undefined || otid === "" || transactionId === undefined || transactionId === "") return invalid;
    return {
      ...product,
      source: env === "Production" ? "apple" : "apple-sandbox",
      subscriptionId: otid,
      paidEnd: expires,
      transactionId,
    };
  }

  /* ------------- GET /v1/entitlement/subscription/{checkoutId} ------------ */

  private async exchange(req: SyncRequest): Promise<SyncResponse> {
    const cors = this.cors("GET, OPTIONS");
    const fail = (status: number, error: string) => json(status, { error }, cors);
    if (req.method === "OPTIONS") return options(cors);
    if (req.method !== "GET") return fail(405, "method-not-allowed");
    if (this.config.polarAccessToken === undefined) return fail(503, "claims-disabled");
    if (!this.perIp.allow(hashIp(req.ip), this.now())) return fail(429, "slow-down");
    const r = await this.polarGet(`/v1/checkouts/${SUB_RE.exec(req.path)![1]!}`);
    if (r === null) return fail(502, "billing-unavailable");
    if (r.status === 404) return fail(404, "unknown-checkout");
    const c = pickCheckout(r.body);
    if (c.status !== "succeeded") return fail(402, "not-paid");
    if (c.subscriptionId === undefined || c.subscriptionId === "") return fail(422, "not-a-subscription");
    return json(200, { code: c.subscriptionId.toLowerCase() }, cors);
  }

  /* --------------- POST /v1/entitlement/apple/notifications --------------- */

  private notify(req: SyncRequest): SyncResponse {
    if (req.method !== "POST") return json(405, { error: "method-not-allowed" });
    const key = this.config.claimKey;
    const bundle = this.config.appleBundleId;
    if (this.apple === undefined || bundle === undefined || key === undefined || this.store === undefined) {
      return json(503, { error: "claims-disabled" });
    }
    if (!this.notifyPerIp.allow(hashIp(req.ip), this.now())) return empty(429);
    if (req.body.length > NOTIFY_BODY_MAX) return empty(413);
    const signed = str(parseObject(req.body)?.["signedPayload"]);
    const n = signed === undefined ? null : this.apple.verify(signed);
    const data = n?.["data"] as Record<string, unknown> | undefined;
    if (n === null || typeof data !== "object" || data === null || data["bundleId"] !== bundle) return empty(400);
    const env = str(data["environment"]);
    // Sandbox notifications count only while Sandbox is on.
    if (env === undefined || !this.apple.environments.has(env)) return empty(200);
    const type = n["notificationType"];
    if (type !== "REFUND" && type !== "REVOKE" && type !== "REFUND_REVERSED") return empty(200);
    const t = this.apple.verify(str(data["signedTransactionInfo"]) ?? "");
    if (t === null || t["bundleId"] !== bundle) return empty(400);
    // 400 only when verification fails (Apple retries those for days). A
    // verified transaction without a transactionId or a numeric expiresDate
    // is answered 200 and stores nothing: its receipt is refused at claim
    // time anyway (invalid-receipt, inactive).
    const transactionId = str(t["transactionId"]);
    const expires = t["expiresDate"];
    if (transactionId === undefined || transactionId === "" || typeof expires !== "number") return empty(200);
    const txHash = deriveRevokedTx(key, env === "Production" ? "apple" : "apple-sandbox", transactionId);
    // The notice's own signedDate (a number after verification) orders
    // refunds and reversals, whichever arrives first.
    this.store.notice(txHash, expires, n["signedDate"] as number, type !== "REFUND_REVERSED");
    return empty(200);
  }

  /* ---------------- GET /v1/entitlement/claim/{checkoutId} ---------------- */

  /**
   * Version 1: exchange a completed Polar checkout for a `sitr-ent-v1.`
   * token, called by the WEBSITE. Restricted from the version 2 deployment
   * (§Transition and cut-over): active subscription only, at most one token
   * per checkout (re-issued byte-identical until its exp), refused from the
   * cut-over date.
   */
  async handleClaim(req: SyncRequest): Promise<SyncResponse> {
    const cors = this.cors("GET, OPTIONS");
    // The site's claim page must be able to READ error statuses too, so
    // every response from this endpoint carries the CORS headers.
    const fail = (status: number, message: string): SyncResponse => {
      const r = text(status, message);
      return { ...r, headers: { ...r.headers, ...cors } };
    };
    const m = V1_RE.exec(req.path);
    if (m === null) return fail(404, "not found");
    if (req.method === "OPTIONS") return options(cors);
    if (req.method !== "GET") return fail(405, "method not allowed");
    const now = this.now();
    const cut = this.config.v1CutoverMs;
    if (cut !== undefined && now >= cut) return fail(410, "v1-ended");
    const key = this.config.claimKey;
    const signKey = this.signKey;
    const store = this.store;
    if (this.config.polarAccessToken === undefined || signKey === undefined || key === undefined || store === undefined) {
      return fail(503, "claims are not enabled on this server");
    }
    if (!this.perIp.allow(hashIp(req.ip), now)) return fail(429, "slow down");
    const r = await this.polarGet(`/v1/checkouts/${m[1]!}`);
    if (r === null) return fail(502, "billing provider unavailable");
    if (r.status === 404) return fail(404, "unknown checkout");
    const checkout = pickCheckout(r.body);
    if (checkout.status !== "succeeded" && checkout.status !== "confirmed") {
      return fail(402, "checkout not completed");
    }
    // Empty, missing or malformed: never put into a URL (an empty one would
    // list every subscription).
    if (!UUID_RE.test(checkout.subscriptionId ?? "")) return fail(402, "inactive");
    const s = await this.polarGet(`/v1/subscriptions/${checkout.subscriptionId}`);
    if (s === null) return fail(502, "billing provider unavailable");
    const sub = s.status === 200 ? pickSubscription(s.body) : undefined;
    if (sub === undefined || sub.status !== "active" || !(sub.paidEnd > now)) return fail(402, "inactive");
    // Version 1 tokens are Family tokens: only a Family product may mint one.
    const product = sub.productId === undefined ? undefined : this.config.polarProducts.get(sub.productId);
    if (product?.plan !== "family") return fail(422, "wrong-product");
    const hash = checkoutHash(key, m[1]!);
    const token = store.tx(() => {
      let exp = store.v1Claim(hash);
      if (exp !== undefined) return now < exp ? mintToken(signKey, "family", exp) : null;
      exp = now + this.config.entitlementDays * DAY;
      store.addV1Claim(hash, exp);
      return mintToken(signKey, "family", exp);
    });
    if (token === null) return fail(409, "already-claimed");
    return json(200, { token }, cors);
  }
}

/** node:http wiring for the claim process (claim-server.ts, dev entry point). */
export const claimListener = (handler: ClaimHandler, trustedProxy: boolean) =>
  nodeListener("sitr-claim", NOTIFY_BODY_MAX + 1, trustedProxy, [], (r) => handler.handle(r));
