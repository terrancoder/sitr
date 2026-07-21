/**
 * Apply a HouseholdState to the filtering engine — engine first, persist
 * after (CLAUDE.md §4: settings never claim a state the engine doesn't
 * have). Chrome APIs are injected so the sequencing logic is unit-testable
 * without a browser.
 */
import { type Result, err, ok } from "../result.js";
import { planLayerUpdate, type LiveRule } from "../ruleLayers.js";
import { TOGGLEABLE_CATEGORIES } from "../categories.js";
import type { HouseholdState } from "../household.js";

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
}

/**
 * Reconcile the household rule layer and household category choices.
 * Managed-forced categories are re-enabled by the service worker's own
 * check; household disables never win over managed force because the SW
 * computes required rulesets with forced categories included.
 */
export async function applyHouseholdState(
  state: HouseholdState,
  forcedCategories: readonly string[],
  deps: EngineDeps,
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
    const forced = new Set(forcedCategories);
    const disable = state.disabledCategories.filter((id) => !forced.has(id));
    const enable = TOGGLEABLE_CATEGORIES.map((c) => c.rulesetId).filter(
      (id) => !disable.includes(id),
    );
    await deps.updateEnabledRulesets({
      enableRulesetIds: enable,
      disableRulesetIds: disable,
    });
    await deps.persist(state);
    return ok(undefined);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
