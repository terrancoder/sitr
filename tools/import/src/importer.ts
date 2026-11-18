/**
 * Import tool core: upstream list bytes -> the `imported.txt` tier of a
 * Sitr list. Pure: same inputs (upstream bytes, retrieval date, curated
 * tiers, policy files) => byte-identical outputs. All I/O lives in cli.ts.
 *
 * Per upstream name, in this order (the first reason that applies is the
 * one counted):
 *   1. normalize: lowercase, strip one trailing dot, then strip ONE leading
 *      "www." when at least two labels remain. That is the only widening
 *      ever applied — `www.example.com` becomes `example.com`, which also
 *      covers its other subdomains. Nothing is ever collapsed to its
 *      registrable domain: `cdn.example.com` stays `cdn.example.com`.
 *   2. localhost-style names (localhost, broadcasthost, ip6-*, ...)  -> localhost
 *      dotted-quad IPv4 (isValidDomain accepts "0.0.0.0")             -> ip-address
 *      rejected by the compiler's reference isValidDomain              -> invalid
 *   3. a Public Suffix List entry, or a name with one beneath it      -> public-suffix
 *   4. is, contains or sits under a never-block name (no exemption;
 *      only the curated tier may name a platform subdomain)          -> never-block
 *   5. equals, contains or sits under an import exclusion             -> excluded
 *      the source declares `requireNameMatch` and the name, with every
 *      `ignore` substring deleted, contains none of its `terms`      -> no-name-match
 *   6. listed, or under a name listed, in the same list's curated tier -> covered-by-curated
 *   7. exact name in another list's curated tier, or already kept by
 *      a list earlier in the priority order                          -> in-other-list
 *   8. already seen for this list (same or earlier source)            -> duplicate
 *   9. an ancestor was kept for the same list                         -> redundant
 *
 * Lists are processed in the declared `priority` order (sources.json), so
 * a name in two upstreams for different lists lands in the first list.
 * Sources named in `claimFirst` beat that order: their names are claimed
 * for their own list before any list is processed (the snuff list lands
 * in `violence` even though StevenBlack's porn list, earlier in the
 * order, merges it in upstream).
 *
 * Only the licences in LICENSE_URLS may be imported (the blocklist data is
 * CC BY-SA 4.0, so a source must be compatible with that).
 */
import { createHash } from "node:crypto";

import { isValidDomain } from "../../compiler/dist/parse.js";
import {
  ancestors,
  blocks,
  type NeverBlockIndex,
  importedNeverBlockHit,
  isIPv4Like,
} from "../../compiler/dist/guards.js";
import type { PublicSuffixList } from "../../compiler/dist/psl.js";

export const REASONS = [
  "invalid",
  "ip-address",
  "localhost",
  "public-suffix",
  "never-block",
  "excluded",
  "no-name-match",
  "covered-by-curated",
  "in-other-list",
  "duplicate",
  "redundant",
] as const;
export type Reason = (typeof REASONS)[number];

export interface SourceDecl {
  id: string;
  /** Path under blocklist/, e.g. "sources/adult" or "optional/drugs". */
  target: string;
  url: string;
  format: "hosts" | "domains";
  license: string;
  attribution: string;
  homepage?: string;
  upstreams?: Array<{ name: string; url: string; license: string }>;
  /**
   * Narrows an upstream of doubtful precision to names that carry evidence
   * of the category: keep a name only if, after deleting every `ignore`
   * substring (ordinary words such as "alphabet"), it contains a `term`.
   */
  requireNameMatch?: { terms: string[]; ignore?: string[] };
}

export function matchesName(name: string, rule: NonNullable<SourceDecl["requireNameMatch"]>): boolean {
  let n = name;
  for (const i of rule.ignore ?? []) n = n.split(i).join("");
  return rule.terms.some((t) => n.includes(t));
}

