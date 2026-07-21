# Sitr architecture

Sitr is a Manifest V3 browser extension. All filtering runs **on-device** via
the browser's `declarativeNetRequest` (DNR) engine. There is no proxy, no VPN,
no certificate installation, and no per-request server call — the browser
itself evaluates URL/header metadata against rulesets bundled in the package.

## Layers

| Layer | Where it runs | Implementation |
|---|---|---|
| Filtering engine | Browser DNR | Static rulesets in `extension/rulesets/` |
| Bulk blocklist | On-device | "Safe" block-only rules, compiled from the public `blocklist/` sources |
| SafeSearch / YouTube | On-device | Separate "unsafe" ruleset: query-param redirects (Google `safe=active`, DuckDuckGo `kp=1`), host redirect (Bing → `strict.bing.com`), and the `YouTube-Restrict: Strict` request header |
| User allow/deny | On-device | DNR **dynamic** rules + `storage.local`; never uploaded |
| Status surfacing | On-device | Service worker verifies rulesets are enabled; anything less than proof renders a red "Protection INACTIVE" badge |

## Why DNR and not a proxy

A network proxy must terminate TLS to filter by URL, which means installing a
root certificate and being *able* to read everything. DNR cannot read request
or response bodies at all — it matches on URL and header metadata inside the
browser, before the network. Choosing DNR **is** the privacy decision: the
architecture is incapable of seeing browsing content, so the privacy claim
doesn't depend on our good behavior.

## Rule priority ladder

Three dynamic layers sit above the static rulesets. Within a layer an
explicit allow wins; a higher layer's block beats a lower layer's allow
(managed > household > device user > static). Implementation:
`extension/src/lib/ruleLayers.ts`.

| Layer | Kind | Dynamic-rule id base | Cap | Priority |
|---|---|---|---|---|
| Static blocklist | block | (compiler ranges) | — | **1** |
| Device user | block | 1,500,000 | 5,000 | **10** |
| Device user | allow | 1,000,000 | 5,000 | **20** |
| Household | block | 2,500,000 | 5,000 | **30** |
| Household | allow | 2,000,000 | 5,000 | **40** |
| Managed (institution) | block | 3,500,000 | 5,000 | **50** |
| Managed (institution) | allow | 3,000,000 | 5,000 | **60** |

The six caps sum to exactly Chrome's 30,000 dynamic-rule ceiling; overflow
is a surfaced error, never truncation.

## Household state and sync (Sitr Family)

Household settings (shared allow/block lists, category config, guardian
PIN hash) are one JSON document with a monotonic `rev` counter, merged
**last-writer-wins** (rev, then timestamp, then device id) — only guardian
devices write, so conflicts are rare and a lost edit is re-enterable.
Vector clocks were deliberately rejected as complexity without a customer.
Sync is optional, E2E-encrypted, and specified in
[sync-protocol.md](sync-protocol.md); a device with no household makes no
network requests at all. Managed (enterprise) policy arrives via the
browser's own `chrome.storage.managed` and is never fetched by us — see
[institutions/deployment.md](institutions/deployment.md).

## Determinism and verification

`tools/compiler` turns `blocklist/sources/*/domains.txt` into DNR JSON
byte-reproducibly (sorted input, fixed batching, fixed ID ranges, stable
serialization). CI compiles twice and diffs, and publishes SHA-256 checksums
(`extension/rulesets/checksums.json`) so anyone can rebuild from the public
sources and confirm the shipped artifact matches.

## DNR limits we design within

~30k guaranteed static rules (we batch ~1,000 domains per rule via
`requestDomains`, so capacity is effectively millions of domains), 30k dynamic
rules (user rules capped at 5,000 per kind with a surfaced error), and the
unsafe ruleset is kept to a handful of hand-reviewed rules.
