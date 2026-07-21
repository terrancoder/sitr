# Sitr data flow

This document lists **every** outbound network request the extension makes,
every field it stores, and every retention period. It is intentionally short.

## Network requests made by the extension

**Base filtering: none.** Filtering never makes a network request. The
rulesets ship inside the extension package and update by republishing the
extension through the browser store (MV3 forbids remote code anyway).

**Sitr Family sync (opt-in, only when a household exists): exactly one
endpoint.** Full protocol: [sync-protocol.md](sync-protocol.md); server
source: [`server/sync/`](../server/sync/).

| Endpoint | Method | Request contains | Response | Frequency |
|---|---|---|---|---|
| `https://sync.sitr.app/v1/blob/{householdId}` | GET / PUT / DELETE | a random household id, a derived bearer credential, and an **E2E-encrypted blob the server cannot read** — no account, no email, no browsing data, no device identifiers | the same opaque blob (or a version conflict) | on settings change + every 30 minutes while a household is configured |

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

If a blocklist-update endpoint is ever added, it will appear here first,
carry nothing user-specific, and return an artifact **identical for every
user**, checksum-verified before applying.

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

## Data transmitted about the user

None — in every tier. No URLs, no history, no identifiers, no telemetry,
no crash reports, no "anonymized" or "aggregate" usage data. The household
sync blob contains household *settings*, is encrypted on-device, and is
unreadable by the server. There is one `fetch(` call site in the entire
codebase (`extension/src/lib/sync/client.ts`) — verify by searching the
source for `fetch(`.

## Logs

Developer-facing `console` output only, local to the browser. Logs never
contain visited URLs, tokens, or identifiers (enforced as a review rule).
The sync server logs nothing per-request (see
[`server/sync/README.md`](../server/sync/README.md)).
