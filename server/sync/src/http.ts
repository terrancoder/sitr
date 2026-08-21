/**
 * Request handling — pure-ish: takes a parsed request, returns a response
 * description. node:http wiring lives in server.ts. No request logging of
 * any kind (docs/sync-protocol.md).
 */
import { createHash } from "node:crypto";
import type { Config } from "./config.js";
import { SyncStore } from "./store.js";
import { WindowCounter, hashIp } from "./ratelimit.js";
import { EntitlementChecker } from "./entitlement.js";

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

export function text(status: number, message: string): SyncResponse {
  return {
    status,
    headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" },
    body: new TextEncoder().encode(message + "\n"),
  };
}

const ID_RE = /^\/v1\/blob\/([0-9a-f]{32})$/;
const AUTH_RE = /^Bearer ([0-9a-f]{64})$/;

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

  handle(req: SyncRequest): SyncResponse {
    const idMatch = ID_RE.exec(req.path);
    if (idMatch === null) return text(404, "not found");
    const id = idMatch[1]!;

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
        // Entitlement is checked at household creation only — an expiring
        // subscription never cuts off an existing household mid-flight.
        if (isCreateIntent) {
          const entitled = this.entitlement.check(
            req.headers["x-sitr-entitlement"],
            this.now(),
          );
          if (entitled.kind === "denied") return text(402, entitled.reason);
        }
        if (isCreateIntent && !this.creates.allow(hashIp(req.ip), now)) {
          return text(429, "too many new households from this address");
        }
        const r = this.store.put(id, authHash, req.body, ifMatch, now);
        switch (r.kind) {
          case "unauthorized":
            return text(401, "wrong credential");
          case "conflict":
            return {
              ...text(409, "version conflict — re-pull, merge, retry"),
              headers: {
                ...NO_STORE,
                "Content-Type": "text/plain; charset=utf-8",
                ETag: `"${r.etag}"`,
              },
            };
          case "ok":
            return {
              status: r.created ? 201 : 200,
              headers: { ...NO_STORE, ETag: `"${r.etag}"` },
              body: EMPTY,
            };
        }
        break;
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
