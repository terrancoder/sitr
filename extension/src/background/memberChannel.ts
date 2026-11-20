/**
 * The household round of the join-only Mac App Store build: the plain sync
 * round, plus the household's end date and read-only state for the options
 * page. tools/pack/stage-safari.mjs points the staged service worker here
 * instead of at fullChannel.js; both export the same channelRound. Staged in
 * both builds, so its code and comments stay free of the words that staging
 * refuses.
 */
import {
  observeEnd,
  type EndAnswer,
  type HouseholdEnd,
} from "../lib/householdEnd.js";
import { syncOnce, type SyncDeps, type SyncInput, type SyncOutcome } from "../lib/sync/client.js";

/** storage.local: { entExp, lapsed, testHousehold } (householdEnd.ts). */
export const HOUSEHOLD_END_KEY = "householdEnd";

export function sanitizeHouseholdEnd(raw: unknown): HouseholdEnd {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    entExp: typeof o["entExp"] === "number" && Number.isFinite(o["entExp"]) ? o["entExp"] : null,
    lapsed: o["lapsed"] === true,
    testHousehold: o["testHousehold"] === true,
  };
}

export function endAnswer(outcome: SyncOutcome): EndAnswer {
  return {
    entExp: outcome.entExp,
    lapsed: outcome.refusal === "lapsed",
    succeeded: outcome.status.state === "ok",
  };
}

/** Writes only what changed: every local write wakes the worker's refresh. */
export async function storeChanged(items: Record<string, unknown>): Promise<void> {
  const before = await chrome.storage.local.get(Object.keys(items));
  const changed = Object.fromEntries(
    Object.entries(items).filter(([k, v]) => JSON.stringify(before[k]) !== JSON.stringify(v)),
  );
  if (Object.keys(changed).length > 0) await chrome.storage.local.set(changed);
}

/** `householdKept`: false when the user left during the round; then
 * nothing is written. */
export async function channelRound(
  input: SyncInput,
  deps: SyncDeps,
  householdKept: () => Promise<boolean>,
): Promise<SyncOutcome> {
  const outcome = await syncOnce(input, deps);
  if (await householdKept()) {
    const stored = await chrome.storage.local.get(HOUSEHOLD_END_KEY);
    const end = observeEnd(sanitizeHouseholdEnd(stored[HOUSEHOLD_END_KEY]), endAnswer(outcome), deps.now());
    await storeChanged({ [HOUSEHOLD_END_KEY]: end });
  }
  return outcome;
}
