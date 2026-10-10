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
import { type CompileIssue, type Result, err, ok } from "./types.js";

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
  const rules: SafariRule[] = sortedDomains.map((domain) => ({
    trigger: { "url-filter": safariUrlFilter(domain) },
    action: { type: "block" },
  }));
  if (rules.length > MAX_SAFARI_RULES) {
    return err({
      kind: "rule-limit-exceeded",
      message: `category "${category}" compiles to ${rules.length} Safari rules (limit ${MAX_SAFARI_RULES}) — split the category`,
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
