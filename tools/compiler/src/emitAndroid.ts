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
 *
 * strict-search-hosts.txt backs the optional Strict Search setting. Safe
 * mode can only be forced where a vendor publishes an endpoint for it
 * (threat-model.md T11); on engines that publish none, the exposure users
 * actually hit is explicit imagery in results, and those thumbnails are
 * served from their own hostnames. Blocking just those hosts suppresses
 * the imagery while text search keeps working — surgical, and it degrades
 * an engine rather than breaking it.
 *
 * These hosts are NOT part of the shared blocklist: a general-purpose
 * search engine fails the inclusion policy's primary-purpose test. They
 * ship as a separate artifact behind a user toggle that is off by default.
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

/**
 * Image/thumbnail hosts suppressed by Strict Search, grouped by the engine
 * they belong to so the app can explain what a toggle actually does.
 *
 * ONLY engines with no vendor safe-mode endpoint are listed. Google, Bing
 * and DuckDuckGo already have SafeSearch forced (safesearchHostsMap
 * above), so blocking their thumbnail hosts adds no filtering — it just
 * breaks image search on the engines people use most. That was the first
 * version of this list and it was visibly too blunt in real use.
 *
 * The trade is deliberate: this setting closes the gap where no other
 * lever exists, and stays out of the way where one already does.
 */
export interface StrictSearchHosts {
  v: 1;
  hosts: Array<{ engine: string; host: string; safeModeAvailable: boolean }>;
}

export function strictSearchHosts(): StrictSearchHosts {
  return {
    v: 1,
    hosts: [
      // No vendor safe-mode endpoint exists for these engines, so their
      // thumbnails are the only lever DNS has.
      { engine: "Brave Search", host: "imgs.search.brave.com", safeModeAvailable: false },
      { engine: "Brave Search", host: "cdn.search.brave.com", safeModeAvailable: false },
      { engine: "Startpage", host: "sp-cdn.startpage.com", safeModeAvailable: false },
      { engine: "Mojeek", host: "www.mojeek.com", safeModeAvailable: false },
      { engine: "Yandex", host: "avatars.mds.yandex.net", safeModeAvailable: false },
    ],
  };
}

/** Stable JSON serialization: 2-space indent, trailing newline, LF only. */
export function serializeStrictSearchHosts(map: StrictSearchHosts): string {
  return JSON.stringify(map, null, 2) + "\n";
}
