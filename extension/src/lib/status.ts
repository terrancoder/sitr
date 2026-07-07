/**
 * Protection status model — pure, network-free (CLAUDE.md §9).
 *
 * The core invariant (CLAUDE.md §4): if we cannot PROVE protection is active,
 * we report it inactive. Never optimistic.
 */

/** Ruleset ids that MUST be enabled for protection to count as active. */
export const REQUIRED_RULESETS = [
  "sitr_adult",
  "sitr_gambling",
  "sitr_dating",
  "sitr_safesearch",
] as const;

export type ProtectionStatus =
  | { state: "active" }
  | { state: "inactive"; missingRulesets: string[] }
  | { state: "unknown"; reason: string };

/** Derive status from the list of rulesets the browser reports as enabled. */
export function deriveStatus(enabledRulesetIds: string[]): ProtectionStatus {
  const enabled = new Set(enabledRulesetIds);
  const missing = REQUIRED_RULESETS.filter((id) => !enabled.has(id));
  return missing.length === 0
    ? { state: "active" }
    : { state: "inactive", missingRulesets: missing };
}

/** Badge presentation for a status. Empty text = no badge (all good). */
export function badgeFor(status: ProtectionStatus): {
  text: string;
  color: string;
  title: string;
} {
  switch (status.state) {
    case "active":
      return { text: "", color: "#1a7f37", title: "Sitr — protection active" };
    case "inactive":
      return {
        text: "!",
        color: "#c62828",
        title: `Sitr — PROTECTION INACTIVE (rulesets not loaded: ${status.missingRulesets.join(", ")})`,
      };
    case "unknown":
      return {
        text: "?",
        color: "#c62828",
        title: `Sitr — protection state unknown: ${status.reason}`,
      };
  }
}
