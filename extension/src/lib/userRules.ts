/**
 * Per-site user allow/deny rules — pure, network-free logic (CLAUDE.md §9).
 *
 * User choices are stored as DNR *dynamic* rules in the browser. They never
 * leave the device (§2). The dynamic rules themselves are the single source
 * of truth; nothing is mirrored anywhere else.
 *
 * Priorities: static block rulesets use priority 1. A user block sits above
 * them (10), and a user allow sits above everything (20) so an explicit
 * "always allow this site" always wins.
 */
import { type Result, err, ok } from "./result.js";

export type UserRuleKind = "allow" | "block";

export const USER_RULE_ID_BASE: Record<UserRuleKind, number> = {
  allow: 1_000_000,
  block: 1_500_000,
};
export const USER_RULE_PRIORITY: Record<UserRuleKind, number> = {
  allow: 20,
  block: 10,
};
/** Well under Chrome's 30k dynamic-rule limit, split across both kinds. */
export const MAX_USER_RULES_PER_KIND = 5_000;

/** Explicit full list — omitting resourceTypes excludes main_frame in DNR. */
const ALL_RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "other",
];

export interface UserRule {
  id: number;
  priority: number;
  action: { type: UserRuleKind };
  condition: { requestDomains: string[]; resourceTypes: string[] };
}

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

export function kindOf(rule: { id: number }): UserRuleKind | undefined {
  if (
    rule.id >= USER_RULE_ID_BASE.allow &&
    rule.id < USER_RULE_ID_BASE.allow + MAX_USER_RULES_PER_KIND
  ) {
    return "allow";
  }
  if (
    rule.id >= USER_RULE_ID_BASE.block &&
    rule.id < USER_RULE_ID_BASE.block + MAX_USER_RULES_PER_KIND
  ) {
    return "block";
  }
  return undefined;
}

/** Sorted domains of one kind, read straight from the live dynamic rules. */
export function domainsOf(
  rules: Array<{ id: number; condition?: { requestDomains?: string[] } }>,
  kind: UserRuleKind,
): Array<{ id: number; domain: string }> {
  return rules
    .filter((r) => kindOf(r) === kind)
    .flatMap((r) =>
      (r.condition?.requestDomains ?? []).map((domain) => ({
        id: r.id,
        domain,
      })),
    )
    .sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));
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
  return {
    id,
    priority: USER_RULE_PRIORITY[kind],
    action: { type: kind },
    condition: {
      requestDomains: [domain],
      resourceTypes: [...ALL_RESOURCE_TYPES],
    },
  };
}
