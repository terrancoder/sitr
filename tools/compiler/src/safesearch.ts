import type { DnrRule } from "./types.js";
import { STATIC_CATEGORY_PRIORITY } from "./compile.js";

/**
 * SafeSearch / YouTube Restricted Mode enforcement ruleset.
 *
 * This is the SOURCE OF TRUTH for the "unsafe" ruleset (redirect +
 * modifyHeaders actions), kept deliberately tiny and isolated from the bulk
 * block rulesets (CLAUDE.md §2). It is compiled to
 * `extension/rulesets/safesearch.json` — never hand-edit the output.
 *
 * All rules operate on URL/header metadata in-browser via DNR, before TLS —
 * no interception, no content access.
 */
export const SAFESEARCH_ID_BASE = 1_000;

const MAIN_FRAME_ONLY = ["main_frame"];

export function safesearchRules(): DnrRule[] {
  return [
    // Google: force safe=active on search result pages.
    {
      id: SAFESEARCH_ID_BASE + 1,
      priority: STATIC_CATEGORY_PRIORITY,
      action: {
        type: "redirect",
        redirect: {
          transform: {
            queryTransform: {
              addOrReplaceParams: [{ key: "safe", value: "active" }],
            },
          },
        },
      },
      condition: {
        urlFilter: "||google.com/search?",
        resourceTypes: MAIN_FRAME_ONLY,
      },
    },
    // Bing: force adlt=strict on search result pages. The former host
    // rewrite to strict.bing.com broke when Bing started bouncing direct
    // HTTPS requests to that host back to its homepage (observed
    // 2026-08-26; the DNS-level strict.bing.com VIP that Android uses is
    // unaffected — it keeps the www.bing.com Host header).
    {
      id: SAFESEARCH_ID_BASE + 2,
      priority: STATIC_CATEGORY_PRIORITY,
      action: {
        type: "redirect",
        redirect: {
          transform: {
            queryTransform: {
              addOrReplaceParams: [{ key: "adlt", value: "strict" }],
            },
          },
        },
      },
      condition: {
        urlFilter: "||www.bing.com/search?",
        resourceTypes: MAIN_FRAME_ONLY,
      },
    },
    // DuckDuckGo: kp=1 = safe search strict.
    {
      id: SAFESEARCH_ID_BASE + 3,
      priority: STATIC_CATEGORY_PRIORITY,
      action: {
        type: "redirect",
        redirect: {
          transform: {
            queryTransform: {
              addOrReplaceParams: [{ key: "kp", value: "1" }],
            },
          },
        },
      },
      condition: {
        urlFilter: "||duckduckgo.com/?",
        resourceTypes: MAIN_FRAME_ONLY,
      },
    },
    // YouTube: Restricted Mode via the documented YouTube-Restrict header.
    {
      id: SAFESEARCH_ID_BASE + 4,
      priority: STATIC_CATEGORY_PRIORITY,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "YouTube-Restrict", operation: "set", value: "Strict" },
        ],
      },
      condition: {
        requestDomains: ["youtube.com", "youtubei.googleapis.com"],
        resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest"],
      },
    },
  ];
}
