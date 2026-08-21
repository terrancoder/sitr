# Sitr architecture

Sitr's browser client is a Manifest V3 extension. All filtering runs
**on-device** via the browser's `declarativeNetRequest` (DNR) engine. There
is no proxy, no VPN, no certificate installation, and no per-request server
call — the browser itself evaluates URL/header metadata against rulesets
bundled in the package. The native iOS and Android apps are separate engines
with the same semantics — see [Mobile engines](#mobile-engines) below.

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
doesn't depend on our good behavior. The Android engine deliberately trades
some of that structural purity — a DNS filter must read query names to
filter them — for system-wide coverage; T9 in
[threat-model.md](threat-model.md) states the trade and its structural
mitigations plainly.

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

## Mobile engines

The native apps (`apps/ios/`, `apps/android/`) add no new lists and no new
semantics. They consume the same `blocklist/sources/` through the same
deterministic compiler, via two new emitters: `--safari-out` writes Safari
content-blocker JSON with layer precedence expressed as rule ordering plus
`ignore-previous-rules`; `--android-out` writes plain sorted domain lists
plus the DNS SafeSearch host map. Both are committed to
`apps/shared/blocklists/{safari,android}/` with per-directory SHA-256
checksums and the same compile-twice-and-diff CI check. Blocklists ship
inside the store-reviewed app binaries and update via store releases, same
as the extension; a signed static update endpoint is a documented future
design, not built.

| Engine | Coverage | Mechanism |
|---|---|---|
| Chrome extension | The browser | DNR static + dynamic rules |
| Safari content blocker (iOS) | Safari; WebKit browsers via optional Screen Time | Compiled content-blocker JSON; FamilyControls/ManagedSettings |
| DNS filter (Android) | System-wide | Local `VpnService`, DNS-only tun |

**The portable contract.** The rule priority ladder above is the
cross-platform semantics, not a Chrome detail: managed > household >
device user > static; within a layer an explicit allow wins; a higher
layer's block beats a lower layer's allow. Every engine must reproduce it
— Chrome as DNR dynamic-rule priorities, Safari as rule ordering, Android
as an in-memory decision function evaluated per DNS query. Conformance
fixtures at `apps/shared/fixtures/`, generated from the TypeScript
reference, pin the shared logic (sync crypto, merge, the layer gate) so
the Swift and Kotlin implementations are tested against the same vectors.

**Safari content blocker (iOS).** WebKit compiles the ruleset and
evaluates it in-process, so like DNR the app never sees browsing —
structurally, not by policy. It protects Safari only. Optional Screen
Time integration (FamilyControls/ManagedSettings) extends coverage to
WebKit browsers system-wide — Apple's adult filter plus our deny list —
where `.individual` mode is revocable friction and only `.child` mode via
Family Sharing (parent approval required to revoke) gives real tamper
resistance. SafeSearch is not enforceable on iOS at all; T10 in
[threat-model.md](threat-model.md) states the platform limits.

**DNS filter (Android).** A local `VpnService` where the tun routes only
the synthetic resolver addresses, so exclusively DNS packets can enter it
— the engine structurally cannot see non-DNS traffic, and there is no TLS
interception. Blocked A/AAAA queries are answered NOERROR with
`0.0.0.0`/`::` rather than NXDOMAIN, because NXDOMAIN invites
search-domain retries and, in some clients, secure-DNS fallback, while an
unroutable address ends resolution cleanly and the connection fails
instantly on-device; HTTPS/SVCB (type 65) queries for blocked and
SafeSearch-mapped hosts are answered NODATA so ECH cannot carry the name
past the filter. SafeSearch is enforced by rewriting engine hosts to
their published SafeSearch counterparts, and allowed queries are
forwarded only to the network's own resolvers — never to a Sitr or
third-party resolver. The bypass surface (strict Private DNS, a browser's
own DoH, no lockdown support) is disclosed in T9 of
[threat-model.md](threat-model.md).

## DNR limits we design within

~30k guaranteed static rules (we batch ~1,000 domains per rule via
`requestDomains`, so capacity is effectively millions of domains), 30k dynamic
rules (user rules capped at 5,000 per kind with a surfaced error), and the
unsafe ruleset is kept to a handful of hand-reviewed rules.
