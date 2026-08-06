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
in the popup, category preferences, and — when the optional Family
household feature is used — the household's settings and key material. The
user's per-site allow/deny choices live as DNR dynamic rules inside the
browser. `storage.managed` is read so organizations can deliver policy via
the browser's own enterprise mechanism. Browsing data is never stored or
transmitted in any tier.

## `alarms`

Used only to schedule the optional Family household sync (every 30
minutes) when the user has created or joined a household. Devices without
a household schedule nothing.

## `host_permissions`

DNR requires host permissions **only** for rules that redirect requests or
modify headers. We use five hosts for SafeSearch enforcement, plus one for
the optional Family sync endpoint:

| Host pattern | Why |
|---|---|
| `https://sync.sitr.app/*` | Optional Family sync: stores one end-to-end-encrypted settings blob the server cannot read (see docs/sync-protocol.md). Contacted only when the user sets up a household. |
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

No analytics, no telemetry, no ads, no third-party SDKs, no remote error
reporting — in any tier. With no household configured the extension makes
zero network requests (rulesets ship in the package and update by
republishing the extension), so nothing is collected. With the optional
Family household enabled, the only request is the E2E-encrypted settings
blob described above — it contains household settings (never browsing
data) and is unreadable by the server. Because the blob's plaintext
includes the guardian PIN as a salted hash, the data-safety form declares
**Authentication information**; every other category: not collected.
Limited Use certification: affirmed.
