/**
 * Sync client — pull → merge → push against the one documented endpoint
 * (docs/data-flow.md, docs/sync-protocol.md).
 *
 * THIS FILE IS THE REPOSITORY'S ONLY `fetch(` CALL SITE. data-flow.md
 * invites auditors to verify that claim by grep — keep it true.
 *
 * INVARIANT (CLAUDE.md §4): sync outcomes touch ONLY the sync status and
 * household state. They never touch `protectionStatus` or the badge —
 * filtering is local, so a dead server leaves protection fully intact.
 *
 * Rollback detection: we remember the highest household rev ever decrypted
 * (`maxSeenRev`). An authenticated blob with a lower rev is an error
 * ("server returned an older state"), surfaced but never applied.
 */
import { type Result, err, ok } from "../result.js";
import {
  bumpRev,
  mergeStates,
  type HouseholdState,
} from "../household.js";
import {
  deriveKeys,
  openState,
  sealState,
  type HouseholdKeys,
} from "./crypto.js";
import { type SyncStatus } from "./status.js";

export const SYNC_BASE_URL = "https://sync.sitrshield.com";
export const MAX_SEEN_REV_KEY = "syncMaxSeenRev";

export interface SyncDeps {
  fetch: typeof fetch;
  now(): number;
  baseUrl?: string;
}

export interface SyncInput {
  rootSecret: Uint8Array;
  /** The locally applied state (may be ahead of the server's). */
  local: HouseholdState;
  /** Highest rev this device has ever decrypted from the server. */
  maxSeenRev: number;
  deviceId: string;
  /**
   * Signed subscription token (docs/sync-protocol.md §Entitlement). Sent
   * as a header; the server checks it only at household creation.
   */
  entitlement?: string | undefined;
}

export interface SyncOutcome {
  /** The state the caller must apply + persist (merge result). */
  state: HouseholdState;
  maxSeenRev: number;
  status: SyncStatus;
  /** ETag of the server copy after this sync (for diagnostics only). */
  etag: number | undefined;
}

interface Remote {
  state: HouseholdState | undefined;
  etag: number | undefined;
}

function parseEtagHeader(res: Response): number | undefined {
  const raw = res.headers.get("ETag");
  const m = raw === null ? null : /^"(\d{1,15})"$/.exec(raw);
  return m === null ? undefined : Number.parseInt(m[1]!, 10);
}

async function pull(
  keys: HouseholdKeys,
  deps: SyncDeps,
): Promise<Result<Remote, string>> {
  const base = deps.baseUrl ?? SYNC_BASE_URL;
  let res: Response;
  try {
    res = await deps.fetch(`${base}/v1/blob/${keys.householdId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${keys.authToken}` },
    });
  } catch {
    return err("offline");
  }
  if (res.status === 404) return ok({ state: undefined, etag: undefined });
  if (!res.ok) return err(`server responded ${res.status}`);
  const etag = parseEtagHeader(res);
  const blob = new Uint8Array(await res.arrayBuffer());
  const opened = await openState(blob, keys.encKey);
  if (!opened.ok) return err(opened.error);
  return ok({ state: opened.value, etag });
}

async function push(
  keys: HouseholdKeys,
  state: HouseholdState,
  etag: number | undefined,
  deps: SyncDeps,
  entitlement: string | undefined,
): Promise<Result<number, string | "conflict">> {
  const sealed = await sealState(state, keys.encKey);
  if (!sealed.ok) return sealed;
  const base = deps.baseUrl ?? SYNC_BASE_URL;
  let res: Response;
  try {
    res = await deps.fetch(`${base}/v1/blob/${keys.householdId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${keys.authToken}`,
        ...(etag === undefined
          ? { "If-None-Match": "*" }
          : { "If-Match": `"${etag}"` }),
        ...(entitlement !== undefined && entitlement !== ""
          ? { "X-Sitr-Entitlement": entitlement }
          : {}),
      },
      body: sealed.value as unknown as BodyInit,
    });
  } catch {
    return err("offline");
  }
  if (res.status === 409) return err("conflict");
  if (!res.ok) return err(`server responded ${res.status}`);
  return ok(parseEtagHeader(res) ?? 0);
}

/**
 * One full sync round. Never throws. The returned state is always safe to
 * apply: merged, sanitized (via openState), and rollback-checked.
 */
export async function syncOnce(
  input: SyncInput,
  deps: SyncDeps,
): Promise<SyncOutcome> {
  const failed = (error: string, state: SyncStatus["state"] = "error"): SyncOutcome => ({
    state: input.local,
    maxSeenRev: input.maxSeenRev,
    status: { state, error },
    etag: undefined,
  });

  const keys = await deriveKeys(input.rootSecret);
  if (!keys.ok) return failed(keys.error);

  const attempt = async (): Promise<Result<SyncOutcome, string | "retry">> => {
    const remote = await pull(keys.value, deps);
    if (!remote.ok) {
      return err(remote.error);
    }
    let merged = input.local;
    let maxSeen = input.maxSeenRev;
    if (remote.value.state !== undefined) {
      if (remote.value.state.rev < input.maxSeenRev) {
        return err(
          "server returned an older household state than previously seen — refusing to apply it",
        );
      }
      maxSeen = Math.max(maxSeen, remote.value.state.rev);
      merged = mergeStates(input.local, remote.value.state);
    }
    // Push only when the server copy differs from the merge result.
    const serverRev = remote.value.state?.rev;
    if (serverRev === merged.rev && remote.value.state === merged) {
      return ok({
        state: merged,
        maxSeenRev: Math.max(maxSeen, merged.rev),
        status: { state: "ok", lastSuccessAt: deps.now() },
        etag: remote.value.etag,
      });
    }
    const toPush =
      serverRev !== undefined && serverRev >= merged.rev && remote.value.state !== merged
        ? bumpRev(merged, input.deviceId, deps.now())
        : merged;
    const pushed = await push(
      keys.value,
      toPush,
      remote.value.etag,
      deps,
      input.entitlement,
    );
    if (!pushed.ok) {
      return pushed.error === "conflict" ? err("retry") : err(pushed.error);
    }
    return ok({
      state: toPush,
      maxSeenRev: Math.max(maxSeen, toPush.rev),
      status: { state: "ok", lastSuccessAt: deps.now() },
      etag: pushed.value,
    });
  };

  const first = await attempt();
  if (first.ok) return first.value;
  if (first.error === "retry") {
    // One concurrent-write retry: re-pull, re-merge, re-push.
    const second = await attempt();
    if (second.ok) return second.value;
    return failed(
      second.error === "retry" ? "repeated version conflicts" : second.error,
      second.error === "offline" ? "offline" : "error",
    );
  }
  return failed(first.error, first.error === "offline" ? "offline" : "error");
}
