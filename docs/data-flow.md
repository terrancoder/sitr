# Sitr data flow

This document lists **every** outbound network request the extension and
the Sitr apps for iOS and Android make, every field they store, and every
retention period. It is intentionally short.

## Network requests made by Sitr clients

**Base filtering: no request to Sitr or anyone else.** The rulesets ship
inside each client — the extension package and the app binaries — and
update by republishing through the browser or app store (MV3 forbids
remote code anyway). The only traffic filtering adds is in the DNS
filters (Android, and iOS when the user turns it on): they pass the
device's own DNS lookups on to the network's resolvers and look up
SafeSearch hosts there (sections below).

**Sitr Family sync (opt-in, only when a household exists): exactly one
endpoint.** Full protocol: [sync-protocol.md](sync-protocol.md); server
source: [`server/sync/`](../server/sync/).

| Endpoint | Method | Request contains | Response | Frequency |
|---|---|---|---|---|
| `https://sync.sitrshield.com/v1/blob/{householdId}` | GET / PUT (the server also accepts DELETE, but no current client sends it) | a random household id, a derived bearer credential, and an **E2E-encrypted blob the server cannot read** — no account, no email, no browsing data, no device identifiers | the same opaque blob (or a version conflict) | on settings change + periodically while a household is configured: every 30 minutes on the extension (alarm) and Android (WorkManager); on iOS, on app foreground plus a background app refresh task whose earliest start is 30 minutes out, which iOS may delay |

What the operator can learn: that *some* household id synced at some time
from some IP — nothing about its members, devices, or settings, and nothing
about anyone's browsing (which never leaves the device in any tier).
Server-side retention: no request logs; write timestamps rounded to the
day; blobs idle ~18 months deleted; auth credentials stored only hashed;
IP-derived state limited to an in-memory rate limiter cleared hourly.

Devices with no household configured make **zero** sync requests, same
as always (the DNS filters' relaying is described below). If a Family subscription token is saved, household-creation
requests also carry it in the `X-Sitr-Entitlement` header — a signed
credential minted by us that contains an expiry date and **no customer
identity** (see [sync-protocol.md](sync-protocol.md) §Entitlement; the
billing provider never sees household ids or keys, and the server
verifies tokens offline).

**Client platforms.** The table above is complete for all three clients:
the extension, the iOS app, and the Android app talk to the **same single
sync endpoint**, and it is the only endpoint any of them has. Each client
codebase has exactly one HTTP call site — extension:
`extension/src/lib/sync/client.ts`; iOS: the `URLSessionTransport` in
`apps/ios/Sitr/Controllers/SyncScheduler.swift` (SitrCore's `SyncClient`
holds only the protocol logic and a transport protocol, no networking);
Android: `SyncHttp.kt`. All three send only GET and PUT; iOS is
join-only and never deletes the server blob. The Safari build for macOS
runs the extension codebase inside Safari — same file, same single call site, a new runtime
host rather than a new call site (the macOS host app itself has no
network code at all). A device with no household configured contacts no
Sitr server on any platform. The DNS filters (Android, and iOS when
turned on) relay the device's own DNS lookups to the network's resolvers
and look up SafeSearch hosts at those same resolvers (next sections);
they contact nothing else.

### Android DNS engine (on-device only)

The Android app filters by answering DNS queries locally inside a
VpnService. The engine inspects DNS query names **on-device only** to
decide block / allow / rewrite. Allowed queries are forwarded to the
network's own resolvers — the ones the device would use anyway — never to
a Sitr resolver or any third-party resolver. They are forwarded
unencrypted (plain UDP), so Android's automatic encrypted DNS is not used
while Sitr runs. Query names are never sent to Sitr or anyone else, never
logged, and never stored. This is a broader
technical capability than the extension's DNR engine (where the browser
matches rules and extension code never sees a hostname); see
[threat-model.md](threat-model.md) T9 for the analysis.

### iOS DNS filter (optional, on-device only)

The iOS app has an optional DNS filter, off by default. The user turns it
on in the DNS filter screen after Sitr's disclosure; the first time, iOS
then asks for permission to add a VPN configuration, lists the filter
under VPN in Settings, and shows a VPN badge in Control Center while the
filter runs. It is a local packet tunnel (`NEPacketTunnelProvider`,
target `apps/ios/SitrTunnel`, engine in
`apps/ios/SitrCore/Sources/SitrCore/Dns/`) built the same way as the
Android engine above. No remote server is involved.

