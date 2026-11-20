/**
 * The household round of the full channel (Chrome, Developer ID Safari):
 * the sync round with claims and renewal of the Sitr Family subscription
 * (lib/sync/renew.ts). Excluded from the Mac App Store staging, which
 * points the service worker at memberChannel.js instead
 * (tools/pack/stage-safari.mjs).
 *
 * storage.local, beside `entitlementToken` (docs/sync-protocol.md
 * §Extension): `subscriptionCode`, `claimSecret` (32 random bytes,
 * base64url; never sent to the sync server, never in the household blob)
 * and `claimState` (entitlement.ts ClaimState). The end date goes to
 * HOUSEHOLD_END_KEY as in the member build.
 */
import { sanitizeClaimState } from "../lib/entitlement.js";
import { HOUSEHOLD_ROLE_KEY } from "../lib/household.js";
import { CLAIM_BASE_URL, type SyncDeps, type SyncInput, type SyncOutcome } from "../lib/sync/client.js";
import { newClaimSecret, renewAndSync } from "../lib/sync/renew.js";
import { HOUSEHOLD_END_KEY, storeChanged } from "./memberChannel.js";

export const SUBSCRIPTION_CODE_KEY = "subscriptionCode";
export const CLAIM_SECRET_KEY = "claimSecret";
export const CLAIM_STATE_KEY = "claimState";
/** `true` after a round dropped the code because its token was for another
 * plan (Sitr for Institutions), for the options page's text. Removed when
 * a code is entered again, on leave, or when the user dismisses it. */
export const OTHER_PLAN_KEY = "claimOtherPlan";

/** The claim state this worker last wrote (JSON): its own write must not
 * start a round. Lost with the worker, as is any round that wrote it. */
let written: string | undefined;

/**
 * Whether a storage change starts a round (service-worker.ts listener): a
 * code entered, or a claim state written by someone else (the options
 * page). The round's own writes do not, so rounds cannot loop.
 */
export function startsRound(changes: Record<string, { newValue?: unknown }>): boolean {
  if (typeof changes[SUBSCRIPTION_CODE_KEY]?.newValue === "string") return true;
  const c = changes[CLAIM_STATE_KEY];
  return c !== undefined && c.newValue !== undefined && JSON.stringify(c.newValue) !== written;
}

export async function channelRound(
  input: SyncInput,
  deps: SyncDeps,
  householdKept: () => Promise<boolean>,
): Promise<SyncOutcome> {
  const stored = await chrome.storage.local.get([
    SUBSCRIPTION_CODE_KEY,
    CLAIM_SECRET_KEY,
    CLAIM_STATE_KEY,
    HOUSEHOLD_ROLE_KEY,
  ]);
  const code = typeof stored[SUBSCRIPTION_CODE_KEY] === "string" ? (stored[SUBSCRIPTION_CODE_KEY] as string) : null;
  let claimSecret = typeof stored[CLAIM_SECRET_KEY] === "string" ? (stored[CLAIM_SECRET_KEY] as string) : null;
  if (code !== null && claimSecret === null) {
    // Stored before any claim can bind it: a lost secret costs the rebind.
    claimSecret = newClaimSecret();
    await chrome.storage.local.set({ [CLAIM_SECRET_KEY]: claimSecret });
  }
  const result = await renewAndSync(
    {
      sync: input,
      code,
      claimSecret,
      role: typeof stored[HOUSEHOLD_ROLE_KEY] === "string" ? (stored[HOUSEHOLD_ROLE_KEY] as string) : undefined,
      claimState: sanitizeClaimState(stored[CLAIM_STATE_KEY]),
    },
    {
      ...deps,
      random: Math.random,
      claimAllowed: () => chrome.permissions.contains({ origins: [`${CLAIM_BASE_URL}/*`] }),
    },
  );
  // A code saved or removed during the round comes with its own claim
  // state: keep that one.
  if (!(await householdKept())) return result.outcome;
  const now = await chrome.storage.local.get([SUBSCRIPTION_CODE_KEY, CLAIM_STATE_KEY]);
  if ((now[SUBSCRIPTION_CODE_KEY] ?? null) !== code) return result.outcome;
  // Written during the round (the page's "Try again" or "Renew on this
  // browser"): drop this round's state; that write starts the next round.
  if (JSON.stringify(now[CLAIM_STATE_KEY]) !== JSON.stringify(stored[CLAIM_STATE_KEY])) return result.outcome;
  const s = result.claimState;
  written = JSON.stringify(s);
  await storeChanged({
    [CLAIM_STATE_KEY]: s,
    [HOUSEHOLD_END_KEY]: { entExp: s.entExp, lapsed: s.lapsed, testHousehold: s.testHousehold },
  });
  if (result.forgetCode) {
    await chrome.storage.local.remove([SUBSCRIPTION_CODE_KEY, CLAIM_SECRET_KEY]);
    await chrome.storage.local.set({ [OTHER_PLAN_KEY]: true });
  }
  return result.outcome;
}
