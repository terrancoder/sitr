/** Server configuration — environment-driven, defaults safe for local dev. */

export interface Config {
  port: number;
  /** Port for the claim service's own process (claim-server.ts). */
  claimPort: number;
  /**
   * True only when the process sits behind our own reverse proxy: derive
   * the client IP from the LAST X-Forwarded-For entry (the hop our proxy
   * appended). False (default) ignores the header entirely — a direct
   * client must not be able to spoof its way out of a rate limit.
   */
  trustedProxy: boolean;
  /** SQLite path; ":memory:" for tests. */
  dbPath: string;
  maxBlobBytes: number;
  /** New-household creations allowed per client IP per hour. */
  createsPerIpPerHour: number;
  /** Requests allowed per household id per minute. */
  requestsPerIdPerMinute: number;
  /** Blobs idle longer than this are deleted by GC. */
  idleExpiryMs: number;
  /**
   * base64 raw Ed25519 public key. When set, creating a household requires
   * a valid entitlement token. Unset (default) = free/open server.
   */
  entitlementPubKeyB64: string | undefined;
  /** base64 raw Ed25519 private key for the claim endpoint's minting. */
  entitlementPrivKeyB64: string | undefined;
  /** Polar API access token; claim endpoint is disabled without it. */
  polarAccessToken: string | undefined;
  /** Polar API base URL (sandbox vs production). */
  polarApiBase: string;
  /** Origin allowed to call the claim endpoint from a browser (the site). */
  claimAllowedOrigin: string;
  /** Days of entitlement granted per successful claim. */
  entitlementDays: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv): Config {
  const int = (v: string | undefined, dflt: number): number => {
    const n = v === undefined ? NaN : Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  return {
    port: int(env["SITR_SYNC_PORT"], 8787),
    claimPort: int(env["SITR_CLAIM_PORT"], 8788),
    trustedProxy:
      env["SITR_TRUSTED_PROXY"] === "1" || env["SITR_TRUSTED_PROXY"] === "true",
    dbPath: env["SITR_SYNC_DB"] ?? "sitr-sync.sqlite",
    maxBlobBytes: 64 * 1024,
    createsPerIpPerHour: int(env["SITR_SYNC_CREATES_PER_IP_HOUR"], 20),
    requestsPerIdPerMinute: int(env["SITR_SYNC_REQS_PER_ID_MIN"], 60),
    idleExpiryMs: 18 * 30 * 24 * 60 * 60 * 1000, // ~18 months
    entitlementPubKeyB64: env["SITR_ENTITLEMENT_PUBKEY"] || undefined,
    entitlementPrivKeyB64: env["SITR_ENTITLEMENT_PRIVKEY"] || undefined,
    polarAccessToken: env["SITR_POLAR_TOKEN"] || undefined,
    polarApiBase: env["SITR_POLAR_API"] ?? "https://api.polar.sh",
    claimAllowedOrigin: env["SITR_CLAIM_ORIGIN"] ?? "https://sitrshield.com",
    entitlementDays: int(env["SITR_ENTITLEMENT_DAYS"], 366),
  };
}
