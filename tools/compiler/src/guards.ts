/**
 * Compile-time guards over every list the compiler emits as a block list.
 *
 * Every platform blocks a listed entry AND all of its subdomains, so one
 * over-broad line (`co.uk`, `github.io`, `google.com`) silently breaks a
 * large part of the web. These checks fail the build, with file and line,
 * instead. The import tool (tools/import) applies the same functions as
 * filters, so imported data never reaches the compiler in a failing state.
 */
import type { Entry } from "./parse.js";
import type { PublicSuffixList } from "./psl.js";
import type { CompileIssue } from "./types.js";

/** True when listing `entry` would block `name` (same host or a subdomain). */
export function blocks(entry: string, name: string): boolean {
  return name === entry || name.endsWith("." + entry);
}

/** Strict ancestors of a name, nearest first: a.b.c → b.c, c. */
export function ancestors(name: string): string[] {
  const out: string[] = [];
  for (let i = name.indexOf("."); i >= 0; i = name.indexOf(".", i + 1)) {
    out.push(name.slice(i + 1));
  }
  return out;
}

export function checkPublicSuffixes(
  entries: readonly Entry[],
  psl: PublicSuffixList,
): CompileIssue[] {
  return entries
    .filter((e) => psl.blocksPublicSuffix(e.domain))
    .map((e) => ({
      kind: "public-suffix" as const,
      message: psl.isPublicSuffix(e.domain)
        ? `"${e.domain}" is a public suffix (Public Suffix List) — listing it would block every site under it`
        : `"${e.domain}" has a public suffix beneath it (Public Suffix List) — listing it would block every site under that suffix`,
      file: e.file,
      line: e.line,
    }));
}

/** Four numeric labels: an IPv4 address, never a list entry (isValidDomain accepts one). */
export const isIPv4Like = (name: string): boolean => /^\d+\.\d+\.\d+\.\d+$/.test(name);

export function checkIpAddresses(entries: readonly Entry[]): CompileIssue[] {
  return entries
    .filter((e) => isIPv4Like(e.domain))
    .map((e) => ({
      kind: "invalid-domain" as const,
      message: `"${e.domain}" is an IP address — lists name hosts, not addresses`,
      file: e.file,
      line: e.line,
    }));
}

/**
 * Index of the never-block list: every name, and every ancestor of every
 * name, mapped to the never-block name it would take down. An entry E hits
 * when E is a key (E == N, or N ends with "." + E).
 */
export interface NeverBlockIndex {
  names: ReadonlySet<string>;
  hitBy: ReadonlyMap<string, string>;
}

export function indexNeverBlock(names: readonly string[]): NeverBlockIndex {
  const hitBy = new Map<string, string>();
  for (const n of [...names].sort()) {
    for (const key of [n, ...ancestors(n)]) {
      if (!hitBy.has(key)) hitBy.set(key, n);
    }
  }
  return { names: new Set(names), hitBy };
}

/**
 * Which never-block name, if any, `domain` would block.
 *
 * `exempt` is for the lists that deliberately name hosts of big platforms
 * (the per-site media lists and opt-in lists declaring "neverBlockExempt").
 * It is narrow on purpose: a hit is allowed only when the entry is itself a
 * strict subdomain of a never-block name and not a never-block name — so
 * `i.imgur.com` may sit above a never-block `cdn.i.imgur.com`, but
 * `imgur.com` or `google.com` in such a list still fails.
 */
export function neverBlockHit(
  domain: string,
  index: NeverBlockIndex,
  exempt: boolean,
): string | undefined {
  const hit = index.hitBy.get(domain);
  if (hit === undefined) return undefined;
  if (
    exempt &&
    !index.names.has(domain) &&
    ancestors(domain).some((a) => index.names.has(a))
  ) {
    return undefined;
  }
  return hit;
}

/**
 * The stricter rule for the IMPORTED tier: no never-block name, nothing
 * that contains one, and nothing under one. Upstream lists name blogs and
 * boards on big platforms (`boards.4chan.org`, `nsfw.reddit.com`, an fc2
 * blog) with no evidence attached; only a human, in the curated tier, may
 * list a specific subdomain of a never-block platform. No exemption.
 */
