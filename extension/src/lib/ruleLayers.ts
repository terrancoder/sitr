/**
 * Dynamic-rule layers — pure, network-free logic (CLAUDE.md §9).
 *
 * Three dynamic layers sit above the static rulesets, each with a reserved
 * DNR id range and priority band, plus the image-allowlist band for the
 * media filter (threat-model T12). The ladder (architecture.md):
 *
 *   layer        kind   id base     cap    priority
 *   -----------  -----  ---------  -----  --------
 *   media filter block  compiler     —        1   (image+media only)
 *   image allow  allow  4,000,000  2,500      2   (image+media only)
 *   static       block  compiler     —        5   (incl. safesearch)
 *   user         block  1,500,000  4,500     10
 *   user         allow  1,000,000  4,500     20
 *   household    block  2,500,000  4,500     30
 *   household    allow  2,000,000  4,500     40
 *   managed      block  3,500,000  4,500     50
 *   managed      allow  3,000,000  4,500     60
 *
 * Within a layer an explicit allow wins; a higher layer's block beats a
 * lower layer's allow (managed > household > user > static). The image
 * allowlist sits BELOW the static category blocks so it can re-enable a
 * site's images but never re-admit a request to a blocklisted domain.
 *
 * Budget: 6 × 4,500 + 2,500 = 29,500, leaving 500 rules of headroom.
 * The binding constraint is Safari's combined dynamic+session pool of
 * 30,000 (Chrome gives session rules their own separate 5,000 quota);
 * the headroom is reserved for session-scoped escape hatches there.
 * Overflow is a surfaced error, never silent truncation (§4).
 */
import { type Result, err, ok } from "./result.js";

export type RuleLayer = "user" | "household" | "managed";
export type RuleKind = "allow" | "block";

export const LAYER_BASES: Record<RuleLayer, Record<RuleKind, number>> = {
  user: { allow: 1_000_000, block: 1_500_000 },
  household: { allow: 2_000_000, block: 2_500_000 },
  managed: { allow: 3_000_000, block: 3_500_000 },
};

export const LAYER_PRIORITIES: Record<RuleLayer, Record<RuleKind, number>> = {
  user: { allow: 20, block: 10 },
  household: { allow: 40, block: 30 },
  managed: { allow: 60, block: 50 },
};

/**
 * Cap per (layer, kind) band. Was 5,000 pre-media-filter; re-sliced to
 * 4,500 to fund the image-allowlist band. LAYER_BAND_WIDTH stays 5,000 so
 * rules created under the old cap (ids at offsets 4,500–4,999) are still
 * recognized, counted, and removable — the cap binds NEW growth only.
 */
export const MAX_RULES_PER_LAYER_KIND = 4_500;
export const LAYER_BAND_WIDTH = 5_000;

/** Image-allowlist band (media filter, T12): allow `image`+`media` only. */
export const IMAGE_ALLOW_BASE = 4_000_000;
export const MAX_IMAGE_ALLOW_RULES = 2_500;
export const IMAGE_ALLOW_PRIORITY = 2;
export const MEDIA_RESOURCE_TYPES = ["image", "media"];

/**
 * Session-scoped escape-hatch band ("show images here until the browser
 * closes"). Session rules only — never dynamic — and capped at exactly the
 * ladder's reserved headroom so the combined dynamic+session total stays
 * within Safari's 30,000 pool. Chrome-only in v1: Safari's open
 * session-vs-static priority bug (EFF #3) would make the hatch silently
 * inert there, and a control that does nothing is a lie.
 */
export const SESSION_ESCAPE_BASE = 4_500_000;
export const MAX_SESSION_ESCAPE_RULES = 500;

/**
 * Explicit list — omitting resourceTypes excludes main_frame in DNR.
 * "object"/"csp_report" deliberately absent: Safari silently drops rules
 * listing them (see the compiler's ALL_RESOURCE_TYPES for the full story).
 */
export const ALL_RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "xmlhttprequest",
  "ping",
  "media",
  "websocket",
  "other",
];

export interface LayerRule {
  id: number;
  priority: number;
  action: { type: RuleKind };
  condition: {
    requestDomains?: string[];
    initiatorDomains?: string[];
    resourceTypes: string[];
  };
}

/** Which (layer, kind) a dynamic-rule id belongs to, if any. */
export function layerKindOf(
  id: number,
): { layer: RuleLayer; kind: RuleKind } | undefined {
  for (const layer of ["user", "household", "managed"] as const) {
    for (const kind of ["allow", "block"] as const) {
      const base = LAYER_BASES[layer][kind];
      if (id >= base && id < base + LAYER_BAND_WIDTH) {
        return { layer, kind };
      }
    }
  }
  return undefined;
}

/** Whether a dynamic-rule id belongs to the image-allowlist band. */
export function isImageAllowId(id: number): boolean {
  return id >= IMAGE_ALLOW_BASE && id < IMAGE_ALLOW_BASE + LAYER_BAND_WIDTH;
}

export function buildLayerRule(
  layer: RuleLayer,
  kind: RuleKind,
  domain: string,
  id: number,
): LayerRule {
  return {
    id,
    priority: LAYER_PRIORITIES[layer][kind],
    action: { type: kind },
    condition: {
      requestDomains: [domain],
      resourceTypes: [...ALL_RESOURCE_TYPES],
    },
  };
}

/** Minimal shape of a live dynamic rule as read back from the engine. */
export interface LiveRule {
  id: number;
  condition?: { requestDomains?: string[]; initiatorDomains?: string[] };
}

