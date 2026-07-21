/**
 * In-memory abuse control. Deliberately forgetful:
 *  - the create limiter keys on SHA-256(ip) and is CLEARED EVERY HOUR —
 *    the server never persists IP-derived data (docs/sync-protocol.md);
 *  - the per-id request limiter is a fixed-window counter per minute.
 */
import { createHash } from "node:crypto";

export class WindowCounter {
  private windowStart = 0;
  private counts = new Map<string, number>();

  constructor(
    private readonly windowMs: number,
    private readonly limit: number,
  ) {}

  /** Returns true when the caller is within limits (and counts the hit). */
  allow(key: string, now: number): boolean {
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.counts = new Map();
    }
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return n <= this.limit;
  }
}

export function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex");
}