export function importedNeverBlockHit(
  domain: string,
  index: NeverBlockIndex,
): string | undefined {
  return index.hitBy.get(domain) ?? ancestors(domain).find((a) => index.names.has(a));
}

export function checkNeverBlock(
  entries: readonly Entry[],
  index: NeverBlockIndex,
  exempt: boolean,
  imported = false,
): CompileIssue[] {
  const issues: CompileIssue[] = [];
  for (const e of entries) {
    const hit = imported ? importedNeverBlockHit(e.domain, index) : neverBlockHit(e.domain, index, exempt);
    if (hit !== undefined) {
      issues.push({
        kind: "never-block",
        message: blocks(hit, e.domain) && hit !== e.domain
          ? `"${e.domain}" sits under never-block name "${hit}" — the imported tier may not list it (re-run the import)`
          : `"${e.domain}" would block never-block name "${hit}" (blocklist/policy/never-block.txt)`,
        file: e.file,
        line: e.line,
      });
    }
  }
  return issues;
}

/**
 * An imported entry that matches an exclusion (same name, ancestor or
 * subdomain) means imported.txt is stale: re-run the import.
 */
export function checkExclusions(
  imported: readonly Entry[],
  exclusions: readonly string[],
): CompileIssue[] {
  const issues: CompileIssue[] = [];
  // ponytail: linear scan per entry (entries x exclusions); index by
  // ancestors like NeverBlockIndex if exclusions grow past a few thousand.
  for (const e of imported) {
    const x = exclusions.find((x) => blocks(e.domain, x) || blocks(x, e.domain));
    if (x !== undefined) {
      issues.push({
        kind: "excluded-entry",
        message: `"${e.domain}" matches import exclusion "${x}" (blocklist/policy/import-exclusions.txt) — re-run the import`,
        file: e.file,
        line: e.line,
      });
    }
  }
  return issues;
}

export interface TierInput {
  curated: readonly Entry[];
  imported: readonly Entry[];
}

export interface MergedList {
  /** Sorted, deduplicated, with redundant subdomains removed. */
  domains: string[];
  /** Imported entries also in the curated tier (kept as curated). */
  inBothTiers: number;
  /** Entries dropped because an ancestor is listed in the same list. */
  redundant: number;
}

/**
 * Union the two tiers. An entry in both is kept once, as curated. An entry
 * whose ancestor is also listed adds nothing (every platform matches
 * subdomains) but would cost a Safari rule, so it is dropped and counted.
 */
export function mergeTiers(list: TierInput): MergedList {
  const curated = new Set(list.curated.map((e) => e.domain));
  const all = new Set(curated);
  let inBothTiers = 0;
  for (const e of list.imported) {
    if (curated.has(e.domain)) inBothTiers++;
    else all.add(e.domain);
  }
  const domains = [...all].filter((d) => !ancestors(d).some((a) => all.has(a)));
  return {
    domains: domains.sort(),
    inBothTiers,
    redundant: all.size - domains.length,
  };
}

/**
 * An entry may appear in only one list (category or optional list): which
 * toggle blocks it must be unambiguous. Exact duplicates across lists are
 * errors naming both places.
 */
export function checkCrossListDuplicates(
  lists: ReadonlyArray<{ id: string; entries: readonly Entry[] }>,
): CompileIssue[] {
  const firstSeen = new Map<string, { id: string; entry: Entry }>();
  const issues: CompileIssue[] = [];
  for (const { id, entries } of lists) {
    const seenHere = new Set<string>();
    for (const entry of entries) {
      if (seenHere.has(entry.domain)) continue;
      seenHere.add(entry.domain);
      const prior = firstSeen.get(entry.domain);
      if (prior === undefined) {
        firstSeen.set(entry.domain, { id, entry });
      } else {
        issues.push({
          kind: "duplicate-entry",
          message: `"${entry.domain}" is in both "${prior.id}" (${prior.entry.file}${prior.entry.line !== undefined ? `:${prior.entry.line}` : ""}) and "${id}" — an entry may be in only one list`,
          file: entry.file,
          line: entry.line,
        });
      }
    }
  }
  return issues;
}
