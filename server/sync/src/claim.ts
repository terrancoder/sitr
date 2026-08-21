/**
 * Entitlement claim handling — runs in its OWN process (claim-server.ts),
 * separate from the sync server, so the Ed25519 minting key never lives in
 * the process that parses untrusted blob traffic. The sync process keeps
 * only the public key.
 */
import type { Config } from "./config.js";
import { WindowCounter, hashIp } from "./ratelimit.js";
import { mintToken, privateKeyFromB64 } from "./mint.js";
import {
  EMPTY,
  NO_STORE,
  text,
  type SyncRequest,
  type SyncResponse,
} from "./http.js";

const CLAIM_RE = /^\/v1\/entitlement\/claim\/([A-Za-z0-9_-]{1,128})$/;

export class ClaimHandler {
  private readonly claims: WindowCounter;

  constructor(
    private readonly config: Config,
    private readonly now: () => number = Date.now,
    /** Injected for tests; the only outbound call (Polar API). */
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.claims = new WindowCounter(3_600_000, config.createsPerIpPerHour);
  }

  /**
   * One-time claim: exchange a completed Polar checkout for a signed
   * entitlement token. Called by the WEBSITE after checkout — never by any
   * client, so every client's endpoint inventory is unchanged. The token
   * carries no customer identity; we ask Polar only "is this checkout
   * paid?".
   */
  async handleClaim(req: SyncRequest): Promise<SyncResponse> {
    const cors = {
      "Access-Control-Allow-Origin": this.config.claimAllowedOrigin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    };
    // The site's claim page must be able to READ error statuses too, so
    // every response from this endpoint carries the CORS headers.
    const fail = (status: number, message: string): SyncResponse => {
      const r = text(status, message);
      return { ...r, headers: { ...r.headers, ...cors } };
    };
    const m = CLAIM_RE.exec(req.path);
    if (m === null) return fail(404, "not found");
    if (req.method === "OPTIONS") {
      return { status: 204, headers: { ...NO_STORE, ...cors }, body: EMPTY };
    }
    if (req.method !== "GET") return fail(405, "method not allowed");
    if (
      this.config.polarAccessToken === undefined ||
      this.config.entitlementPrivKeyB64 === undefined
    ) {
      return fail(503, "claims are not enabled on this server");
    }
    if (!this.claims.allow(hashIp(req.ip), this.now())) {
      return fail(429, "slow down");
    }
    let checkout: { status?: string } | undefined;
    try {
      const res = await this.fetchImpl(
        `${this.config.polarApiBase}/v1/checkouts/${m[1]!}`,
        { headers: { Authorization: `Bearer ${this.config.polarAccessToken}` } },
      );
      if (res.status === 404) return fail(404, "unknown checkout");
      if (!res.ok) return fail(502, "billing provider unavailable");
      checkout = (await res.json()) as { status?: string };
    } catch {
      return fail(502, "billing provider unavailable");
    }
    if (checkout.status !== "succeeded" && checkout.status !== "confirmed") {
      return fail(402, "checkout not completed");
    }
    const token = mintToken(
      privateKeyFromB64(this.config.entitlementPrivKeyB64),
      "family",
      this.now() + this.config.entitlementDays * 24 * 60 * 60 * 1000,
    );
    return {
      status: 200,
      headers: {
        ...NO_STORE,
        ...cors,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: new TextEncoder().encode(JSON.stringify({ token })),
    };
  }
}
