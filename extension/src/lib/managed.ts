/**
 * Managed (enterprise) policy — pure, network-free logic (CLAUDE.md §9).
 *
 * Institutions deliver policy through the browser's own mechanism
 * (chrome.storage.managed, fed by GPO / plist / Google Admin — see
 * docs/institutions/). The extension never fetches policy itself.
 *
 * Trust model (threat-model.md): the device administrator is trusted for
 * the devices they manage — this is the browser's enterprise contract, not
 * something Sitr invents. Policy is still surveillance-free: it can force
 * filtering on, never report browsing back.
 *
 * Sanitizing is total: malformed policy never throws, invalid entries are
 * dropped, and an absent policy yields the empty policy (consumer devices
 * behave exactly as before).
 */
import {
  TOGGLEABLE_CATEGORIES,
  type ToggleableRulesetId,
  requiredRulesets,
} from "./categories.js";
import { isValidDomain } from "./userRules.js";

export interface ManagedPolicy {
  /** Shown in the UI: "Managed by {organizationName}". */
  organizationName: string | undefined;
  /** Categories that cannot be disabled on this device. */
  forcedCategories: ToggleableRulesetId[];
  /** Domains blocked/allowed by the institution (managed rule layer). */
  managedBlockDomains: string[];
  managedAllowDomains: string[];
  /** When true the options page is read-only (except viewing status). */
  lockOptions: boolean;
}

export const EMPTY_MANAGED_POLICY: ManagedPolicy = {
  organizationName: undefined,
  forcedCategories: [],
  managedBlockDomains: [],
  managedAllowDomains: [],
  lockOptions: false,
};

/** True when any policy key is actually set (device is managed). */
export function isManaged(policy: ManagedPolicy): boolean {
  return (
    policy.organizationName !== undefined ||
    policy.forcedCategories.length > 0 ||
    policy.managedBlockDomains.length > 0 ||
    policy.managedAllowDomains.length > 0 ||
    policy.lockOptions
  );
}

function sanitizeDomainList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw.filter(
        (d): d is string => typeof d === "string" && isValidDomain(d),
      ),
    ),
  ].sort();
}

/** Total sanitizer: any unknown/invalid input degrades to the empty policy. */
export function sanitizeManagedPolicy(raw: unknown): ManagedPolicy {
  if (typeof raw !== "object" || raw === null) return EMPTY_MANAGED_POLICY;
  const o = raw as Record<string, unknown>;
  const knownCategories = new Set<string>(
    TOGGLEABLE_CATEGORIES.map((c) => c.rulesetId),
  );
  const forcedCategories = Array.isArray(o["forcedCategories"])
    ? [
        ...new Set(
          o["forcedCategories"].filter(
            (v): v is ToggleableRulesetId =>
              typeof v === "string" && knownCategories.has(v),
          ),
        ),
      ]
    : [];
  return {
    organizationName:
      typeof o["organizationName"] === "string" &&
      o["organizationName"].trim().length > 0
        ? o["organizationName"].trim().slice(0, 200)
        : undefined,
    forcedCategories,
    managedBlockDomains: sanitizeDomainList(o["managedBlockDomains"]),
    managedAllowDomains: sanitizeDomainList(o["managedAllowDomains"]),
    lockOptions: o["lockOptions"] === true,
  };
}

/**
 * The rulesets that MUST be enabled once policy is considered: a forced
 * category is required even if the device user disabled it locally.
 */
export function effectiveRequiredRulesets(
  deviceDisabled: ToggleableRulesetId[],
  householdDisabled: ToggleableRulesetId[],
  forced: ToggleableRulesetId[],
): string[] {
  const forcedSet = new Set<string>(forced);
  // A category is disabled only if some layer disabled it AND policy does
  // not force it. Household disable applies household-wide; device disable
  // applies locally; managed force overrides both.
  const disabled = [...new Set([...deviceDisabled, ...householdDisabled])]
    .filter((id) => !forcedSet.has(id));
  return requiredRulesets(disabled);
}

/** Whether the options UI must render a category toggle as locked. */
export function isCategoryLocked(
  id: ToggleableRulesetId,
  policy: ManagedPolicy,
): boolean {
  return policy.lockOptions || policy.forcedCategories.includes(id);
}
