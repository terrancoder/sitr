/**
 * Client-IP derivation — pure and unit-tested.
 *
 * Behind a reverse proxy every socket shares the proxy's address, which
 * would silently collapse the per-IP create limits into one global bucket.
 * With SITR_TRUSTED_PROXY set, the LAST X-Forwarded-For entry — the one
 * appended by our own proxy, the only trustworthy hop — is used instead.
 * Without the flag the header is ignored entirely, so a direct client
 * cannot spoof its way out of a rate limit. The result is only ever
 * hashed in memory (ratelimit.ts); nothing IP-derived is persisted.
 */
export function clientIp(
  remoteAddress: string | undefined,
  xForwardedFor: string | string[] | undefined,
  trustedProxy: boolean,
): string {
  if (trustedProxy) {
    const joined = Array.isArray(xForwardedFor)
      ? xForwardedFor.join(",")
      : (xForwardedFor ?? "");
    const entries = joined
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const last = entries[entries.length - 1];
    if (last !== undefined) return last;
  }
  return remoteAddress ?? "unknown";
}
