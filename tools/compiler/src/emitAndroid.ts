/**
 * Android emitter — domain-set artifacts for the DNS filter engine, plus the
 * DNS-side SafeSearch host map.
 *
 * The domain artifact is deliberately plain text (one registrable domain per
 * line, sorted, LF, trailing newline): it is the parser's output
 * re-serialized, byte-diffable in review, and loads into a HashSet on
 * device. A length-prefixed binary format is the designated escape hatch if
 * lists approach ~100k entries (docs/mobile.md).
 *
 * safesearch-hosts.json is the DNS analogue of safesearch.ts (which stays
 * the source of truth for the browser-side DNR rules): the Android engine
 * answers A/AAAA queries for a matched host with a CNAME to the enforcement
 * target plus the target's addresses, resolved at runtime through the
 * network's own resolver. The published VIP addresses below are a
 * last-resort fallback used only when that lookup fails, so SafeSearch
 * never silently drops out; runtime resolution is primary because vendors
 * can renumber.
 */

/**
 * A `*` suffix in a match pattern stands for one or two trailing DNS labels
 * (Google's ccTLDs: google.de, google.co.uk, …). All other patterns are
 * exact hostname matches. The engine's matcher implements exactly these two
 * forms — nothing else.
 */
export interface SafeSearchMapping {
  match: string[];
  target: string;
  fallback: { a: string[]; aaaa: string[] };
}

export interface SafeSearchHostsMap {
  v: 1;
  rules: SafeSearchMapping[];
}

export function safesearchHostsMap(): SafeSearchHostsMap {
  return {
    v: 1,
    rules: [
      // Google: documented SafeSearch VIP (forcesafesearch.google.com).
      {
        match: ["google.*", "www.google.*"],
        target: "forcesafesearch.google.com",
        fallback: {
          a: ["216.239.38.120"],
          aaaa: ["2001:4860:4802:32::78"],
        },
      },
      // Bing: strict.bing.com enforces SafeSearch strict server-side.
      {
        match: ["bing.com", "www.bing.com"],
        target: "strict.bing.com",
        fallback: { a: ["204.79.197.220"], aaaa: [] },
      },
      // DuckDuckGo: safe.duckduckgo.com. No vendor-documented static IP —
      // runtime resolution only.
      {
        match: ["duckduckgo.com", "www.duckduckgo.com", "start.duckduckgo.com"],
        target: "safe.duckduckgo.com",
        fallback: { a: [], aaaa: [] },
      },
      // YouTube: Restricted Mode via the documented restrict.youtube.com VIP.
      {
        match: [
          "www.youtube.com",
          "m.youtube.com",
          "youtubei.googleapis.com",
          "youtube.googleapis.com",
          "www.youtube-nocookie.com",
        ],
        target: "restrict.youtube.com",
        fallback: {
          a: ["216.239.38.120"],
          aaaa: ["2001:4860:4802:32::78"],
        },
      },
    ],
  };
}

/** One domain per line, sorted (the parser guarantees it), trailing newline. */
export function serializeDomainList(sortedDomains: string[]): string {
  return sortedDomains.join("\n") + "\n";
}

/** Stable JSON serialization: 2-space indent, trailing newline, LF only. */
export function serializeSafesearchHosts(map: SafeSearchHostsMap): string {
  return JSON.stringify(map, null, 2) + "\n";
}
