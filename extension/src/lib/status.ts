/**
 * Protection status model — pure, network-free (CLAUDE.md §9).
 *
 * The core invariant (CLAUDE.md §4): if we cannot PROVE protection is active,
 * we report it inactive. Never optimistic.
 */

export type ProtectionStatus =
  | { state: "active" }
  | { state: "inactive"; missingRulesets: string[] }
  | { state: "unknown"; reason: string };

/**
 * Derive status from what the browser reports as enabled versus what the
 * user's settings require (see categories.ts). A category the user turned
 * off is not "missing" — only required-but-absent rulesets are failures.
 */
export function deriveStatus(
  enabledRulesetIds: string[],
  requiredRulesetIds: string[],
): ProtectionStatus {
  const enabled = new Set(enabledRulesetIds);
  const missing = requiredRulesetIds.filter((id) => !enabled.has(id));
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
