# Chrome Web Store — permissions justification (pre-written for review)

Single purpose: **filter adult/haram content and enforce SafeSearch.**
Every permission below exists only for that purpose.

## `declarativeNetRequest`

Core of the product. All blocking and SafeSearch enforcement is done by the
browser's DNR engine from static rulesets bundled in the package. The
extension cannot read request or page contents, makes no per-request network
calls, and uses no content scripts.

## `storage`

Stores, locally only (`storage.local`): the current protection status shown
in the popup, and nothing else. The user's per-site allow/deny choices live
as DNR dynamic rules inside the browser. No data of any kind is transmitted.

## `host_permissions`

DNR requires host permissions **only** for rules that redirect requests or
modify headers. We use exactly five hosts, all for SafeSearch enforcement:

| Host pattern | Why |
|---|---|
| `*://*.google.com/*` | Append `safe=active` to Google Search result URLs |
| `*://www.bing.com/*` | Redirect searches to `strict.bing.com` (Bing's SafeSearch-strict host) |
| `*://duckduckgo.com/*` | Append `kp=1` (DuckDuckGo safe search strict) |
| `*://*.youtube.com/*` | Set the documented `YouTube-Restrict: Strict` request header |
| `*://youtubei.googleapis.com/*` | Same header for YouTube's internal API requests |

The bulk blocklist needs **no** host permissions (block-only "safe" DNR rules).

## What we deliberately do NOT request

`tabs`, `webRequest`, `webNavigation`, `history`, `<all_urls>`, content
scripts, `scripting`, `cookies`. The extension has no way to observe browsing
activity, and the blocklist it ships is identical for every user.

## Data collection (data-safety form)

None. No analytics, no telemetry, no ads, no third-party SDKs, no remote
error reporting. The only network request the extension will ever make is
fetching the public, identical-for-all blocklist update — and in the current
version even that is absent (rulesets ship in the package and update by
republishing the extension). Limited Use certification: affirmed.
