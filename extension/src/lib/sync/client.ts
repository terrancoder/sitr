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
  isJoinPlaceholder,
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
import { parseEndHeader, parseSyncRefusal, type SyncRefusal } from "../householdEnd.js";

export const SYNC_BASE_URL = "https://sync.sitrshield.com";
/** The second host, used only by the claim call (claimClient.ts). */
export const CLAIM_BASE_URL = "https://claim.sitrshield.com";
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
  /** Write even when nothing changed, so a new token reaches the server. */
  forceWrite?: boolean | undefined;
}

export interface SyncOutcome {
  /** The state the caller must apply + persist (merge result). */
  state: HouseholdState;
  maxSeenRev: number;
  status: SyncStatus;
  /** ETag of the server copy after this sync (for diagnostics only). */
  etag: number | undefined;
  /** X-Sitr-Entitlement-Expires of the round's last answer; null: none. */
  entExp: number | null;
  /** The reason of a 402 in this round; null: none. */
  refusal: SyncRefusal | null;
}

/** What the server said about the household's end in this round. */
interface Seen {
  entExp: number | null;
  refusal: SyncRefusal | null;
}

/** Reads the end header of a 2xx or 402 answer, and a 402's reason. */
async function observeAnswer(res: Response, seen: Seen): Promise<void> {
  if (!res.ok && res.status !== 402) return;
  const end = parseEndHeader(res.headers.get("X-Sitr-Entitlement-Expires"));
  if (end !== null) seen.entExp = end;
  if (res.status === 402) {
    let body = "";
    try {
      body = await res.text();
    } catch {
      // no body: the reason stays unknown
    }
    seen.refusal = parseSyncRefusal(402, body);
  }
}

/**
 * The low-level JSON POST for the claim call, kept here so this file stays
 * the only fetch call site. Sends no header but the content type. Null
 * when no answer came; `body` null when the answer could not be read.
 */
export async function postJson(
  f: typeof fetch,
  url: string,
  body: string,
): Promise<{ status: number; body: string | null } | null> {
  let res: Response;
  try {
    res = await f(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch {
    return null;
  }
  try {
    return { status: res.status, body: await res.text() };
  } catch {
    return { status: res.status, body: null };
  }
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
  seen: Seen,
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
  await observeAnswer(res, seen);
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
  seen: Seen,
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
  await observeAnswer(res, seen);
  if (res.status === 409) return err("conflict");
  if (!res.ok) return err(`server responded ${res.status}`);
  return ok(parseEtagHeader(res) ?? 0);
}

/**
 * At most one sync at a time: a request made while one runs is folded into
 * ONE follow-up run, never a parallel one and never dropped (a change saved
 * mid-sync, e.g. the PIN right after creating a household, otherwise waited
 * for the 30-minute alarm). Mirrors iOS CoalescedRefresh (TunnelNet.swift).
 * A run that throws ends the round; the alarm retries.
 */
export function coalesced(run: () => Promise<void>): () => Promise<void> {
  let running = false;
  let again = false;
  return async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await run();
      } while (again);
    } finally {
      running = false;
      again = false;
    }
  };
}

/**
 * One full sync round. Never throws. The returned state is always safe to
 * apply: merged, sanitized (via openState), and rollback-checked.
 */
export async function syncOnce(
  input: SyncInput,
  deps: SyncDeps,
): Promise<SyncOutcome> {
  const seen: Seen = { entExp: null, refusal: null };
  const failed = (error: string, state: SyncStatus["state"] = "error"): SyncOutcome => ({
    state: input.local,
    maxSeenRev: input.maxSeenRev,
    status: { state, error },
    etag: undefined,
    ...seen,
  });

  const keys = await deriveKeys(input.rootSecret);
  if (!keys.ok) return failed(keys.error);

  const attempt = async (): Promise<Result<SyncOutcome, string | "retry">> => {
    const remote = await pull(keys.value, deps, seen);
    if (!remote.ok) {
      return err(remote.error);
    }
    // A joiner never creates the household: with no server copy, its
    // placeholder stays local and the round writes nothing (a wrong code
    // must not create a household, and the creator pushes its own later).
    if (remote.value.state === undefined && isJoinPlaceholder(input.local)) {
      return ok({
        state: input.local,
        maxSeenRev: input.maxSeenRev,
        status: { state: "not-found" },
        etag: undefined,
        ...seen,
      });
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
    // Push only when the server copy differs from the merge result, or
    // when the caller forces a write to deliver a new token.
    const serverRev = remote.value.state?.rev;
    const tie = serverRev === merged.rev && remote.value.state === merged;
    // A full tie merges to the server's object. Same content: hand back
    // the caller's own object, so "changed" (state !== local) is false
    // and the service worker does not rewrite storage — a rewrite may
    // fire storage.onChanged and queue another round, forever, on a
    // browser that reports unchanged writes. Both sides are sanitizer
    // output (fixed key order), so JSON equality is value equality.
    const settled = (s: HouseholdState): HouseholdState =>
      JSON.stringify(s) === JSON.stringify(input.local) ? input.local : s;
    if (tie && input.forceWrite !== true) {
      return ok({
        state: settled(merged),
        maxSeenRev: Math.max(maxSeen, merged.rev),
        status: { state: "ok", lastSuccessAt: deps.now() },
        etag: remote.value.etag,
        ...seen,
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
      seen,
    );
    if (!pushed.ok) {
      return pushed.error === "conflict" ? err("retry") : err(pushed.error);
    }
    return ok({
      // A forced write of a tie pushed the merge unchanged (no rev bump).
      state: tie ? settled(toPush) : toPush,
      maxSeenRev: Math.max(maxSeen, toPush.rev),
      status: { state: "ok", lastSuccessAt: deps.now() },
      etag: pushed.value,
      ...seen,
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

/**
 * Leaving a household: take this device out of the shared device list so
 * its fair-use place is freed (as Android SyncClient.unenroll and iOS
 * Unenroll.swift). A normal round first (adopt the latest state), then the
 * same state without this device as a new revision; a second pass if a
 * concurrent write put it back. Best effort: offline or an error leaves
 * the place taken. Never sends DELETE — the last device leaving leaves the
 * household's record with an empty device list. A join placeholder sends
 * nothing: it was never enrolled, and it has nothing to take off a list.
 */
export async function unenroll(input: SyncInput, deps: SyncDeps): Promise<SyncOutcome> {
  if (isJoinPlaceholder(input.local)) {
    return {
      state: input.local,
      maxSeenRev: input.maxSeenRev,
      status: { state: "ok", lastSuccessAt: deps.now() },
      etag: undefined,
      entExp: null,
      refusal: null,
    };
  }
  let outcome = await syncOnce(input, deps);
  for (let pass = 0; pass < 2; pass++) {
    if (outcome.status.state !== "ok" || !outcome.state.devices.includes(input.deviceId)) {
      return outcome;
    }
    const without = {
      ...outcome.state,
      devices: outcome.state.devices.filter((d) => d !== input.deviceId),
    };
    outcome = await syncOnce(
      {
        ...input,
        local: bumpRev(without, input.deviceId, deps.now()),
        maxSeenRev: outcome.maxSeenRev,
      },
      deps,
    );
  }
  return outcome;
}
