/**
 * Safari content-blocker emitter — the iOS analogue of compile.ts.
 *
 * Emits WebKit content-blocker JSON (`trigger`/`action` rules) from the same
 * parsed, sorted domain lists the DNR compiler consumes. Deterministic: same
 * domains in ⇒ byte-identical rules out. One rule per domain, each a
 * host-anchored `url-filter` that matches a request TO the domain or any
 * subdomain — parity with DNR's `requestDomains` and the Android DNS engine.
 *
 * (The earlier shape was one batched rule with `if-domain`. WebKit matches
 * `if-domain` against the TOP-LEVEL page, so that only blocked visits: an
 * image, frame or player from a blocked site still loaded on any other page.)
 *
 * Layer precedence on iOS is expressed by RULE ORDER (weakest first) plus
 * `ignore-previous-rules` for allows; that assembly happens in the app
 * (SitrCore SafariRules) — this emitter produces only the static category
 * blocks, exactly as compile.ts produces only the static DNR rulesets.
 */
import { type CompileIssue, type Result, ok } from "./types.js";

/**
 * WebKit rejects a content-blocker list ENTIRELY above 150,000 rules — no
 * truncation, the whole list fails to load. The iOS app compiles one list
 * from every enabled category, optional list and per-site media list plus
 * the user's and household's own rules, and the macOS Safari extension
 * turns each DNR requestDomains entry into one rule against the same
 * ceiling. So the budget is combined, worst case (everything enabled):
 * sum of all such lists + SAFARI_RULE_RESERVE <= SAFARI_RULE_BUDGET.
 * Overflow is a surfaced compile error, never a truncation.
 */
export const SAFARI_RULE_BUDGET = 145_000;
/** Kept free for user and household rules added on the device. */
export const SAFARI_RULE_RESERVE = 5_000;

/** Fails when the worst-case combined rule count exceeds the budget. */
export function checkSafariBudget(
  lists: ReadonlyArray<{ id: string; rules: number }>,
): CompileIssue | undefined {
  const total = lists.reduce((sum, l) => sum + l.rules, 0) + SAFARI_RULE_RESERVE;
  if (total <= SAFARI_RULE_BUDGET) return undefined;
  const top = [...lists]
    .sort((a, b) => b.rules - a.rules || (a.id < b.id ? -1 : 1))
    .slice(0, 3)
    .map((l) => `${l.id} ${l.rules}`)
    .join(", ");
  return {
    kind: "rule-limit-exceeded",
    message: `Safari rule budget exceeded: lists ${total - SAFARI_RULE_RESERVE} + reserve ${SAFARI_RULE_RESERVE} = ${total} > ${SAFARI_RULE_BUDGET} (WebKit fails the whole list above 150,000). Largest: ${top}`,
  };
}

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
 * The `url-filter` for one domain. Must stay byte-identical to
 * SafariRules.urlFilter(for:) in the iOS app, which builds the same rules
 * for the user and household lists (pinned by a golden test on each side).
 *
 *   ^[^:]+://+      scheme
 *   ([^/]*@)?       optional userinfo — "https://x@site.example/" is the same host
 *   ([^:/]+\.)?     optional subdomains
 *   site\.example   the domain; dots are the only regex-special character a
 *                   validated domain can contain
 *   \.?             optional root dot — "site.example./" is the same host
 *   [:/]            end of the host
 *
 * Only constructs WebKit's content-blocker regex subset supports: no
 * alternation, no counted repeats.
 */
export function safariUrlFilter(domain: string): string {
  return `^[^:]+://+([^/]*@)?([^:/]+\\.)?${domain.replace(/\./g, "\\.")}\\.?[:/]`;
}

/** Compile one category's sorted domain list into Safari block rules. */
export function compileSafariRuleset(
  category: string,
  sortedDomains: string[],
): Result<SafariRule[], CompileIssue> {
  // No per-list cap: the limit is the combined budget (checkSafariBudget).
  return ok(
    sortedDomains.map((domain) => ({
      trigger: { "url-filter": safariUrlFilter(domain) },
      action: { type: "block" },
    })),
  );
}

/**
 * The blocker's bundled default, `blockerList.default.json`: the given
 * per-category rules concatenated in sorted category order.
 *
 * It is only a FALLBACK. The content-blocker extension serves it when the
 * app has never run (the app writes the full list, every enabled category
 * with both tiers plus user and household rules, to its App Group container
 * on first launch) or when that file cannot be opened. Both iOS targets
 * bundle it, so the CLI passes only the HAND-CURATED tier of the default-on
 * categories (~500 rules): a short first-run gap in the imported tier, in
 * exchange for not shipping ~16 MB twice that is dead weight after first
 * launch. The per-category fragments keep both tiers, and the Safari rule
 * budget counts the full lists, since that is what the app builds.
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
