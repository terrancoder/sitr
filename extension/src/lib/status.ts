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
 * Safari's DNR priority handling was broken before Safari 26 (blocks
 * overrode higher-priority redirects; numeric priorities mis-ordered) —
 * the allow ladder and SafeSearch would silently mis-enforce. On older
 * Safari we render red with an explicit reason rather than pretend.
 * Chrome/other engines are never gated. Pure so it is exhaustively
 * testable; the caller feeds it navigator.userAgent.
 */
export const MIN_SAFARI_MAJOR = 26;

export function safariVersionGate(userAgent: string): string | null {
  // Safari UAs carry "Version/<v> ... Safari/"; Chrome/Edge UAs never
  // include "Version/" — absence means: not Safari, no gate.
  const m = /Version\/(\d+)[.\d]* .*Safari\//.exec(userAgent);
  if (m === null) return null;
  const major = Number(m[1]);
  if (major >= MIN_SAFARI_MAJOR) return null;
  return (
    `Safari ${major} cannot enforce Sitr's rule ordering correctly — ` +
    `Safari ${MIN_SAFARI_MAJOR} or newer is required`
  );
}

/**
 * The host origins whose grants the safesearch ruleset depends on. On
 * Safari these are per-site, user-revocable grants: an ungranted host
 * silently disables the redirect while getEnabledRulesets still reports
 * the ruleset enabled — so grants are part of the protection proof.
 * (Chrome grants them at install; users can still withhold site access.)
 */
export const SAFESEARCH_ORIGINS = [
  "*://*.google.com/*",
  "*://www.bing.com/*",
  "*://duckduckgo.com/*",
  "*://*.youtube.com/*",
  "*://youtubei.googleapis.com/*",
];

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
