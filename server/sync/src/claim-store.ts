/**
 * The claim service's own database (SITR_CLAIM_DB), opened only by the
 * claim process; it shares no table, file or key with the sync database.
 * docs/sync-protocol.md §Stored data: markers (keyed hashes of
 * subscription IDs) with their binder, last period end and rebind day;
 * revoked_transactions (keyed hashes of refunded Apple transaction IDs, with
 * that transaction's expiresDate); v1_claims until the cut-over. No token,
 * jti, claim secret, subscription ID, transaction ID, checkout ID, product,
 * name, email or IP address.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { DAY } from "./entitlement.js";
import { transaction } from "./store.js";

export interface MarkerRow {
  binder: Uint8Array | null;
  last_period_end: number | null;
  replaced_day: number | null;
}

export class ClaimStore {
  readonly db: DatabaseSync;
  /** Every statement, prepared once (several run inside the binding lock). */
  private readonly q: Record<
    | "marker" | "bind" | "setLastPeriodEnd" | "revoke" | "unrevoke" | "isRevoked"
    | "v1Claim" | "addV1Claim" | "pruneMarkers" | "pruneRevoked",
    StatementSync
  >;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS markers (
        marker          BLOB    PRIMARY KEY,
        binder          BLOB,
        last_period_end INTEGER,
        replaced_day    INTEGER
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS revoked_transactions (
        tx_hash BLOB    PRIMARY KEY,
        exp     INTEGER NOT NULL
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS v1_claims (
        checkout_hash BLOB    PRIMARY KEY,
        exp           INTEGER NOT NULL
      ) STRICT, WITHOUT ROWID;
    `);
    const p = (sql: string) => this.db.prepare(sql);
    this.q = {
      marker: p("SELECT binder, last_period_end, replaced_day FROM markers WHERE marker = ?"),
      bind: p(
        `INSERT INTO markers (marker, binder, last_period_end, replaced_day) VALUES (?, ?, ?, ?)
         ON CONFLICT (marker) DO UPDATE SET binder = excluded.binder,
           last_period_end = excluded.last_period_end, replaced_day = excluded.replaced_day`,
      ),
      setLastPeriodEnd: p("UPDATE markers SET last_period_end = ? WHERE marker = ?"),
      revoke: p(
        `INSERT INTO revoked_transactions (tx_hash, exp) VALUES (?, ?)
         ON CONFLICT (tx_hash) DO UPDATE SET exp = max(exp, excluded.exp)`,
      ),
      unrevoke: p("DELETE FROM revoked_transactions WHERE tx_hash = ?"),
      isRevoked: p("SELECT 1 FROM revoked_transactions WHERE tx_hash = ?"),
      v1Claim: p("SELECT exp FROM v1_claims WHERE checkout_hash = ?"),
      addV1Claim: p("INSERT INTO v1_claims (checkout_hash, exp) VALUES (?, ?)"),
      pruneMarkers: p(
        `DELETE FROM markers WHERE
           (binder IS NULL OR last_period_end IS NULL OR last_period_end + ? <= ?)
           AND (replaced_day IS NULL OR replaced_day + ? <= ?)`,
      ),
      pruneRevoked: p("DELETE FROM revoked_transactions WHERE exp <= ?"),
    };
  }

  tx<T>(fn: () => T): T {
    return transaction(this.db, fn);
  }

  marker(marker: Uint8Array): MarkerRow | undefined {
    const row = this.q.marker.get(marker) as unknown as MarkerRow | undefined;
    return row && { ...row, binder: row.binder === null ? null : new Uint8Array(row.binder) };
  }

  /** Writes the binding columns. */
  bind(marker: Uint8Array, binder: Uint8Array, lastPeriodEnd: number, replacedDay: number | null): void {
    this.q.bind.run(marker, binder, lastPeriodEnd, replacedDay);
  }

  setLastPeriodEnd(marker: Uint8Array, lastPeriodEnd: number): void {
    this.q.setLastPeriodEnd.run(lastPeriodEnd, marker);
  }

  /** REFUND / REVOKE of one transaction; `exp` is its expiresDate. */
  revoke(txHash: Uint8Array, exp: number): void {
    this.q.revoke.run(txHash, exp);
  }

  /** REFUND_REVERSED of that one transaction. */
  unrevoke(txHash: Uint8Array): void {
    this.q.unrevoke.run(txHash);
  }

  isRevoked(txHash: Uint8Array): boolean {
    return this.q.isRevoked.get(txHash) !== undefined;
  }

  v1Claim(checkoutHash: Uint8Array): number | undefined {
    return (this.q.v1Claim.get(checkoutHash) as { exp: number } | undefined)?.exp;
  }

  addV1Claim(checkoutHash: Uint8Array, exp: number): void {
    this.q.addV1Claim.run(checkoutHash, exp);
  }

  /**
   * Hourly: drop a marker once its binding is absent or stale and its last
   * rebind is at least `replacementDays` ago; drop a revoked transaction once
   * its expiresDate has passed (its receipt is then refused as inactive).
   * Returns marker rows removed.
   */
  prune(now: number, replacementDays: number): number {
    const r = this.q.pruneMarkers.run(3 * DAY, now, replacementDays, Math.floor(now / DAY));
    this.q.pruneRevoked.run(now);
    return Number(r.changes);
  }

  close(): void {
    this.db.close();
  }
}
