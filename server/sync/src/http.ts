/**
 * Request handling — pure-ish: takes a parsed request, returns a response
 * description. nodeListener below is the node:http wiring both processes
 * use. No request logging of any kind (docs/sync-protocol.md).
 */
import { createHash } from "node:crypto";
import type { Config } from "./config.js";
import { SyncStore, type LookupOutcome, type PutEntitlement } from "./store.js";
import { WindowCounter, hashIp } from "./ratelimit.js";
import { DAY, EntitlementChecker } from "./entitlement.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { clientIp } from "./net.js";

export interface SyncRequest {
  method: string;
  path: string;
  ip: string;
  headers: Record<string, string | undefined>;
  body: Uint8Array;
}

export interface SyncResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export const NO_STORE = { "Cache-Control": "no-store" };
export const EMPTY = new Uint8Array(0);

/**
 * CORS on every sync response, so a browser extension can call this host
 * from a context where its host permission does not lift CORS (Safari's
 * service worker; docs/sync-protocol.md §CORS). Any origin, never
 * credentials: the household bearer travels in Authorization, not in a
 * cookie, so a page gains nothing it could not do without a browser.
 * Safari extension origins are per-install IDs and cannot be listed.
 */
export const SYNC_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, If-Match, If-None-Match, X-Sitr-Entitlement, Content-Type",
  "Access-Control-Expose-Headers": "ETag, X-Sitr-Entitlement-Expires",
  "Access-Control-Max-Age": "600",
};

/** Parses `text` as a JSON object (not an array); null for anything else. */
export function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function text(status: number, message: string): SyncResponse {
  return {
    status,
    headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" },
    body: new TextEncoder().encode(message + "\n"),
  };
}

const ID_RE = /^\/v1\/blob\/([0-9a-f]{32})$/;
const AUTH_RE = /^Bearer ([0-9a-f]{64})$/;

const sha256 = (b: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(b).digest());

function parseEtag(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const m = /^"(\d{1,15})"$/.exec(raw.trim());
  if (m === null) return null;
  return Number.parseInt(m[1]!, 10);
}

export class SyncHandler {
  private readonly perId: WindowCounter;
  private readonly creates: WindowCounter;
  private readonly entitlement: EntitlementChecker;

  constructor(
    private readonly store: SyncStore,
    private readonly config: Config,
    private readonly now: () => number = Date.now,
  ) {
    this.perId = new WindowCounter(60_000, config.requestsPerIdPerMinute);
    this.creates = new WindowCounter(3_600_000, config.createsPerIpPerHour);
    this.entitlement = new EntitlementChecker(config.entitlementPubKeyB64);
  }

  /** Effective end E (§Sync-server rules); undefined = no end. */
  private end(entExp: number | null): number | undefined {
    return entExp ?? this.config.v1CutoverMs;
  }

  private expiresHeader(end: number | undefined): Record<string, string> {
    return this.entitlement.enforcing && end !== undefined
      ? { "X-Sitr-Entitlement-Expires": String(end) }
      : {};
  }

  /** Create rules: what to store, or the 402 reason (first failed check). */
  private admit(header: string | undefined, now: number): PutEntitlement | string {
    const r = this.entitlement.verify(header);
    if (!r.ok) return r.reason;
    const t = r.token;
    if (t.payload.exp <= now) return "token-expired";
    if (t.v === 2) {
      if (t.payload.plan !== "family") return "plan-not-accepted";
      const hash = sha256(Buffer.from(t.payload.jti, "base64url"));
      if (this.store.isUsed(hash)) return "token-used";
      return {
        entExp: t.payload.exp,
        testDeleteDay: t.payload.test ? Math.floor(now / DAY) + 7 : null,
        used: { hash, exp: t.payload.exp },
      };
    }
    // Version 1: a token within 8 days of its exp was minted after the
    // version 2 deployment (7-day redeem deadline) and is single-use; older
    // ones are accepted as before, until the cut-over (§Sync-server rules → Create).
    let used: PutEntitlement["used"];
    if (t.payload.exp - now <= 8 * DAY) {
      const hash = sha256(t.payloadBytes);
      if (this.store.isUsed(hash)) return "token-used";
      used = { hash, exp: t.payload.exp };
    }
    const cut = this.config.v1CutoverMs;
    if (cut !== undefined && now >= cut) return "v1-ended";
    return { entExp: null, used };
  }

