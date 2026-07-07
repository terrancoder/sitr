/**
 * Category model — which rulesets exist and which the user may toggle.
 *
 * `sitr_adult` and `sitr_safesearch` are always on: they are the product's
 * single purpose (§7). Optional categories can be disabled by the user, and
 * a disabled category is NOT a protection failure — the status check only
 * requires the rulesets the user expects to be active.
 */

export const ALWAYS_ON_RULESETS = ["sitr_adult", "sitr_safesearch"] as const;

export const TOGGLEABLE_CATEGORIES = [
  { rulesetId: "sitr_gambling", label: "Gambling" },
  { rulesetId: "sitr_dating", label: "Dating" },
] as const;

export type ToggleableRulesetId =
  (typeof TOGGLEABLE_CATEGORIES)[number]["rulesetId"];

/** storage.local key holding the user's disabled category ruleset ids. */
export const DISABLED_CATEGORIES_KEY = "disabledCategories";

/** Sanitize a stored value: keep only known toggleable ruleset ids. */
export function sanitizeDisabled(stored: unknown): ToggleableRulesetId[] {
  if (!Array.isArray(stored)) return [];
  const known = new Set<string>(
    TOGGLEABLE_CATEGORIES.map((c) => c.rulesetId),
  );
  return [...new Set(stored.filter((v): v is ToggleableRulesetId =>
    typeof v === "string" && known.has(v),
  ))];
}

/** The rulesets that MUST be enabled given the user's disabled set. */
export function requiredRulesets(disabled: ToggleableRulesetId[]): string[] {
  const off = new Set<string>(disabled);
  return [
    ...ALWAYS_ON_RULESETS,
    ...TOGGLEABLE_CATEGORIES.map((c) => c.rulesetId).filter(
      (id) => !off.has(id),
    ),
  ];
}
