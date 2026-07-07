import type { DnrRule } from "./types.js";

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
      priority: 1,
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
    // Bing: strict.bing.com enforces SafeSearch strict server-side.
    {
      id: SAFESEARCH_ID_BASE + 2,
      priority: 1,
      action: {
        type: "redirect",
        redirect: { transform: { host: "strict.bing.com" } },
      },
      condition: {
        urlFilter: "||www.bing.com/search?",
        resourceTypes: MAIN_FRAME_ONLY,
      },
    },
    // DuckDuckGo: kp=1 = safe search strict.
    {
      id: SAFESEARCH_ID_BASE + 3,
      priority: 1,
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
      priority: 1,
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
