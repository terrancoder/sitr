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

/* --------------------- media filtering (threat-model T12) --------------------- */

/**
 * The media-filter mode is a tri-state, not a category toggle: `greylist`
 * blocks images+media on the public greylist's hosts; `allowlist` blocks
 * them everywhere except the user's image allowlist (the dynamic band in
 * ruleLayers.ts). Off by default — discipline infrastructure, opt-in.
 */
export type MediaMode = "off" | "greylist" | "allowlist";

/** storage.local key holding the media-filter mode. */
export const MEDIA_MODE_KEY = "mediaMode";

export const GREYLIST_RULESET = "sitr_media_greylist";
export const MEDIA_ALL_RULESET = "sitr_media_all";

/** Both media rulesets ship `enabled: false`; the mode decides which is on. */
export const MEDIA_RULESETS = [GREYLIST_RULESET, MEDIA_ALL_RULESET] as const;

/** Total sanitizer: anything unknown degrades to "off" (the default). */
export function sanitizeMediaMode(stored: unknown): MediaMode {
  return stored === "greylist" || stored === "allowlist" ? stored : "off";
}

/** Which media ruleset(s) the mode requires enabled. */
export function mediaRulesets(mode: MediaMode): string[] {
  switch (mode) {
    case "off":
      return [];
    case "greylist":
      return [GREYLIST_RULESET];
    case "allowlist":
      return [MEDIA_ALL_RULESET];
  }
}

/**
 * Ordered strictly by how much the mode filters. Moving DOWN this ladder is
 * loosening (PIN-gated, see gate.ts); moving up is tightening.
 */
const MODE_STRICTNESS: Record<MediaMode, number> = {
  off: 0,
  greylist: 1,
  allowlist: 2,
};

export function isMediaModeLoosening(from: MediaMode, to: MediaMode): boolean {
  return MODE_STRICTNESS[to] < MODE_STRICTNESS[from];
}
