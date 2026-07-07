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

1. Static blocklist rules — priority **1** (block-only, "safe" rules)
2. User per-site block — priority **10** (dynamic)
3. User per-site allow — priority **20** (dynamic; an explicit allow always wins)

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