- **What enters the tunnel: DNS lookups only.** The tunnel routes only
  two synthetic resolver addresses (`10.111.222.1/32` and
  `fd66:f83a:c650::1/128`) and sets them as the device's DNS servers for
  every domain. Packets to any other address never enter it, so it cannot
  see web or app traffic even in principle. A packet to those addresses
  that is not a UDP lookup on port 53 is dropped (a TCP connection
  attempt is refused with a reset).
- **What is decided on the device.** The engine reads the query name and
  type in memory and decides with the lists bundled in the app — the same
  `apps/shared/blocklists/android/` files the Android app uses, verified
  against their checksums at start — with the same settings as the
  Safari blocker, plus the opt-in encrypted-DNS list when switched on,
  and the user's and the household's own lists. The app tells the
  tunnel each time it saves settings (a Darwin notification), and the
  tunnel rebuilds its decision data. A blocked name is answered by the
  tunnel itself: `0.0.0.0` or `::` for A/AAAA, an empty answer for every other record type. An A or
  AAAA lookup of a search engine host in the SafeSearch map gets a CNAME
  to that engine's SafeSearch host plus its addresses (HTTPS, SVCB and
  ANY lookups of those hosts get an empty answer). Firefox's canary name
  `use-application-dns.net` gets an empty answer.
- **What leaves the device.** Every other lookup is forwarded unchanged
  to the resolvers the current network supplies — never to a Sitr
  resolver or any third-party resolver, and there is no fallback
  resolver. Lookups go unencrypted, over UDP port 53; a truncated answer
  is fetched again over TCP port 53 from the same resolver. A reply is
  accepted only from the resolver that was asked and only if it matches
  the query. To build a SafeSearch answer the tunnel itself looks up the
  SafeSearch host's addresses (A and AAAA), likewise unencrypted, at the
  same resolvers and
  reuses a successful answer for 5 minutes; when that fails, or while the
  network's resolvers are not yet known, it uses addresses compiled into
  the app (there are none for DuckDuckGo, whose answer is then the CNAME
  alone).
- **How the resolvers are learned.** With libresolv's `res_ninit` and
  `res_getservers`, a public API that reports the system's DNS servers
  (the system's libresolv, linked directly:
  `apps/ios/SitrCore/Sources/CResolv/CResolv.c`). At start it is read
  before the tunnel's DNS settings are applied. While they are applied,
  `res_ninit` reports only the tunnel's own address, and iOS has no
  supported way to read the network's resolvers, so when the network in
  use changes the tunnel removes its settings, reads `res_ninit` and
  applies them again (at most three tries per network, and at most three
  such windows in any minute). In that window (about half a second, up
  to a few seconds if the new network is slow to announce its DNS server;
  [threat-model.md](threat-model.md) T14)
  iOS sends lookups straight to the network's resolver, as it would
  without Sitr, and they are not filtered. From the network change until
  the new resolvers are read, lookups the tunnel would forward are
  dropped (apps retry), including any already queued, never sent to the
  previous network's resolvers; if three tries find none, they stay
  dropped until the network changes.
- **What is stored: nothing.** No query name is written to storage or
  to a log (the one exception, test names in Debug builds, is below).
  Recent answers are kept in memory for up to 60 seconds (at most 1,024
  of them) so a repeated lookup is answered at once; they are cleared
  when the settings or the network's resolvers change and are gone when
  the tunnel stops. In Release (App Store) builds the tunnel writes
  nothing to disk and nothing to the system log: its diagnostics code is
  compiled out (`#if DEBUG`). Development (Debug) builds write a
  diagnostics file to the app's shared container, for testing on our own
  devices: counts, states, timings, memory use, error messages, the
  network's resolver and gateway addresses and interface names, and the
  decision for a fixed list of ten test names (`ProbeNames` in
  `TunnelDiagnostics.swift`) and for names under the reserved
  `.sitr-probe.test` suffix — no other name (see also Logs).
- **What the app stores about it.** Whether the user turned the filter
  on, in the app's settings on the device. iOS itself keeps the filter's
  VPN configuration ("Sitr DNS filter", server "On this device") in iOS
  Settings; turning the filter off in Sitr keeps that configuration.
- **What Sitr's servers see: nothing.** The DNS filter has no connection
  to any Sitr server; the sync endpoint above is unchanged. The network's
  resolver sees the allowed lookups and the SafeSearch host lookups, as
  it does whenever the device uses it.