export interface Declaration {
  priority: string[];
  /** Source ids whose names are claimed for their list ahead of `priority`. */
  claimFirst?: string[];
  sources: SourceDecl[];
}

/** SPDX id -> licence text. The only licences an imported source may carry. */
export const LICENSE_URLS: Readonly<Record<string, string>> = {
  MIT: "https://opensource.org/license/mit",
  "CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/",
  "CC-BY-SA-4.0": "https://creativecommons.org/licenses/by-sa/4.0/",
};

export interface UpstreamSnapshot {
  bytes: Uint8Array;
  /** YYYY-MM-DD; an input, never read from the clock here. */
  retrieved: string;
}

export interface ImportContext {
  psl: PublicSuffixList;
  neverBlock: NeverBlockIndex;
  exclusions: readonly string[];
  /** Curated (`domains.txt`) names per target, for every list in the repo. */
  curated: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface SourceReport {
  id: string;
  sha256: string;
  retrieved: string;
  upstreamLines: number;
  upstreamNames: number;
  kept: number;
  rejected: Record<Reason, number>;
  /** First five names per reason (all never-block hits), upstream order. */
  examples: Record<Reason, string[]>;
}

export interface TargetOutput {
  target: string;
  /** Contents of `<target>/imported.txt`. */
  body: string;
  domains: string[];
  sources: SourceReport[];
}

const LOCALHOST = new Set([
  "localhost",
  "localhost.localdomain",
  "local",
  "broadcasthost",
  "ip6-localhost",
  "ip6-loopback",
  "ip6-localnet",
  "ip6-mcastprefix",
  "ip6-allnodes",
  "ip6-allrouters",
  "ip6-allhosts",
]);

/** Names an upstream lists, in order. Returns [names, line count]. */
export function parseUpstream(text: string, format: "hosts" | "domains"): [string[], number] {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  const names: string[] = [];
  for (const raw of lines) {
    const tokens = raw.replace(/#.*$/, "").trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    // hosts: "<ip> name [name...]"; a line without an address is kept as
    // names so validation reports it rather than silently skipping it.
    if (format === "hosts" && tokens.length > 1 && isAddress(tokens[0]!)) {
      names.push(...tokens.slice(1));
    } else {
      names.push(...tokens);
    }
  }
  return [names, lines.length];
}

function isAddress(token: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(token) || /^[0-9a-f]*:[0-9a-f:.]*$/i.test(token);
}

export function normalizeName(raw: string): string {
  let name = raw.toLowerCase();
  if (name.endsWith(".")) name = name.slice(0, -1);
  if (name.startsWith("www.") && name.split(".").length >= 3) name = name.slice(4);
  return name;
}

function emptyCounts<T>(make: () => T): Record<Reason, T> {
  return Object.fromEntries(REASONS.map((r) => [r, make()])) as Record<Reason, T>;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Run every declared source. Returns one output per target that has at
 * least one source, in priority order.
 */
export function runImport(
  decl: Declaration,
  snapshots: ReadonlyMap<string, UpstreamSnapshot>,
  ctx: ImportContext,
): TargetOutput[] {
  for (const s of decl.sources) {
    if (!decl.priority.includes(s.target)) {
      throw new Error(`source "${s.id}": target "${s.target}" is not in "priority"`);
    }
    for (const l of [s.license, ...(s.upstreams ?? []).map((u) => u.license)]) {
      if (LICENSE_URLS[l] === undefined) {
        throw new Error(`source "${s.id}": licence "${l}" is not one of ${Object.keys(LICENSE_URLS).join(", ")}`);
      }
    }
  }
  // Exact names claimed by any curated tier, and by earlier imports.
  const claimed = new Map<string, string>();
  for (const [target, names] of ctx.curated) {
    for (const n of names) if (!claimed.has(n)) claimed.set(n, target);
  }
  // ponytail: a claimFirst name later dropped by its own list's guards
  // stays claimed, so no other list keeps it either; fine for 23 gore names.
  for (const id of decl.claimFirst ?? []) {
    const s = decl.sources.find((x) => x.id === id);
    const snap = snapshots.get(id);
    if (s === undefined || snap === undefined) throw new Error(`claimFirst: unknown source "${id}"`);
    for (const raw of parseUpstream(new TextDecoder().decode(snap.bytes), s.format)[0]) {
      const name = normalizeName(raw);
      if (!claimed.has(name)) claimed.set(name, s.target);
    }
  }

  const outputs: TargetOutput[] = [];
  for (const target of decl.priority) {
    const sources = decl.sources.filter((s) => s.target === target);
    if (sources.length === 0) continue;
    const curated = ctx.curated.get(target) ?? new Set<string>();
    const seen = new Set<string>();
    const keptBy = new Map<string, SourceReport>();
    const reports: SourceReport[] = [];

    for (const source of sources) {
      const snap = snapshots.get(source.id);
      if (snap === undefined) throw new Error(`no upstream snapshot for "${source.id}"`);
      const [names, upstreamLines] = parseUpstream(
        new TextDecoder().decode(snap.bytes),
        source.format,
      );
      const report: SourceReport = {
        id: source.id,
        sha256: sha256Hex(snap.bytes),
        retrieved: snap.retrieved,
        upstreamLines,
        upstreamNames: names.length,
        kept: 0,
        rejected: emptyCounts(() => 0),
        examples: emptyCounts<string[]>(() => []),
      };
      reports.push(report);
      const reject = (reason: Reason, name: string): void => {
        report.rejected[reason]++;
        // Every never-block hit is kept: they show how risky an upstream is.
        if (reason === "never-block" || report.examples[reason].length < 5) {
          report.examples[reason].push(name);
        }
      };

      for (const raw of names) {
        const name = normalizeName(raw);
        const other = claimed.get(name);
        if (LOCALHOST.has(name) || name.startsWith("ip6-")) reject("localhost", raw);
        else if (isIPv4Like(name)) reject("ip-address", raw);
        else if (!isValidDomain(name)) reject("invalid", raw);
        else if (ctx.psl.blocksPublicSuffix(name)) reject("public-suffix", name);
        else if (importedNeverBlockHit(name, ctx.neverBlock) !== undefined) reject("never-block", name);
        else if (ctx.exclusions.some((x) => blocks(name, x) || blocks(x, name))) reject("excluded", name);
        else if (source.requireNameMatch !== undefined && !matchesName(name, source.requireNameMatch)) reject("no-name-match", name);
        else if (curated.has(name) || ancestors(name).some((a) => curated.has(a))) reject("covered-by-curated", name);
        else if (other !== undefined && other !== target) reject("in-other-list", name);
        else if (seen.has(name)) reject("duplicate", name);
        else {
          seen.add(name);
          keptBy.set(name, report);
        }
      }
    }

    // Redundant: an ancestor was kept too. Charged to the source that
    // supplied the dropped name.
    const domains: string[] = [];
    for (const [name, report] of keptBy) {
      if (ancestors(name).some((a) => keptBy.has(a))) {
        report.rejected.redundant++;
        if (report.examples.redundant.length < 5) report.examples.redundant.push(name);
      } else {
        domains.push(name);
        report.kept++;
      }
    }
    domains.sort();
    for (const d of domains) claimed.set(d, target);

    outputs.push({
      target,
      domains,
      sources: reports,
      body: renderImported(target, sources, reports, domains),
    });
  }
  return outputs;
}

function renderImported(
  target: string,
  sources: SourceDecl[],
  reports: SourceReport[],
  domains: string[],
): string {
  const out = [
    `# Sitr imported tier: ${target}`,
    "# MACHINE-WRITTEN by tools/import from blocklist/imports/sources.json.",
    "# Do not edit by hand: to drop a false positive, add it to",
    "# blocklist/policy/import-exclusions.txt (appeals process) and re-run",
    "# `npm run import`. Policy: blocklist/policy/inclusion-policy.md.",
    "#",
  ];
  sources.forEach((s, i) => {
    const r = reports[i]!;
    out.push(
      `# source: ${s.id}`,
      `#   url: ${s.url}`,
      `#   licence: ${s.license}`,
      ...(s.requireNameMatch !== undefined
        ? [`#   name rule: keep only names containing one of the terms in sources.json "requireNameMatch"`]
        : []),
      `#   retrieved: ${r.retrieved}`,
      `#   sha256: ${r.sha256}`,
      `#   upstream lines: ${r.upstreamLines}, names: ${r.upstreamNames}, kept: ${r.kept}`,
      `#   rejected: ${REASONS.map((x) => `${x} ${r.rejected[x]}`).join(", ")}`,
      "#",
    );
  });
  out.push(`# entries: ${domains.length}`, "", ...domains);
  return out.join("\n") + "\n";
}

const MIT_NOTICE = [
  "Permission is hereby granted, free of charge, to any person obtaining a copy",
  "of this software and associated documentation files (the \"Software\"), to deal",
  "in the Software without restriction, including without limitation the rights",
  "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
  "copies of the Software, and to permit persons to whom the Software is",
  "furnished to do so, subject to the following conditions:",
  "",
  "The above copyright notice and this permission notice shall be included in all",
  "copies or substantial portions of the Software.",
  "",
  "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR",
  "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
  "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
  "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
  "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
  "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
  "SOFTWARE.",
];

const licenceRef = (spdx: string): string => `${spdx} (${LICENSE_URLS[spdx] ?? "unknown"})`;

/** blocklist/imports/ATTRIBUTION.md, regenerated from sources.json only. */
export function renderAttribution(decl: Declaration): string {
  const out = [
    "# Attribution for imported blocklist data",
    "",
    "Generated by `tools/import` from `blocklist/imports/sources.json`; do not",
    "edit by hand.",
    "",
    "The Sitr blocklist data (everything under `blocklist/`) and the compiled",
    "list artifacts (`extension/rulesets/`, `apps/shared/blocklists/`) are",
    "licensed under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/,",
    "full text in `blocklist/LICENSE`). They include material from the sources",
    "below, each used under the licence named for it.",
    "",
    "**Changes made by Sitr.** Every source below was modified: filtered,",
    "merged and de-duplicated. Names are lowercased and a leading `www.` is",
    "removed; entries are dropped by the guards described in",
    "`blocklist/policy/inclusion-policy.md` (the counts are in each",
    "`imported.txt` header); what remains is merged with Sitr's curated lists",
    "and the other sources, and de-duplicated. The upstream authors do not",
    "endorse Sitr or its changes.",
    "",
  ];
  for (const s of decl.sources) {
    out.push(
      `## ${s.id}`,
      "",
      `- List: \`${s.target}\``,
      `- Source: ${s.url}`,
      ...(s.homepage !== undefined ? [`- Project: ${s.homepage}`] : []),
      `- Licence: ${licenceRef(s.license)}`,
      "- Modified: yes (filtered, merged and de-duplicated, as above)",
      "",
      s.attribution,
      "",
    );
    if (s.upstreams !== undefined && s.upstreams.length > 0) {
      out.push("Upstream lists merged into this source:", "");
      for (const u of s.upstreams) out.push(`- ${u.name} — ${u.url} (${licenceRef(u.license)})`);
      out.push("");
    }
  }
  if (decl.sources.some((s) => s.license === "MIT" || s.upstreams?.some((u) => u.license === "MIT"))) {
    out.push(
      "## MIT licence terms",
      "",
      "Sources marked MIT above are used under these terms, with the copyright",
      "notice given for each source:",
      "",
      "```",
      ...MIT_NOTICE,
      "```",
      "",
    );
  }
  return out.join("\n");
}
