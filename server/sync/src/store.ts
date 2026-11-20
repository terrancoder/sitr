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
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { timingSafeEqual } from "node:crypto";
import { DAY } from "./entitlement.js";

/** Runs `fn` in one BEGIN IMMEDIATE transaction; any throw rolls back. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export type GetOutcome =
  | { kind: "ok"; blob: Uint8Array; etag: number; entExp: number | null }
  | { kind: "not-found" }
  | { kind: "unauthorized" };

export type DeleteOutcome = { kind: "ok" } | { kind: "unauthorized" };

export type LookupOutcome =
  | { kind: "ok"; etag: number; entExp: number | null; test: boolean }
  | { kind: "not-found" }
  | { kind: "unauthorized" };

/** Entitlement changes a PUT commits together with the blob write. */
export interface PutEntitlement {
  /** New `ent_exp`; undefined leaves it as it is. */
  entExp?: number | null;
  /** Create only. */
  testDeleteDay?: number | null;
  /** A `used_tokens` row to insert. */
  used?: { hash: Uint8Array; exp: number } | undefined;
}

interface Row {
  auth_hash: Uint8Array;
  blob?: Uint8Array;
  write_counter: number;
  last_write_day: number;
  ent_exp: number | null;
  test_delete_day: number | null;
}

export class SyncStore {
  private readonly db: DatabaseSync;
  /** Statements of the request path, prepared once. */
  private readonly q: Record<"meta" | "full" | "isUsed" | "markUsed" | "insert" | "update", StatementSync>;

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
      CREATE TABLE IF NOT EXISTS used_tokens (
        token_hash BLOB    PRIMARY KEY,
        exp        INTEGER NOT NULL
      ) STRICT, WITHOUT ROWID;
    `);
    // Version 2 migration (docs/sync-protocol.md §Stored data): existing rows
    // become legacy households (ent_exp NULL). Safe to run on every start.
    const cols = (
      this.db.prepare("PRAGMA table_info(blobs)").all() as unknown as { name: string }[]
    ).map((c) => c.name);
    for (const col of ["ent_exp", "test_delete_day"]) {
      if (!cols.includes(col)) this.db.exec(`ALTER TABLE blobs ADD COLUMN ${col} INTEGER`);
    }
    const meta = "auth_hash, write_counter, last_write_day, ent_exp, test_delete_day";
    this.q = {
      meta: this.db.prepare(`SELECT ${meta} FROM blobs WHERE id = ?`),
      full: this.db.prepare(`SELECT blob, ${meta} FROM blobs WHERE id = ?`),
      isUsed: this.db.prepare("SELECT 1 FROM used_tokens WHERE token_hash = ?"),
      markUsed: this.db.prepare("INSERT INTO used_tokens (token_hash, exp) VALUES (?, ?)"),
      insert: this.db.prepare(
        "INSERT INTO blobs (id, auth_hash, blob, write_counter, last_write_day, ent_exp, test_delete_day) VALUES (?, ?, ?, 1, ?, ?, ?)",
      ),
      update: this.db.prepare(
        "UPDATE blobs SET blob = ?, write_counter = ?, last_write_day = ?, ent_exp = ? WHERE id = ? AND write_counter = ?",
      ),
    };
  }

  /** Runs `fn` in one BEGIN IMMEDIATE transaction (the handler's PUT). */
  tx<T>(fn: () => T): T {
    return transaction(this.db, fn);
  }

  private markUsed(used: PutEntitlement["used"]): void {
    if (used !== undefined) this.q.markUsed.run(used.hash, used.exp);
  }

  isUsed(hash: Uint8Array): boolean {
    return this.q.isUsed.get(hash) !== undefined;
  }

  lookup(id: string, authHash: Uint8Array): LookupOutcome {
    const row = this.row(id);
    if (row === undefined) return { kind: "not-found" };
    if (!this.authorized(row, authHash)) return { kind: "unauthorized" };
    return {
      kind: "ok",
      etag: row.write_counter,
      entExp: row.ent_exp,
      test: row.test_delete_day !== null,
    };
  }

  /** The row's metadata; the blob itself only when `withBlob`. */
  private row(id: string, withBlob = false): Row | undefined {
    return (withBlob ? this.q.full : this.q.meta).get(id) as unknown as Row | undefined;
  }

  private authorized(row: Row, authHash: Uint8Array): boolean {
    const stored = new Uint8Array(row.auth_hash);
    return (
      stored.length === authHash.length && timingSafeEqual(stored, authHash)
    );
  }

  get(id: string, authHash: Uint8Array): GetOutcome {
    const row = this.row(id, true);
    if (row === undefined) return { kind: "not-found" };
    if (!this.authorized(row, authHash)) return { kind: "unauthorized" };
    return {
      kind: "ok",
      blob: new Uint8Array(row.blob!),
      etag: row.write_counter,
      entExp: row.ent_exp,
    };
  }

  /**
   * Writes a PUT the handler has already decided on, inside the handler's
   * tx(): `current` is the row it looked up and authorised (an update whose
   * ETag matched), or null to create. Returns the new ETag.
   */
  put(
    id: string,
    authHash: Uint8Array,
    blob: Uint8Array,
    current: { etag: number; entExp: number | null } | null,
    now: number,
    ent: PutEntitlement = {},
  ): number {
    const day = Math.floor(now / DAY);
    this.markUsed(ent.used);
    if (current === null) {
      this.q.insert.run(id, authHash, blob, day, ent.entExp ?? null, ent.testDeleteDay ?? null);
      return 1;
    }
    const next = current.etag + 1;
    const r = this.q.update.run(blob, next, day, ent.entExp === undefined ? current.entExp : ent.entExp, id, current.etag);
    if (Number(r.changes) !== 1) throw new Error("the row changed inside its own transaction");
    return next;
  }

  delete(id: string, authHash: Uint8Array): DeleteOutcome {
    const row = this.row(id);
    if (row === undefined) return { kind: "ok" }; // idempotent
    if (!this.authorized(row, authHash)) return { kind: "unauthorized" };
    this.db.prepare("DELETE FROM blobs WHERE id = ?").run(id);
    return { kind: "ok" };
  }

  /**
   * Delete blobs idle longer than `idleExpiryMs` and test households past
   * their `test_delete_day`; prune expired `used_tokens`. Returns blob rows
   * removed.
   */
  gc(now: number, idleExpiryMs: number): number {
    const cutoffDay = Math.floor((now - idleExpiryMs) / DAY);
    const r = this.db
      .prepare("DELETE FROM blobs WHERE last_write_day < ? OR test_delete_day < ?")
      .run(cutoffDay, Math.floor(now / DAY));
    this.db.prepare("DELETE FROM used_tokens WHERE exp < ?").run(now);
    return Number(r.changes);
  }

  close(): void {
    this.db.close();
  }
}