How the filter combines with an encrypted-DNS profile or app, or with
iCloud Private Relay, is not yet tested ([threat-model.md](threat-model.md)
T14).

### Android child lock (on-device only)

Guard mode's accessibility service reads the text of the foreground
window, only when it belongs to Settings, an installer, the Play Store
or a system dialog, to match it against a fixed list of screens that would switch
Sitr off (`GuardRules.kt`), and closes a match. The text is checked in
memory and discarded; nothing is stored, logged or sent. It runs only
after a guardian opts in. See [child-lock.md](child-lock.md).

### "Report a site" links (no request)

The "Report a site" links on every platform are ordinary links: they open
a GitHub issue form in the browser, or a message to support@sitrshield.com
in the mail app. The client itself sends nothing, so they are not
endpoints and have no row in the table above. A GitHub issue is public.

If a blocklist-update endpoint is ever added, it will appear here first,
carry nothing user-specific, and return an artifact **identical for every
user**, checksum-verified before applying. The same promise covers the
apps: today their blocklists ship inside the store-reviewed binaries and
update only through store releases.

## Data stored locally

| Item | Where | Contains | Retention |
|---|---|---|---|
| Protection status | `storage.local` | `active` / `inactive` + missing ruleset ids | overwritten on every check |
| Category preferences | `storage.local` | which optional categories are disabled | until changed by the user |
| Media filtering mode | `storage.local` | `off` / `greylist` / `allowlist` — the T12 image+media layer | until changed by the user |
| Opt-in lists | `storage.local` (`enabledOptionalLists`) | which off-by-default lists the user turned on (`sitr_violence`; the Android app and the iOS DNS filter also have the encrypted-DNS hosts list). Device-local: never in the household blob | until changed by the user |
| Wait before loosening | `storage.local` (`loosenDelayMinutes`, `loosenDelayRequest`) | the chosen wait (0, 5, 30, 60, 360 or 1440 minutes) and the time of a pending request — in the apps, a reading of two clocks. Device-local: never in the household blob. All three platforms | until changed or the request ends |
| Per-site allow/deny | DNR dynamic rules | domains the user chose | until removed by the user |
| Image allowlist | DNR dynamic rules | sites whose images stay visible in allowlist-only mode | until removed by the user |
| Household state | `storage.local` + DNR dynamic rules | shared allow/block lists, category config, guardian PIN hash | until the device leaves the household |
| Household root secret | `storage.local` | the key material syncing is derived from — never sent anywhere | until the device leaves the household |
| Guardian PIN | `storage.local` | salted PBKDF2 hash + failed-attempt counter | until changed/removed |
| Sync status | `storage.local` | last sync result, shown on the options page | overwritten each sync |
| Subscription token | `storage.local` | signed entitlement (expiry date only, no identity) | until replaced/removed |
| Managed policy | `storage.managed` (read-only) | the organization's settings, delivered by the browser | controlled by the administrator |

The apps store the same items in platform-native storage, with the same
retention:

| Platform | Household root secret | Everything else |
|---|---|---|
| iOS | Keychain | App Group storage (shared with the content blocker extension and the DNS filter's tunnel) |
| Android | encrypted at rest under an Android Keystore key | app-private preferences |

Managed policy on Android arrives read-only via `RestrictionsManager`
([mobile.md](mobile.md)); there is no managed layer in the iOS app.

## Data transmitted about the user

None — in every tier. No URLs, no history, no identifiers, no telemetry,
no crash reports, no "anonymized" or "aggregate" usage data. The household
sync blob contains household *settings*, is encrypted on-device, and is
unreadable by the server. There is one `fetch(` call site in the entire
extension codebase (`extension/src/lib/sync/client.ts`) — verify by
searching the source for `fetch(`. The apps hold the same line: one HTTP
call site per client codebase (see Client platforms above).

## Logs

Developer-facing `console` output only, local to the browser. Logs never
contain visited URLs, tokens, or identifiers (enforced as a review rule).
The iOS DNS filter logs nothing in Release builds (iOS itself logs its
own VPN connect and disconnect lines). Debug builds write the tunnel's
state changes and the resolver addresses it learned to the device's
system log (subsystem `com.sitrshield.sitr.tunnel`), never a query name.
The sync server logs nothing per-request (see
[`server/sync/README.md`](../server/sync/README.md)).