/** Sorted domains of one layer+kind, read straight from live rules. */
export function layerDomainsOf(
  rules: LiveRule[],
  layer: RuleLayer,
  kind: RuleKind,
): Array<{ id: number; domain: string }> {
  return rules
    .filter((r) => {
      const lk = layerKindOf(r.id);
      return lk?.layer === layer && lk.kind === kind;
    })
    .flatMap((r) =>
      (r.condition?.requestDomains ?? []).map((domain) => ({
        id: r.id,
        domain,
      })),
    )
    .sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));
}

/**
 * Diff the live rules of one layer+kind against a desired domain set.
 * Returns the exact updateDynamicRules payload to reconcile them.
 *
 * Deterministic and idempotent: desired domains are deduped and sorted,
 * ids assigned smallest-free-first, rules for domains no longer desired
 * are removed. Rules in OTHER layers/kinds are never touched. Cap
 * overflow is a surfaced error (§4), computed against the post-change
 * count so a same-size replacement always succeeds.
 */
export function planLayerUpdate(
  live: LiveRule[],
  layer: RuleLayer,
  kind: RuleKind,
  desired: string[],
): Result<{ addRules: LayerRule[]; removeRuleIds: number[] }, string> {
  const want = [...new Set(desired)].sort();
  if (want.length > MAX_RULES_PER_LAYER_KIND) {
    return err(
      `limit of ${MAX_RULES_PER_LAYER_KIND} ${layer} ${kind} rules exceeded ` +
        `(${want.length} requested) — reduce the list first`,
    );
  }

  const current = layerDomainsOf(live, layer, kind);
  const wantSet = new Set(want);
  const haveSet = new Set(current.map((c) => c.domain));

  const removeRuleIds = current
    .filter((c) => !wantSet.has(c.domain))
    .map((c) => c.id);
  const keptIds = new Set(
    current.filter((c) => wantSet.has(c.domain)).map((c) => c.id),
  );

  const base = LAYER_BASES[layer][kind];
  const addRules: LayerRule[] = [];
  let cursor = 0;
  for (const domain of want) {
    if (haveSet.has(domain)) continue;
    // Ids may roam the full band width: kept rules created under the old
    // 5,000 cap can sit at high offsets; the cap check above binds counts.
    while (cursor < LAYER_BAND_WIDTH && keptIds.has(base + cursor)) {
      cursor++;
    }
    if (cursor >= LAYER_BAND_WIDTH) {
      return err(
        `no free rule ids left in the ${layer} ${kind} range — ` +
          `remove some rules first`,
      );
    }
    const id = base + cursor;
    keptIds.add(id);
    addRules.push(buildLayerRule(layer, kind, domain, id));
  }

  return ok({ addRules, removeRuleIds });
}

/* ------------------- image-allowlist band (media filter) ------------------- */

/**
 * Build one image-allowlist rule: allow `image`+`media` loads INITIATED by
 * the given site. Priority 2 — beats the media-filter blanket/greylist
 * blocks (1), loses to the static category blocks (5): the entry restores
 * a site's images but never re-admits a request to a blocklisted domain.
 */
export function buildImageAllowRule(site: string, id: number): LayerRule {
  return {
    id,
    priority: IMAGE_ALLOW_PRIORITY,
    action: { type: "allow" },
    condition: {
      initiatorDomains: [site],
      resourceTypes: [...MEDIA_RESOURCE_TYPES],
    },
  };
}

/** Sorted sites of the image-allowlist band, read straight from live rules. */
export function imageAllowSitesOf(
  rules: LiveRule[],
): Array<{ id: number; domain: string }> {
  return rules
    .filter((r) => isImageAllowId(r.id))
    .flatMap((r) =>
      (r.condition?.initiatorDomains ?? []).map((domain) => ({
        id: r.id,
        domain,
      })),
    )
    .sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));
}

/**
 * Diff the live image-allowlist band against a desired site set — the
 * image-band analogue of planLayerUpdate, same determinism and surfaced
 * overflow contract.
 */
export function planImageAllowUpdate(
  live: LiveRule[],
  desired: string[],
): Result<{ addRules: LayerRule[]; removeRuleIds: number[] }, string> {
  const want = [...new Set(desired)].sort();
  if (want.length > MAX_IMAGE_ALLOW_RULES) {
    return err(
      `limit of ${MAX_IMAGE_ALLOW_RULES} image-allowlist rules exceeded ` +
        `(${want.length} requested) — reduce the list first`,
    );
  }

  const current = imageAllowSitesOf(live);
  const wantSet = new Set(want);
  const haveSet = new Set(current.map((c) => c.domain));

  const removeRuleIds = current
    .filter((c) => !wantSet.has(c.domain))
    .map((c) => c.id);
  const keptIds = new Set(
    current.filter((c) => wantSet.has(c.domain)).map((c) => c.id),
  );

  const addRules: LayerRule[] = [];
  let cursor = 0;
  for (const domain of want) {
    if (haveSet.has(domain)) continue;
    while (cursor < LAYER_BAND_WIDTH && keptIds.has(IMAGE_ALLOW_BASE + cursor)) {
      cursor++;
    }
    if (cursor >= LAYER_BAND_WIDTH) {
      return err(
        "no free rule ids left in the image-allowlist range — " +
          "remove some rules first",
      );
    }
    const id = IMAGE_ALLOW_BASE + cursor;
    keptIds.add(id);
    addRules.push(buildImageAllowRule(domain, id));
  }

  return ok({ addRules, removeRuleIds });
}
