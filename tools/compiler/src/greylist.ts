import {
  type CompileIssue,
  type DnrRule,
  type Result,
  err,
  ok,
} from "./types.js";
import { DOMAINS_PER_RULE, MAX_RULES_PER_RULESET } from "./compile.js";

/**
 * Media-filter rulesets (threat-model T12) — both ship `"enabled": false`
 * in the manifest and are toggled by the extension's media mode.
 *
 *  - `greylist.json` (greylist mode): block `image`+`media` loads whose
 *    INITIATOR is a listed mixed-content host. Initiator matching is the
 *    point — Reddit serves images from i.redd.it, X from pbs.twimg.com;
 *    matching request domains would mean chasing CDNs forever, and
 *    initiator matching covers subdomains automatically.
 *  - `media-all.json` (allowlist-only mode): one blanket block of
 *    `image`+`media` everywhere; the extension's image-allowlist dynamic
 *    band (priority 2) re-admits the user's chosen sites.
 *
 * Both stay at priority 1, BELOW the image-allowlist band (2) and the
 * static category blocks (5): an allowlist entry re-enables a site's
 * images but can never re-admit a request to a blocklisted domain. See
 * architecture.md's priority ladder.
 *
 * The greylist source is blocklist/greylist/hosts.txt — deliberately
 * outside blocklist/sources/ (it is not a blocklist; see
 * blocklist/policy/media-greylist-policy.md) and wired explicitly in
 * cli.ts so it can never leak into the Safari/Android emitters.
 */
export const GREYLIST_ID_BASE = 40_000;
export const MEDIA_ALL_ID_BASE = 50_000;
export const MEDIA_FILTER_PRIORITY = 1;

/** The two resource types the media filter touches — nothing else. */
export const MEDIA_RESOURCE_TYPES = ["image", "media"];

/** Compile the greylist hosts into initiator-scoped block rules. */
export function compileGreylistRuleset(
  sortedHosts: string[],
): Result<DnrRule[], CompileIssue> {
  const rules: DnrRule[] = [];
  for (let i = 0; i < sortedHosts.length; i += DOMAINS_PER_RULE) {
    rules.push({
      id: GREYLIST_ID_BASE + rules.length + 1,
      priority: MEDIA_FILTER_PRIORITY,
      action: { type: "block" },
      condition: {
        initiatorDomains: sortedHosts.slice(i, i + DOMAINS_PER_RULE),
        resourceTypes: [...MEDIA_RESOURCE_TYPES],
      },
    });
  }
  if (rules.length > MAX_RULES_PER_RULESET) {
    return err({
      kind: "rule-limit-exceeded",
      message: `greylist compiles to ${rules.length} rules (limit ${MAX_RULES_PER_RULESET}) — raise batching`,
    });
  }
  return ok(rules);
}

/** The allowlist-only mode's blanket rule — constant, like safesearch. */
export function mediaAllRules(): DnrRule[] {
  return [
    {
      id: MEDIA_ALL_ID_BASE + 1,
      priority: MEDIA_FILTER_PRIORITY,
      action: { type: "block" },
      condition: {
        resourceTypes: [...MEDIA_RESOURCE_TYPES],
      },
    },
  ];
}
