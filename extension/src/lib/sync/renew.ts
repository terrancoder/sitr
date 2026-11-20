/**
 * One background round of a device that may renew its household's Sitr
 * Family subscription (docs/sync-protocol.md §What each client must do):
 * decide, maybe claim, sync, fold the answer in. Network and time are
 * injected; the claim goes through claimClient.ts and the sync through
 * client.ts, the only call site. Full channel only: the Mac App Store
 * staging leaves this module out (tools/pack/stage-safari.mjs).
 *
 * Nothing to do means no claim request: no code, a child-role device, no
 * claim due, or claimAllowed() false (the claim host's optional permission
 * not granted) each skip the claim host entirely.
 */
import {
  forcesWrite,
  next,
  normalizeSubscriptionCode,
  observe,
  record,
  retriesCreate,
  tokenToSend,
  type ClaimState,
} from "../entitlement.js";
import { claim } from "./claimClient.js";
import { syncOnce, type SyncDeps, type SyncInput, type SyncOutcome } from "./client.js";
import { deriveKeys } from "./crypto.js";

export interface RenewInput {
  /** The plain sync round's input; `entitlement` is the stored version 1
   * token, sent when no version 2 token is held. */
  sync: SyncInput;
  /** The subscription code as stored; null: none. */
  code: string | null;
  claimSecret: string | null;
  /** The household role; a child-role device never claims. */
  role: string | undefined;
  claimState: ClaimState;
}

export interface RenewDeps extends SyncDeps {
  random(): number;
  /** True only while the claim host's optional permission is granted. */
  claimAllowed(): Promise<boolean>;
  claimBaseUrl?: string;
}

export interface RenewResult {
  outcome: SyncOutcome;
  claimState: ClaimState;
  /** A token of another plan came back: delete the code and the claim
   * secret (the claim state is already cleared). */
  forgetCode: boolean;
}

/** 32 random bytes, base64url without padding (43 characters). */
export function newClaimSecret(): string {
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(32))) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function renewAndSync(input: RenewInput, deps: RenewDeps): Promise<RenewResult> {
  let s = input.claimState;
  let forgetCode = false;
  const code = input.code === null ? null : normalizeSubscriptionCode(input.code);
  const creds =
    code !== null && input.claimSecret !== null && input.role !== "child"
      ? { credential: code, claimSecret: input.claimSecret }
      : null;
  const keys = await deriveKeys(input.sync.rootSecret);
  const householdId = keys.ok ? keys.value.householdId : null;

  const claimNow = async (current: boolean): Promise<boolean> => {
    if (creds === null || forgetCode || !(await deps.claimAllowed())) return false;
    const outcome = await claim(
      { ...creds, replace: false, current },
      { fetch: deps.fetch, ...(deps.claimBaseUrl !== undefined ? { baseUrl: deps.claimBaseUrl } : {}) },
    );
    if (outcome.kind === "not-family") forgetCode = true;
    s = record(s, outcome, current, deps.now());
    return true;
  };
  /** Rules (b), (c), (d): claims when one is due. The drawn window time is
   * kept in the state even when nothing is due. */
  const claimIfDue = async (): Promise<boolean> => {
    if (creds === null || householdId === null) return false;
    const n = next(s, deps.now(), householdId, deps.random);
    s = n.state;
    return n.decision.kind === "claim" && (await claimNow(n.decision.current));
  };
  const sync = async (): Promise<SyncOutcome> => {
    const token = tokenToSend(s);
    const force = forcesWrite(s);
    const outcome = await syncOnce(
      { ...input.sync, entitlement: token?.raw ?? input.sync.entitlement, forceWrite: force },
      deps,
    );
    if (householdId !== null) {
      s = observe(
        s,
        {
          entExp: outcome.entExp,
          lapsed: outcome.refusal === "lapsed",
          succeeded: outcome.status.state === "ok",
          forced: force && token !== null ? token.raw : null,
        },
        householdId,
        deps.now(),
      );
    }
    return outcome;
  };

  const claimed = await claimIfDue();
  let outcome = await sync();
  if (outcome.refusal !== null && retriesCreate(outcome.refusal)) {
    // The creation's token was refused: claim once more, retry the creation once.
    if ((await claimNow(false)) && forcesWrite(s)) outcome = await sync();
  } else if (!claimed && (await claimIfDue()) && forcesWrite(s)) {
    // A lapse (or an E) this round showed first: claim at once, deliver the token.
    outcome = await sync();
  }
  return { outcome, claimState: s, forgetCode };
}
