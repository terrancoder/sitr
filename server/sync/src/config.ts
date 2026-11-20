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
  /** Version 1 claim route: redeem deadline of a minted token, in days. */
  entitlementDays: number;
  /** SITR_V1_CUTOVER as epoch ms (UTC midnight), or undefined while unset. */
  v1CutoverMs: number | undefined;
  /** SITR_CLAIM_KEY: 32-byte claim key (claim process only). */
  claimKey: Buffer | undefined;
  /** SITR_CLAIM_DB: the claim database, never the sync database. */
  claimDbPath: string;
  /** SITR_POLAR_PRODUCTS / SITR_APPLE_PRODUCTS: product ID → plan and term. */
  polarProducts: Map<string, Product>;
  appleProducts: Map<string, Product>;
  appleBundleId: string | undefined;
  /** SITR_APPLE_SANDBOX=1: accept Sandbox receipts (test tokens). */
  appleSandbox: boolean;
  /** Days between rebinds per marker. */
  replacementDays: number;
  /** Claims per IP hash per hour, shared by the claim routes. */
  claimPerIpPerHour: number;
}

export interface Product {
  plan: "family" | "inst-starter" | "inst-standard";
  term: "month" | "year";
}

function parseProducts(name: string, v: string | undefined): Map<string, Product> {
  const out = new Map<string, Product>();
  if (v === undefined) return out;
  const entries = v.split(",").map((e) => e.trim()).filter((e) => e !== "");
  if (entries.length === 0) throw new Error(`${name} is set but lists no product`);
  for (const entry of entries) {
    const m = /^([^=\s]+)=(family|inst-starter|inst-standard):(month|year)$/.exec(entry);
    if (m === null) throw new Error(`${name}: every entry must be productId=plan:term`);
    out.set(m[1]!, { plan: m[2] as Product["plan"], term: m[3] as Product["term"] });
  }
  return out;
}

function parseClaimKey(v: string | undefined): Buffer | undefined {
  if (v === undefined) return undefined;
  const key = Buffer.from(v, "base64");
  if (key.length !== 32) throw new Error("SITR_CLAIM_KEY must be 32 bytes of base64");
  return key;
}

function parseCutover(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  // Refuse anything but YYYY-MM-DD: a value silently ignored would leave
  // legacy households without an end.
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : NaN;
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== v) {
    throw new Error("SITR_V1_CUTOVER must be a date YYYY-MM-DD");
  }
  return ms;
}

/**
 * Reads the environment. A variable that is set but cannot be used throws an
 * error naming the variable (never its value), so a process fails at start-up
 * instead of silently falling back to a default.
 *
 * A variable set to an empty or blank value counts as unset (existing env
 * files carry such lines) when unset only falls back to a harmless default.
 * It is refused where unset would silently switch off a check or lose data:
 * the database paths (SQLite would open a temporary database lost on every
 * restart), the keys and the Polar token (a blank public key would make an
 * open server) and the cut-over date (version 1 tokens would never end).
 */
const BLANK_REFUSED = new Set([
  "SITR_SYNC_DB", "SITR_CLAIM_DB", "SITR_ENTITLEMENT_PUBKEY", "SITR_ENTITLEMENT_PRIVKEY",
  "SITR_CLAIM_KEY", "SITR_POLAR_TOKEN", "SITR_V1_CUTOVER",
]);

