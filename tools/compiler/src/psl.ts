/**
 * Public Suffix List lookup for the public-suffix guard.
 *
 * The snapshot in ../data/public_suffix_list.dat is checked in (MPL-2.0,
 * from https://publicsuffix.org/list/public_suffix_list.dat) so the build
 * never touches the network and stays reproducible. Both the ICANN and the
 * PRIVATE sections are loaded: a list entry equal to `co.uk` or to
 * `github.io` would block every site under it.
 *
 * To refresh: download the file, update PSL_SNAPSHOT below, rebuild. The
 * compiler refuses a file whose hash does not match the recorded one.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { domainToASCII } from "node:url";

export const PSL_SNAPSHOT = {
  retrieved: "2026-11-18",
  sha256: "809adae1a2cb1621b70165c11e0d14412d3f104f40a4ebed9a99e23c54f78d71",
  url: "https://publicsuffix.org/list/public_suffix_list.dat",
};

export const PSL_PATH = new URL("../data/public_suffix_list.dat", import.meta.url);

export interface PublicSuffixList {
  isPublicSuffix(name: string): boolean;
  /**
   * True when listing `name` would block a whole public suffix: it is one,
   * or a public suffix sits beneath it (`kawasaki.jp` under `*.kawasaki.jp`,
   * `amazonaws.com` above `s3.amazonaws.com`). An exception rule
   * (`!city.kawasaki.jp`) is a registrable domain and passes.
   */
  blocksPublicSuffix(name: string): boolean;
}

/**
 * Parse PSL text. Rule forms: `co.uk` (exact), `*.ck` (every direct child
 * of `ck` is a suffix), `!www.ck` (exception: `www.ck` is NOT a suffix).
 * Rules are normalized to punycode because list entries are punycode.
 */
export function parsePublicSuffixList(text: string): PublicSuffixList {
  const exact = new Set<string>();
  const wildcardParents = new Set<string>();
  const exceptions = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    // The format ends a rule at the first whitespace.
    const rule = raw.trim().split(/\s/)[0] ?? "";
    if (rule === "" || rule.startsWith("//")) continue;
    if (rule.startsWith("!")) exceptions.add(toAscii(rule.slice(1)));
    else if (rule.startsWith("*.")) wildcardParents.add(toAscii(rule.slice(2)));
    else exact.add(toAscii(rule));
  }
  // Every name that has a public suffix strictly beneath it.
  const above = new Set<string>(wildcardParents);
  for (const r of [...exact, ...wildcardParents]) {
    for (let i = r.indexOf("."); i >= 0; i = r.indexOf(".", i + 1)) above.add(r.slice(i + 1));
  }
  const isPublicSuffix = (name: string): boolean => {
    if (exceptions.has(name)) return false;
    if (exact.has(name)) return true;
    const dot = name.indexOf(".");
    return dot > 0 && wildcardParents.has(name.slice(dot + 1));
  };
  return {
    isPublicSuffix,
    blocksPublicSuffix: (name) => isPublicSuffix(name) || above.has(name),
  };
}

function toAscii(rule: string): string {
  // domainToASCII returns "" for input it cannot convert; keep the raw rule
  // then, it simply never matches a validated (ASCII) entry.
  return domainToASCII(rule) || rule.toLowerCase();
}

/** Load the checked-in snapshot, verifying its recorded hash. */
export function loadPublicSuffixList(): PublicSuffixList {
  const bytes = readFileSync(PSL_PATH);
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== PSL_SNAPSHOT.sha256) {
    throw new Error(
      `public_suffix_list.dat hash ${sha} does not match PSL_SNAPSHOT.sha256 in psl.ts — update the recorded hash and date when refreshing the snapshot`,
    );
  }
  return parsePublicSuffixList(bytes.toString("utf8"));
}
