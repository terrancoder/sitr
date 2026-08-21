/**
 * Safari content-blocker emitter — the iOS analogue of compile.ts.
 *
 * Emits WebKit content-blocker JSON (`trigger`/`action` rules) from the same
 * parsed, sorted domain lists the DNR compiler consumes. Deterministic: same
 * domains in ⇒ byte-identical rules out. The `*` prefix on an `if-domain`
 * entry matches the domain and every subdomain — parity with DNR's
 * `requestDomains` semantics.
 *
 * Layer precedence on iOS is expressed by RULE ORDER (weakest first) plus
 * `ignore-previous-rules` for allows; that assembly happens in the app
 * (SitrCore SafariRules) — this emitter produces only the static category
 * blocks, exactly as compile.ts produces only the static DNR rulesets.
 */
import { type CompileIssue, type Result, err, ok } from "./types.js";
import { DOMAINS_PER_RULE } from "./compile.js";

/**
 * WebKit allows far more, but 50k is the conservative floor across supported
 * iOS versions; overflow is a surfaced compile error (never a truncation),
 * same posture as MAX_RULES_PER_RULESET.
 */
export const MAX_SAFARI_RULES = 50_000;

/** Minimal typing of the WebKit content-blocker rule shape we emit. */
export interface SafariRule {
  trigger: {
    "url-filter": string;
    "if-domain"?: string[];
  };
  action: {
    type: "block" | "ignore-previous-rules";
  };
}

/**
 * Compile one category's sorted domain list into Safari block rules,
 * batched like the DNR compiler (shared DOMAINS_PER_RULE keeps batch size
 * part of the deterministic contract in exactly one place).
 */
export function compileSafariRuleset(
  category: string,
  sortedDomains: string[],
): Result<SafariRule[], CompileIssue> {
  const rules: SafariRule[] = [];
  for (let i = 0; i < sortedDomains.length; i += DOMAINS_PER_RULE) {
    rules.push({
      trigger: {
        "url-filter": ".*",
        "if-domain": sortedDomains
          .slice(i, i + DOMAINS_PER_RULE)
          .map((d) => `*${d}`),
      },
      action: { type: "block" },
    });
  }
  if (rules.length > MAX_SAFARI_RULES) {
    return err({
      kind: "rule-limit-exceeded",
      message: `category "${category}" compiles to ${rules.length} Safari rules (limit ${MAX_SAFARI_RULES}) — split the category or raise batching`,
    });
  }
  return ok(rules);
}

/**
 * The blocker's bundled default: every category concatenated in sorted
 * category order — the safe state before the app first regenerates rules
 * (all protections on, no dynamic rules yet).
 */
export function buildDefaultBlockerList(
  rulesetsByCategory: ReadonlyMap<string, SafariRule[]>,
): SafariRule[] {
  const all: SafariRule[] = [];
  for (const category of [...rulesetsByCategory.keys()].sort()) {
    all.push(...(rulesetsByCategory.get(category) ?? []));
  }
  return all;
}

/** Stable JSON serialization: 2-space indent, trailing newline, LF only. */
export function serializeSafariRuleset(rules: SafariRule[]): string {
  return JSON.stringify(rules, null, 2) + "\n";
}
