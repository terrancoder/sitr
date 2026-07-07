# Sitr data flow

This document lists **every** outbound network request the extension makes,
every field it stores, and every retention period. It is intentionally short.

## Network requests made by the extension

**Current version: none.**

The rulesets ship inside the extension package and update by republishing the
extension through the browser store (MV3 forbids remote code anyway).

If a blocklist-update endpoint is ever added, it will appear here first, and
it will have exactly this shape:

| Endpoint | Method | Request contains | Response | Frequency |
|---|---|---|---|---|
| (none today) | GET | nothing user-specific — no identifiers, no cookies, no query params | the public ruleset, **identical for every user**, checksum-verified before applying | periodic |

Because the artifact is identical for all users, the server cannot learn
which sites any user visits — at most it sees that *someone* at an IP fetched
the list, the same thing any CDN sees.

## Data stored (all local, never transmitted)

| Item | Where | Contains | Retention |
|---|---|---|---|
| Protection status | `storage.local` | `active` / `inactive` + missing ruleset ids | overwritten on every check |
| Category preferences | `storage.local` | which optional categories are disabled | until changed by the user |
| Per-site allow/deny | DNR dynamic rules | domains the user chose | until removed by the user |

## Data transmitted about the user

None. No URLs, no history, no identifiers, no telemetry, no crash reports,
no "anonymized" or "aggregate" usage data. There is no code path that could
transmit any of these — verify by searching the source for `fetch(`.

## Logs

Developer-facing `console` output only, local to the browser. Logs never
contain visited URLs, tokens, or identifiers (enforced as a review rule).