  /** Update step 2: the change a usable, matching token applies, if any. */
  private renew(
    row: Extract<LookupOutcome, { kind: "ok" }>,
    header: string | undefined,
    now: number,
  ): PutEntitlement {
    const r = this.entitlement.verify(header);
    if (!r.ok || r.token.v !== 2) return {};
    const p = r.token.payload;
    const end = this.end(row.entExp);
    const lapsed = end !== undefined && end <= now;
    if (p.exp <= now || p.plan !== "family" || (p.test === true) !== row.test) return {};
    // An early token cannot reopen a lapsed household (§Sync-server rules).
    if (now < p.per && lapsed) return {};
    const hash = sha256(Buffer.from(p.jti, "base64url"));
    if (this.store.isUsed(hash)) return {};
    return {
      entExp: row.entExp === null ? p.exp : Math.max(row.entExp, p.exp),
      used: { hash, exp: p.exp },
    };
  }

  handle(req: SyncRequest): SyncResponse {
    const idMatch = ID_RE.exec(req.path);
    if (idMatch === null) return text(404, "not found");
    const id = idMatch[1]!;
    // A CORS preflight carries no Authorization: answered before the auth
    // check and the rate limit (the headers are added by syncListener).
    if (req.method === "OPTIONS") return { status: 204, headers: { ...NO_STORE }, body: EMPTY };

    const authMatch = AUTH_RE.exec(req.headers["authorization"] ?? "");
    if (authMatch === null) return text(401, "missing or malformed bearer token");
    const authHash = new Uint8Array(
      createHash("sha256").update(Buffer.from(authMatch[1]!, "hex")).digest(),
    );

    const now = this.now();
    if (!this.perId.allow(id, now)) return text(429, "slow down");

    switch (req.method) {
      case "GET": {
        const r = this.store.get(id, authHash);
        switch (r.kind) {
          case "not-found":
            return text(404, "no blob");
          case "unauthorized":
            return text(401, "wrong credential");
          case "ok":
            return {
              status: 200,
              headers: {
                ...NO_STORE,
                "Content-Type": "application/octet-stream",
                ETag: `"${r.etag}"`,
                ...this.expiresHeader(this.end(r.entExp)),
              },
              body: r.blob,
            };
        }
        break;
      }
      case "PUT": {
        if (req.body.length === 0) return text(400, "empty body");
        if (req.body.length > this.config.maxBlobBytes) {
          return text(413, `blob exceeds ${this.config.maxBlobBytes} bytes`);
        }
        const ifMatch = parseEtag(req.headers["if-match"]);
        const isCreateIntent = req.headers["if-none-match"]?.trim() === "*";
        if (ifMatch === null && !isCreateIntent) {
          return text(428, 'send If-Match: "<etag>" or If-None-Match: * to create');
        }
        const conflict = (etag: number): SyncResponse => ({
          ...text(409, "version conflict — re-pull, merge, retry"),
          headers: {
            ...NO_STORE,
            "Content-Type": "text/plain; charset=utf-8",
            ETag: `"${etag}"`,
          },
        });
        const header = req.headers["x-sitr-entitlement"];
        const enforcing = this.entitlement.enforcing;
        const done = (status: number, etag: number, end: number | undefined): SyncResponse => ({
          status,
          headers: { ...NO_STORE, ETag: `"${etag}"`, ...this.expiresHeader(end) },
          body: EMPTY,
        });
        // The row lookup, the rules and the write run in one transaction.
        return this.store.tx(() => {
          const found = this.store.lookup(id, authHash);
          if (found.kind === "unauthorized") return text(401, "wrong credential");
          if (found.kind === "ok") {
            // If-None-Match: * on an existing row (a retried creation whose
            // 201 was lost): 409 with the ETag; the token is not checked or
            // burned and the create limit is not charged.
            if (ifMatch === null) return conflict(found.etag);
            let ent: PutEntitlement = {};
            let end: number | undefined;
            if (enforcing) {
              ent = this.renew(found, header, now);
              end = this.end(ent.entExp ?? found.entExp);
              if (end !== undefined && end <= now) {
                const r = text(402, "lapsed");
                return { ...r, headers: { ...r.headers, ...this.expiresHeader(end) } };
              }
            }
            if (ifMatch !== found.etag) return conflict(found.etag);
            return done(200, this.store.put(id, authHash, req.body, found, now, ent), end);
          }
          // No row: the creation rules apply to any PUT that creates one,
          // whichever precondition it carries; only a creation is charged to
          // the per-IP create limit, after the token check.
          let ent: PutEntitlement = {};
          let end: number | undefined;
          if (enforcing) {
            const admitted = this.admit(header, now);
            if (typeof admitted === "string") return text(402, admitted);
            ent = admitted;
            end = this.end(ent.entExp ?? null);
          }
          if (!this.creates.allow(hashIp(req.ip), now)) {
            return text(429, "too many new households from this address");
          }
          return done(201, this.store.put(id, authHash, req.body, null, now, ent), end);
        });
      }
      case "DELETE": {
        const r = this.store.delete(id, authHash);
        return r.kind === "ok"
          ? { status: 204, headers: { ...NO_STORE }, body: EMPTY }
          : text(401, "wrong credential");
      }
      default:
        return text(405, "method not allowed");
    }
  }
}

