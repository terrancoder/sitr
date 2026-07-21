/**
 * Dynamic-rule layers — pure, network-free logic (CLAUDE.md §9).
 *
 * Three dynamic layers sit above the static rulesets, each with a reserved
 * DNR id range and priority band. The ladder (architecture.md):
 *
 *   layer      kind   id base     cap    priority
 *   ---------  -----  ---------  -----  --------
 *   static     block  compiler     —        1
 *   user       block  1,500,000  5,000     10
 *   user       allow  1,000,000  5,000     20
 *   household  block  2,500,000  5,000     30
 *   household  allow  2,000,000  5,000     40
 *   managed    block  3,500,000  5,000     50
 *   managed    allow  3,000,000  5,000     60
 *
 * Within a layer an explicit allow wins; a higher layer's block beats a
 * lower layer's allow (managed > household > user > static). The six caps
 * sum to exactly Chrome's 30,000 dynamic-rule ceiling — enforced here with
 * surfaced errors, never silent truncation (§4).
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

export const MAX_RULES_PER_LAYER_KIND = 5_000;

/** Explicit full list — omitting resourceTypes excludes main_frame in DNR. */
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

export interface LayerRule {
  id: number;
  priority: number;
  action: { type: RuleKind };
  condition: { requestDomains: string[]; resourceTypes: string[] };
}

/** Which (layer, kind) a dynamic-rule id belongs to, if any. */
export function layerKindOf(
  id: number,
): { layer: RuleLayer; kind: RuleKind } | undefined {
  for (const layer of ["user", "household", "managed"] as const) {
    for (const kind of ["allow", "block"] as const) {
      const base = LAYER_BASES[layer][kind];
      if (id >= base && id < base + MAX_RULES_PER_LAYER_KIND) {
        return { layer, kind };
      }
    }
  }
  return undefined;
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
  condition?: { requestDomains?: string[] };
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
    while (cursor < MAX_RULES_PER_LAYER_KIND && keptIds.has(base + cursor)) {
      cursor++;
    }
    if (cursor >= MAX_RULES_PER_LAYER_KIND) {
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
