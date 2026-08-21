/**
 * Blob store — node:sqlite, one STRICT table, no logs.
 *
 * Privacy is enforced structurally here:
 *  - the auth credential is stored only as its SHA-256 (a DB leak yields
 *    no usable bearer tokens);
 *  - the last-write timestamp is rounded to the DAY, so the database
 *    cannot reconstruct a household's activity pattern;
 *  - blobs are opaque ciphertext (see docs/sync-protocol.md).
 *
 * The write counter backs the ETag / If-Match optimistic concurrency and
 * is unrelated to the household `rev` inside the encrypted blob.
 */
import { DatabaseSync } from "node:sqlite";
import { timingSafeEqual } from "node:crypto";

export type GetOutcome =
  | { kind: "ok"; blob: Uint8Array; etag: number }
  | { kind: "not-found" }
  | { kind: "unauthorized" };

export type PutOutcome =
  | { kind: "ok"; etag: number; created: boolean }
  | { kind: "conflict"; etag: number }
  | { kind: "unauthorized" };

export type DeleteOutcome = { kind: "ok" } | { kind: "unauthorized" };

const DAY_MS = 24 * 60 * 60 * 1000;

interface Row {
  auth_hash: Uint8Array;
  blob: Uint8Array;
  write_counter: number;
  last_write_day: number;
}

export class SyncStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    // WAL keeps readers unblocked during writes; the busy timeout rides out
    // the rare write collision instead of surfacing SQLITE_BUSY. Both are
    // no-ops for ":memory:" test databases. Single-instance remains a
    // deployment invariant (README) — WAL is not a green light for replicas.
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blobs (
        id             TEXT    PRIMARY KEY,
        auth_hash      BLOB    NOT NULL,
        blob           BLOB    NOT NULL,
        write_counter  INTEGER NOT NULL,
        last_write_day INTEGER NOT NULL
      ) STRICT;
    `);
  }

  private row(id: string): Row | undefined {
    const got = this.db
      .prepare(
        "SELECT auth_hash, blob, write_counter, last_write_day FROM blobs WHERE id = ?",
      )
      .get(id) as unknown as Row | undefined;
    return got;
  }

  private authorized(row: Row, authHash: Uint8Array): boolean {
    const stored = new Uint8Array(row.auth_hash);
    return (
      stored.length === authHash.length && timingSafeEqual(stored, authHash)
    );
  }

  get(id: string, authHash: Uint8Array): GetOutcome {
    const row = this.row(id);
    if (row === undefined) return { kind: "not-found" };
    if (!this.authorized(row, authHash)) return { kind: "unauthorized" };
    return {
      kind: "ok",
      blob: new Uint8Array(row.blob),
      etag: row.write_counter,
    };
  }

  /**
   * First PUT for an id creates the row and binds the auth hash. Later
   * PUTs require the same auth hash AND `ifMatch` equal to the current
   * write counter (optimistic concurrency; null ifMatch on create only).
   */
  put(
    id: string,
    authHash: Uint8Array,
    blob: Uint8Array,
    ifMatch: number | null,
    now: number,
  ): PutOutcome {
    const day = Math.floor(now / DAY_MS);
    const row = this.row(id);
    if (row === undefined) {
      this.db
        .prepare(
          "INSERT INTO blobs (id, auth_hash, blob, write_counter, last_write_day) VALUES (?, ?, ?, 1, ?)",
        )
        .run(id, authHash, blob, day);
      return { kind: "ok", etag: 1, created: true };
    }
    if (!this.authorized(row, authHash)) return { kind: "unauthorized" };
    if (ifMatch === null || ifMatch !== row.write_counter) {
      return { kind: "conflict", etag: row.write_counter };
    }
    const next = row.write_counter + 1;
    this.db
      .prepare(
        "UPDATE blobs SET blob = ?, write_counter = ?, last_write_day = ? WHERE id = ? AND write_counter = ?",
      )
      .run(blob, next, day, id, row.write_counter);
    return { kind: "ok", etag: next, created: false };
  }

  delete(id: string, authHash: Uint8Array): DeleteOutcome {
    const row = this.row(id);
    if (row === undefined) return { kind: "ok" }; // idempotent
    if (!this.authorized(row, authHash)) return { kind: "unauthorized" };
    this.db.prepare("DELETE FROM blobs WHERE id = ?").run(id);
    return { kind: "ok" };
  }

  /** Delete blobs idle longer than `idleExpiryMs`. Returns rows removed. */
  gc(now: number, idleExpiryMs: number): number {
    const cutoffDay = Math.floor((now - idleExpiryMs) / DAY_MS);
    const r = this.db
      .prepare("DELETE FROM blobs WHERE last_write_day < ?")
      .run(cutoffDay);
    return Number(r.changes);
  }

  close(): void {
    this.db.close();
  }
}