/**
 * Runs `fn` (the hourly clean-up); an exception is logged by its kind only
 * and never stops the process.
 */
export function guarded(name: string, what: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.error(`${name}: ${what} failed (${e instanceof Error ? e.name : typeof e})`);
  }
}

/**
 * node:http wiring shared by both processes: collects the body up to
 * `maxBody` bytes (413 beyond), passes on only `headerNames`, and answers
 * 500 when the handler throws, with one log line that holds no request data.
 * `always` is added to every response, these two included.
 */
export function nodeListener(
  name: string,
  maxBody: number,
  trustedProxy: boolean,
  headerNames: readonly string[],
  handle: (req: SyncRequest) => SyncResponse | Promise<SyncResponse>,
  always: Record<string, string> = {},
) {
  // A response that cannot be written (the client went away, a bad header)
  // is logged by its kind only; it never stops the process.
  const writeError = (e: unknown): void =>
    console.error(`${name}: response write failed (${e instanceof Error ? e.name : typeof e})`);
  const write = (res: ServerResponse, status: number, headers: Record<string, string>, body?: Buffer): void => {
    try {
      if (!res.headersSent) res.writeHead(status, { ...headers, ...always });
      res.end(body);
    } catch (e) {
      writeError(e);
      res.destroy();
    }
  };
  return (req: IncomingMessage, res: ServerResponse): void => {
    req.on("error", () => {}); // an aborted upload; nothing to answer
    res.on("error", writeError);
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBody) {
        write(res, 413, NO_STORE);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      const headers: Record<string, string | undefined> = {};
      for (const h of headerNames) {
        const v = req.headers[h];
        headers[h] = Array.isArray(v) ? v[0] : v;
      }
      const request: SyncRequest = {
        method: req.method ?? "GET",
        path: req.url ?? "/",
        ip: clientIp(req.socket.remoteAddress, req.headers["x-forwarded-for"], trustedProxy),
        headers,
        body: new Uint8Array(Buffer.concat(chunks)),
      };
      const fail = (e: unknown): void => {
        console.error(`${name}: internal error (${e instanceof Error ? e.name : typeof e})`);
        write(res, 500, NO_STORE);
      };
      let pending: Promise<SyncResponse>;
      try {
        pending = Promise.resolve(handle(request));
      } catch (e) {
        fail(e);
        return;
      }
      pending.then((response) => write(res, response.status, response.headers, Buffer.from(response.body)), fail);
    });
  };
}

/** node:http wiring for the sync process (server.ts, tests). */
export const syncListener = (handler: SyncHandler, config: Config) =>
  nodeListener(
    "sitr-sync",
    config.maxBlobBytes + 1024,
    config.trustedProxy,
    ["authorization", "if-match", "if-none-match", "x-sitr-entitlement"],
    (r) => handler.handle(r),
    SYNC_CORS,
  );
