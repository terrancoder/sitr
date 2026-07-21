/** Server configuration — environment-driven, defaults safe for local dev. */

export interface Config {
  port: number;
  /** SQLite path; ":memory:" for tests. */
  dbPath: string;
  maxBlobBytes: number;
  /** New-household creations allowed per client IP per hour. */
  createsPerIpPerHour: number;
  /** Requests allowed per household id per minute. */
  requestsPerIdPerMinute: number;
  /** Blobs idle longer than this are deleted by GC. */
  idleExpiryMs: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv): Config {
  const int = (v: string | undefined, dflt: number): number => {
    const n = v === undefined ? NaN : Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  return {
    port: int(env["SITR_SYNC_PORT"], 8787),
    dbPath: env["SITR_SYNC_DB"] ?? "sitr-sync.sqlite",
    maxBlobBytes: 64 * 1024,
    createsPerIpPerHour: int(env["SITR_SYNC_CREATES_PER_IP_HOUR"], 20),
    requestsPerIdPerMinute: int(env["SITR_SYNC_REQS_PER_ID_MIN"], 60),
    idleExpiryMs: 18 * 30 * 24 * 60 * 60 * 1000, // ~18 months
  };
}