export function configFromEnv(env: NodeJS.ProcessEnv): Config {
  const raw = (name: string): string | undefined => {
    const v = env[name];
    if (v === undefined || v.trim() !== "") return v;
    if (BLANK_REFUSED.has(name)) throw new Error(`${name} is set but empty`);
    return undefined;
  };
  const dbPath = (name: string, dflt: string): string => {
    const v = raw(name) ?? dflt;
    // Tests get an in-memory database by passing ":memory:" to the store's
    // constructor; through the environment it would lose all data on restart.
    if (v === ":memory:") throw new Error(`${name} must be a file path, not an in-memory database`);
    return v;
  };
  const int = (name: string, dflt: number): number => {
    const v = raw(name);
    if (v === undefined) return dflt;
    if (!/^\d{1,9}$/.test(v) || Number(v) < 1) throw new Error(`${name} must be a positive integer`);
    return Number(v);
  };
  const bool = (name: string): boolean => {
    const v = raw(name);
    if (v === undefined || v === "0" || v === "false") return false;
    if (v === "1" || v === "true") return true;
    throw new Error(`${name} must be 1 or 0`);
  };
  const url = (name: string, dflt: string, originOnly: boolean): string => {
    const v = raw(name) ?? dflt;
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      throw new Error(`${name} must be an absolute https:// or http:// URL`);
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      throw new Error(`${name} must be an absolute https:// or http:// URL`);
    }
    if (originOnly && u.origin !== v) throw new Error(`${name} must be an origin such as https://example.org (no path)`);
    return v;
  };
  return {
    port: int("SITR_SYNC_PORT", 8787),
    claimPort: int("SITR_CLAIM_PORT", 8788),
    trustedProxy: bool("SITR_TRUSTED_PROXY"),
    dbPath: dbPath("SITR_SYNC_DB", "sitr-sync.sqlite"),
    maxBlobBytes: 64 * 1024,
    createsPerIpPerHour: int("SITR_SYNC_CREATES_PER_IP_HOUR", 20),
    requestsPerIdPerMinute: int("SITR_SYNC_REQS_PER_ID_MIN", 60),
    idleExpiryMs: 18 * 30 * 24 * 60 * 60 * 1000, // ~18 months
    entitlementPubKeyB64: raw("SITR_ENTITLEMENT_PUBKEY"),
    entitlementPrivKeyB64: raw("SITR_ENTITLEMENT_PRIVKEY"),
    polarAccessToken: raw("SITR_POLAR_TOKEN"),
    // An origin only: request paths are appended to it (a trailing slash or a
    // path would turn every lookup into a 404, reported as unknown-code).
    polarApiBase: url("SITR_POLAR_API", "https://api.polar.sh", true),
    claimAllowedOrigin: url("SITR_CLAIM_ORIGIN", "https://sitrshield.com", true),
    entitlementDays: int("SITR_ENTITLEMENT_DAYS", 7),
    v1CutoverMs: parseCutover(raw("SITR_V1_CUTOVER")),
    claimKey: parseClaimKey(raw("SITR_CLAIM_KEY")),
    claimDbPath: dbPath("SITR_CLAIM_DB", "sitr-claim.sqlite"),
    polarProducts: parseProducts("SITR_POLAR_PRODUCTS", raw("SITR_POLAR_PRODUCTS")),
    appleProducts: parseProducts("SITR_APPLE_PRODUCTS", raw("SITR_APPLE_PRODUCTS")),
    appleBundleId: raw("SITR_APPLE_BUNDLE_ID"),
    appleSandbox: bool("SITR_APPLE_SANDBOX"),
    replacementDays: int("SITR_REPLACEMENT_DAYS", 180),
    claimPerIpPerHour: int("SITR_CLAIM_PER_IP_HOUR", 60),
  };
}

/**
 * The claim process's start-up check: combinations that cannot work. Throws
 * one error listing every problem, naming variables only.
 */
export function checkClaimConfig(c: Config): void {
  const problems: string[] = [];
  const keys = c.entitlementPrivKeyB64 !== undefined;
  const claimKey = c.claimKey !== undefined;
  const polar = c.polarAccessToken !== undefined || c.polarProducts.size > 0;
  const apple = c.appleBundleId !== undefined || c.appleProducts.size > 0;
  // The sync server treats a version 1 token with more than 8 days left as an
  // old, reusable one (§Sync-server rules → Create), so a longer deadline
  // would void "one token per checkout".
  if (c.entitlementDays > 7) problems.push("SITR_ENTITLEMENT_DAYS must be at most 7");
  if (keys !== claimKey) problems.push("SITR_ENTITLEMENT_PRIVKEY and SITR_CLAIM_KEY must be set together");
  if ((polar || apple) && !(keys && claimKey)) {
    problems.push("a billing source is configured but SITR_ENTITLEMENT_PRIVKEY and SITR_CLAIM_KEY are not");
  }
  if (polar && (c.polarAccessToken === undefined || c.polarProducts.size === 0)) {
    problems.push("SITR_POLAR_TOKEN and SITR_POLAR_PRODUCTS must be set together");
  }
  if (apple && (c.appleBundleId === undefined || c.appleProducts.size === 0)) {
    problems.push("SITR_APPLE_BUNDLE_ID and SITR_APPLE_PRODUCTS must be set together");
  }
  if (c.appleSandbox && !apple) problems.push("SITR_APPLE_SANDBOX needs SITR_APPLE_BUNDLE_ID and SITR_APPLE_PRODUCTS");
  if (problems.length > 0) throw new Error(problems.join("; "));
}
