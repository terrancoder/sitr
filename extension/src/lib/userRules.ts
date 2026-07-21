/**
 * Per-site user allow/deny rules — pure, network-free logic (CLAUDE.md §9).
 *
 * User choices are stored as DNR *dynamic* rules in the browser. They never
 * leave the device (§2). The dynamic rules themselves are the single source
 * of truth; nothing is mirrored anywhere else.
 *
 * This is the device-user layer of the rule ladder; the shared id/priority
 * arithmetic for all dynamic layers (user, household, managed) lives in
 * ruleLayers.ts. The user layer's ids and priorities are unchanged from
 * before the ladder existed, so installed users need no migration.
 */
import { type Result, err, ok } from "./result.js";
import {
  ALL_RESOURCE_TYPES,
  LAYER_BASES,
  LAYER_PRIORITIES,
  MAX_RULES_PER_LAYER_KIND,
  buildLayerRule,
  layerDomainsOf,
  layerKindOf,
  type LayerRule,
  type RuleKind,
} from "./ruleLayers.js";

export type UserRuleKind = RuleKind;

export const USER_RULE_ID_BASE: Record<UserRuleKind, number> =
  LAYER_BASES.user;
export const USER_RULE_PRIORITY: Record<UserRuleKind, number> =
  LAYER_PRIORITIES.user;
/** Per layer+kind cap; six ranges sum to Chrome's 30k dynamic-rule limit. */
export const MAX_USER_RULES_PER_KIND = MAX_RULES_PER_LAYER_KIND;

export type UserRule = LayerRule;

/** Same conservative check as the blocklist compiler's isValidDomain. */
export function isValidDomain(domain: string): boolean {
  if (domain.length === 0 || domain.length > 253) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  return labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label),
  );
}

/** Normalize free-text user input ("HTTPS://Example.com/x") to a domain. */
export function normalizeDomainInput(input: string): Result<string, string> {
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // strip scheme
  s = s.replace(/[/?#].*$/, ""); // strip path/query/fragment
  s = s.replace(/:\d+$/, ""); // strip port
  s = s.replace(/^www\./, "");
  if (!isValidDomain(s)) {
    return err(`"${input.trim()}" is not a valid domain`);
  }
  return ok(s);
}

/** Kind of a DEVICE-USER rule id; household/managed ids return undefined. */
export function kindOf(rule: { id: number }): UserRuleKind | undefined {
  const lk = layerKindOf(rule.id);
  return lk?.layer === "user" ? lk.kind : undefined;
}

/** Sorted device-user domains of one kind, from the live dynamic rules. */
export function domainsOf(
  rules: Array<{ id: number; condition?: { requestDomains?: string[] } }>,
  kind: UserRuleKind,
): Array<{ id: number; domain: string }> {
  return layerDomainsOf(rules, "user", kind);
}

/** Smallest free id in the kind's reserved range. Full range = hard error. */
export function nextRuleId(
  existingIds: number[],
  kind: UserRuleKind,
): Result<number, string> {
  const base = USER_RULE_ID_BASE[kind];
  const used = new Set(existingIds);
  for (let i = 0; i < MAX_USER_RULES_PER_KIND; i++) {
    if (!used.has(base + i)) return ok(base + i);
  }
  return err(
    `limit of ${MAX_USER_RULES_PER_KIND} ${kind} rules reached — remove some first`,
  );
}

export function buildUserRule(
  kind: UserRuleKind,
  domain: string,
  id: number,
): UserRule {
  return buildLayerRule("user", kind, domain, id);
}

export { ALL_RESOURCE_TYPES };
