# Sitr data flow

This document lists **every** outbound network request the extension and
the Sitr apps for iOS and Android make, every field they store, and every
retention period. It is intentionally short.

## Network requests made by Sitr clients

**Base filtering: none.** Filtering never originates a network request. The
rulesets ship inside each client — the extension package and the app
binaries — and update by republishing through the browser or app store
(MV3 forbids remote code anyway).

**Sitr Family sync (opt-in, only when a household exists): exactly one
endpoint.** Full protocol: [sync-protocol.md](sync-protocol.md); server
source: [`server/sync/`](../server/sync/).

| Endpoint | Method | Request contains | Response | Frequency |
|---|---|---|---|---|
| `https://sync.sitrshield.com/v1/blob/{householdId}` | GET / PUT / DELETE | a random household id, a derived bearer credential, and an **E2E-encrypted blob the server cannot read** — no account, no email, no browsing data, no device identifiers | the same opaque blob (or a version conflict) | on settings change + every 30 minutes while a household is configured |

What the operator can learn: that *some* household id synced at some time
from some IP — nothing about its members, devices, or settings, and nothing
about anyone's browsing (which never leaves the device in any tier).
Server-side retention: no request logs; write timestamps rounded to the
day; blobs idle ~18 months deleted; auth credentials stored only hashed;
IP-derived state limited to an in-memory rate limiter cleared hourly.

Devices with no household configured make **zero** network requests, same
as always. If a Family subscription token is saved, household-creation
requests also carry it in the `X-Sitr-Entitlement` header — a signed
credential minted by us that contains an expiry date and **no customer
identity** (see [sync-protocol.md](sync-protocol.md) §Entitlement; the
billing provider never sees household ids or keys, and the server
verifies tokens offline).

**Client platforms.** The table above is complete for all three clients:
the extension, the iOS app, and the Android app talk to the **same single
sync endpoint**, and it is the only endpoint any of them has. Each client
codebase has exactly one HTTP call site — extension:
`extension/src/lib/sync/client.ts`; iOS: the `SyncClient` in SitrCore;
Android: `SyncHttp.kt`. A device with no household configured makes zero
network requests of its own on every platform (the Android engine relays
the device's own DNS lookups to the network's resolvers — next section —
but originates nothing).

### Android DNS engine (on-device only)

The Android app filters by answering DNS queries locally inside a
VpnService. The engine inspects DNS query names **on-device only** to
decide block / allow / rewrite. Allowed queries are forwarded to the
network's own resolvers — the ones the device would use anyway — never to
a Sitr resolver or any third-party resolver. Query names are never sent
to Sitr or anyone else, never logged, and never stored. This is a broader
technical capability than the extension's DNR engine (where the browser
matches rules and extension code never sees a hostname); see
[threat-model.md](threat-model.md) T9 for the analysis.

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
| Per-site allow/deny | DNR dynamic rules | domains the user chose | until removed by the user |
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
| iOS | Keychain | App Group storage (shared with the content blocker extension) |
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
The sync server logs nothing per-request (see
[`server/sync/README.md`](../server/sync/README.md)).
