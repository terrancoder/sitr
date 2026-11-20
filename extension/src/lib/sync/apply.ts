/**
 * Apply a HouseholdState to the filtering engine — engine first, persist
 * after (CLAUDE.md §4: settings never claim a state the engine doesn't
 * have). Chrome APIs are injected so the sequencing logic is unit-testable
 * without a browser.
 */
import { type Result, err, ok } from "../result.js";
import { planLayerUpdate, type LiveRule } from "../ruleLayers.js";
import { TOGGLEABLE_CATEGORIES, type ToggleableRulesetId } from "../categories.js";
import type { HouseholdState } from "../household.js";
import { effectiveRequiredRulesets } from "../managed.js";

export interface EngineDeps {
  getDynamicRules(): Promise<LiveRule[]>;
  updateDynamicRules(update: {
    addRules?: unknown[];
    removeRuleIds?: number[];
  }): Promise<void>;
  updateEnabledRulesets(update: {
    enableRulesetIds?: string[];
    disableRulesetIds?: string[];
  }): Promise<void>;
  /** Persist the applied state (storage.local) — called LAST. */
  persist(state: HouseholdState): Promise<void>;
  /** The device's own disabled categories (storage.local), so a household
   * apply never re-enables one; absent: none. */
  readDeviceDisabled?(): Promise<ToggleableRulesetId[]>;
}

/**
 * Reconcile the household rule layer and household category choices.
 * Managed-forced categories are re-enabled by the service worker's own
 * check; household disables never win over managed force because the SW
 * computes required rulesets with forced categories included.
 *
 * `stored`: the state already in storage. When `state` is that very object
 * (an unchanged sync round) the engine is re-asserted but nothing is
 * persisted: the write could fire storage.onChanged and queue another round.
 */
export async function applyHouseholdState(
  state: HouseholdState,
  forcedCategories: readonly string[],
  deps: EngineDeps,
  stored?: HouseholdState,
): Promise<Result<void, string>> {
  try {
    const live = await deps.getDynamicRules();
    for (const [kind, desired] of [
      ["allow", state.allowDomains],
      ["block", state.blockDomains],
    ] as const) {
      const plan = planLayerUpdate(live, "household", kind, [...desired]);
      if (!plan.ok) return plan;
      if (plan.value.addRules.length > 0 || plan.value.removeRuleIds.length > 0) {
        await deps.updateDynamicRules({
          addRules: plan.value.addRules,
          removeRuleIds: plan.value.removeRuleIds,
        });
      }
    }
    // The same definition the service worker's refresh asserts: device and
    // household disables, managed force over both. Only the toggleable
    // categories are touched here.
    const required = new Set(
      effectiveRequiredRulesets(
        (await deps.readDeviceDisabled?.()) ?? [],
        state.disabledCategories,
        forcedCategories as ToggleableRulesetId[],
      ),
    );
    const toggleable = TOGGLEABLE_CATEGORIES.map((c) => c.rulesetId);
    await deps.updateEnabledRulesets({
      enableRulesetIds: toggleable.filter((id) => required.has(id)),
      disableRulesetIds: toggleable.filter((id) => !required.has(id)),
    });
    if (state !== stored) await deps.persist(state);
    return ok(undefined);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

/**
 * A sync round's outcome to the engine (service-worker.ts syncRound). Every
 * successful round re-asserts the household's rules, which repairs drift.
 * syncOnce hands back `local` itself when nothing changed; passed as
 * `stored`, such a round persists nothing (no onChanged, no loop).
 */
export async function applySyncOutcome(
  outcome: { state: HouseholdState; status: { state: string } },
  local: HouseholdState,
  forcedCategories: readonly string[],
  deps: EngineDeps,
): Promise<Result<void, string>> {
  if (outcome.status.state !== "ok") return ok(undefined);
  return applyHouseholdState(outcome.state, forcedCategories, deps, local);
}
