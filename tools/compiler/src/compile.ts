import {
  type CompileIssue,
  type DnrRule,
  type Result,
  err,
  ok,
} from "./types.js";

/**
 * Chrome guarantees 30k static rules across enabled rulesets; we budget well
 * under it and treat overflow as a surfaced compile error (CLAUDE.md §4),
 * never a truncated list.
 */
export const MAX_RULES_PER_RULESET = 25_000;

/**
 * Domains are batched into `requestDomains` conditions so thousands of
 * domains cost a handful of rules. Batch size is fixed: changing it changes
 * the output artifact, so it is part of the deterministic contract.
 */
export const DOMAINS_PER_RULE = 1_000;

/**
 * DNR's default when resourceTypes is omitted matches every type EXCEPT
 * main_frame — which would block a site's images but not the site itself.
 * Block rules must list all types explicitly. (Caught by the smoke test.)
 */
export const ALL_RESOURCE_TYPES = [
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

/**
 * Each category gets a fixed, documented id range so rule ids are stable
 * across builds and categories never collide.
 */
export const CATEGORY_ID_BASE: Record<string, number> = {
  adult: 10_000,
  gambling: 20_000,
  dating: 30_000,
};

/**
 * Compile one category's sorted domain list into a DNR "safe" block ruleset
 * (block-only actions — these skip Chrome's slow review path).
 * Deterministic: same domains in ⇒ byte-identical rules out.
 */
export function compileBlockRuleset(
  category: string,
  sortedDomains: string[],
): Result<DnrRule[], CompileIssue> {
  const idBase = CATEGORY_ID_BASE[category];
  if (idBase === undefined) {
    return err({
      kind: "empty-category",
      message: `unknown category "${category}" — add it to CATEGORY_ID_BASE with a reserved id range`,
    });
  }

  const rules: DnrRule[] = [];
  for (let i = 0; i < sortedDomains.length; i += DOMAINS_PER_RULE) {
    rules.push({
      id: idBase + rules.length + 1,
      priority: 1,
      action: { type: "block" },
      condition: {
        requestDomains: sortedDomains.slice(i, i + DOMAINS_PER_RULE),
        resourceTypes: [...ALL_RESOURCE_TYPES],
      },
    });
  }

  if (rules.length > MAX_RULES_PER_RULESET) {
    return err({
      kind: "rule-limit-exceeded",
      message: `category "${category}" compiles to ${rules.length} rules (limit ${MAX_RULES_PER_RULESET}) — split the category or raise batching`,
    });
  }
  return ok(rules);
}

/** Stable JSON serialization: 2-space indent, trailing newline, LF only. */
export function serializeRuleset(rules: DnrRule[]): string {
  return JSON.stringify(rules, null, 2) + "\n";
}
