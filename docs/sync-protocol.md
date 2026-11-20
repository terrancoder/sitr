# Sitr Family sync protocol (v1)

This is the normative spec for the ONE network endpoint Sitr Family may
contact (`docs/data-flow.md`). It is written so a third party can
reimplement both sides and audit every claim. Server source:
[`server/sync/`](../server/sync/). Client source:
[`extension/src/lib/sync/`](../extension/src/lib/sync/) — the sync client
is the repository's only `fetch(` call site.

## Client platforms

Three clients speak this protocol: the extension, the iOS app
(`apps/ios/`), and the Android app (`apps/android/`). The protocol is
identical for all of them. The native apps implement it from this spec and
are validated against the shared conformance fixtures
(`apps/shared/fixtures/`, generated from the reference TypeScript
implementation). Each client codebase keeps the same
rule: one HTTP call site, the sync client.

## Design goal

The server is a dumb, blind mailbox. It stores one opaque blob per
household and can never read it: encryption keys are derived on devices
from a root secret the server never receives. The operator's honest-server
capabilities are limited to: refusing service, deleting blobs, and serving
stale blobs (detected client-side — see Rollback detection).

## Keys

The guardian device generates a 32-byte random **root secret** at household
creation. It is shared between family devices only via the pairing code
(below); it is never sent anywhere.

All derived values use HKDF-SHA256 with empty salt over the root secret,
differing only in the `info` string:

| Value | info string | length | use |
|---|---|---|---|
| encryption key | `sitr-sync v1 encryption key` | 32 B | AES-256-GCM |
| auth credential | `sitr-sync v1 auth credential` | 32 B | bearer token, sent hex-encoded |
| household id | `sitr-sync v1 household id` | 16 B | URL path, hex-encoded |

The three outputs are cryptographically independent: possession of the id
and the auth credential (all the server ever sees) yields nothing about the
encryption key. The server stores only SHA-256(auth credential), so a
database leak does not leak usable bearer tokens.

## Blob format

```
byte 0        version, 0x01
bytes 1..12   AES-GCM nonce (12 random bytes per write)
bytes 13..    AES-256-GCM ciphertext (16-byte tag included)
```

AAD is the UTF-8 string `sitr-sync v1`. Plaintext is the JSON-serialized
household state (`extension/src/lib/household.ts`), which includes a
monotonic `rev` counter. Maximum blob size: 65 536 bytes.

## Pairing code

`Crockford-Base32( 0x01 ‖ rootSecret(32) ‖ CRC-16/CCITT-FALSE(prefix) )`,
grouped by 4 characters with `-`. Decoding is case-insensitive and maps
the lookalikes O→0, I/L→1. The CRC catches manual-entry typos; it is not a
security mechanism. Possession of the pairing code IS household
membership — treat it like a house key.

The QR codes the mobile apps display (and, on iOS, scan) encode exactly
this canonical pairing-code string. They are a presentation of the same code,
not a protocol change.

## API

Base URL: `https://sync.sitrshield.com`. All requests carry
`Authorization: Bearer <auth credential hex>`. Responses carry
`Cache-Control: no-store`.

| Route | Semantics |
|---|---|
| `GET /v1/blob/{householdId}` | 200 with blob (binary) + `ETag: "<rev>"`; 404 if none; 401 wrong auth |
| `PUT /v1/blob/{householdId}` | body = blob. First PUT creates the row and binds SHA-256(auth) to the id. Requires `If-Match: "<rev>"` of the last seen ETag (or `If-None-Match: *` on create). Only the device that created the household sends that first PUT: a device that joined by pairing code and has not yet received the household (its join placeholder, rev 1 with `updatedAt` 0) writes nothing on 404 and waits for a later sync. 200 with new ETag; 409 on concurrent write; 401 wrong auth; 413 > 64 KiB; 429 rate-limited |
| `DELETE /v1/blob/{householdId}` | removes the row. 204; 401 wrong auth. No current client sends it, and no client can rotate a household's secret; a blob no device writes any more is deleted after about 18 months idle (§What the operator learns) |

The ETag value is an opaque server-side write counter; clients echo it
verbatim. On 409 the client re-pulls, merges (LWW on `rev`), and retries
once.

## Rollback detection

Clients remember the highest household `rev` they have ever decrypted. A
successfully authenticated blob with a LOWER rev than remembered is treated
as a sync error ("server returned an older state"), surfaced in the options
page — never silently applied. This bounds the stale-blob attack to a
denial of freshness, which is already in the operator's power by refusing
service.

## What the operator learns

Per request: a random household id, a hashed credential, an opaque blob,
the request time, and the connection's IP address. Retention rules
(enforced in code, `server/sync/`): no request logging; last-write
timestamps rounded to the day; blobs idle ≥ 18 months are deleted; the
only IP-derived state is an in-memory create-rate limiter cleared hourly.

## Entitlement (Sitr Family subscription)

Version 2 (subscriptions with renewal and expiry) is specified in §Entitlement version 2 (planned) below; it is not yet in effect.

Creating a household on the official server requires a subscription; a
server with no `SITR_ENTITLEMENT_PUBKEY` configured (the default —
self-hosters) accepts every request, so the paid check exists only where
the operator opts in.

- Token format: `sitr-ent-v1.<base64url(payload JSON)>.<base64url(sig)>`,
  payload `{ v: 1, plan: "family", exp: <epoch ms> }`, Ed25519 signature
  over the payload bytes.
- Clients send it as `X-Sitr-Entitlement`. The server verifies the
  signature **offline** (no billing-provider call in the sync path) and
  only on `If-None-Match: *` creation — an expiring subscription never
  cuts off an existing household's sync.
- The token carries no customer identity and is unlinkable to the
  household id, auth credential, and encryption key (which are HKDF
  outputs of a secret the billing flow never sees).

Because the check runs only on creation, only clients that create
households handle tokens. The extension and the Android app accept a
pasted token for household creation. The iOS app is join-only and never
handles tokens: joining an existing household needs none. A joining device
never creates a household: when its first pull answers 404 it writes
nothing, reports that no household exists for the code yet, and tries
again at its next sync, so a mistyped code with a valid checksum creates
nothing on any server. Leaving before the first sync sends nothing either.

**Acquiring a token.** Checkout happens on the website via a merchant of
record (Polar). As designed, the site then calls
`GET /v1/blob`-adjacent endpoint `GET /v1/entitlement/claim/{checkoutId}`
(CORS-restricted to the site's origin, rate-limited per IP). The server
asks the billing provider a single question — "is this checkout paid?" —
and if so returns a freshly minted token. This call is made by the
website, never by any client; every client's endpoint inventory is
unchanged ([data-flow.md](data-flow.md)). What the billing provider knows: that a purchase happened
(name/email/payment, as any merchant of record). What it can never learn:
household ids, keys, settings, devices, or browsing — the token is minted
by us, not them. The claim process has not been deployed in production
so far; buyers' tokens were minted by hand.

**Renewal (future).** Re-claim is designed but not built. The claim
endpoint would answer a different question — "is the subscription behind
this checkout still active?" — and mint a fresh token on each call, so
one claim URL stays usable across a subscription's life. Until then,
renewal tokens come from the manual mint below.

Ops: `server/sync/dist/mint.js --keygen` generates the keypair;
`--plan family` mints tokens manually for support cases (`--days`
defaults to 7; more than 7 needs `--old-style-token`).

## Entitlement version 2 (planned)

> **NOT YET IN EFFECT.** Written 20 November 2026. Nothing in this section
> is built. Until it ships, the section above describes the live system.
> The owner's decisions behind it are in
> `docs/entitlement-v2-proposal-2026-11-20.md`.

Version 2 makes Sitr Family a tracked subscription, sold on the website
(Polar) and in the iOS app (Apple in-app purchase). A household now has an
end date. One device, bound to the subscription, fetches a fresh token
once a month, in a window of about 10 days around the turn of the UTC
month, and the token moves the end date forward. A lapsed household
becomes read-only.

The same rules apply in open mode as before: a server with no
`SITR_ENTITLEMENT_PUBKEY` checks nothing and stores no end date.

### Terms

- **Credential**: the proof of payment a client sends to the claim
  service. Website purchase: Polar's subscription ID, shown to users as
  the **subscription code**. iOS purchase: Apple's signed transaction
  (the StoreKit 2 `jwsRepresentation`).
- **Subscription ID**: Polar's subscription ID (a UUID, compared in
  lower case), or Apple's `originalTransactionId`. It stays the same
  across renewals. On the website it is also the subscription code.
- **Marker**: a keyed hash of the subscription ID (below). The claim
  service stores markers, never subscription IDs.
- **Claim secret**: 32 random bytes that a client generates before its
  first claim for a subscription and keeps with the credential. It is
  sent with every claim. It never goes to the sync server and never into
  the household blob.
- **Binder**: a keyed hash of the claim secret, stored with the marker.
  The first successful claim for a marker sets it; later claims must
  carry the same claim secret. The marker is then **bound** to that claim
  secret.
- **Paid end**: the end of the period paid for. Polar:
  `current_period_end`. Apple: `expiresDate`.
- **Claim key**: a 32-byte secret held only by the claim process
  (`SITR_CLAIM_KEY`). The sync process never has it.
- **`per`**, **`period_end`**, **`exp`**, **`ent_exp`**, **`E`**:
  defined below. A token is **early** while `now < per`.
- `DAY` = 86 400 000 ms. `monthStart(t)` is 00:00 UTC on the first day
  of the UTC month that contains `t`; `nextMonth(t)` is 00:00 UTC on the
  first day of the month after it. `nextDay(t)` is the next 00:00 UTC
  after `t`. All times are epoch milliseconds.

### Token format

```
sitr-ent-v2.<base64url(payload JSON)>.<base64url(Ed25519 signature)>
```

The signature covers the exact payload bytes, as in version 1, and uses
the same key pair. The payload is compact JSON with its keys in this
order:

```json
{"v":2,"plan":"family","term":"year","per":1798761600000,"exp":1801699200000,"jti":"AAAAAAAAAAAAAAAAAAAAAA"}
```

| Key | Value |
|---|---|
| `v` | `2`. A verifier refuses a token whose `v` does not match its prefix. |
| `plan` | `family`, `inst-starter` or `inst-standard` |
| `term` | `month` or `year`: the subscription's billing interval. A yearly subscriber's token is still marked `year`, although it lasts about a month. |
| `per` | epoch ms: the first instant of the period the token covers (00:00 UTC on the 1st of its month; for a Sandbox token, 00:00 UTC of its day). The token is **early** while `now < per`. |
| `exp` | epoch ms. The token is valid while `now < exp`. |
| `jti` | 16 bytes, base64url without padding (22 characters). Derived, not stored (below). |
| `test` | present only on Sandbox tokens, value `true`; then it is the last key |

The token carries no customer identity, no subscription ID and no marker.

`per` is carried, not derived from `exp`, so the sync server does no
calendar arithmetic and the same rule covers month and Sandbox day
periods; it is signed, so it cannot be changed. It follows from
`period_end`, so it does not enter the `jti` derivation. Refinement:
`per` is new.

### The issue period

A claim is allowed only when the subscription is active and its paid end
is still in the future (`paidEnd > now`). The paid end does not shorten
the period.

**Production** (`polar`, `apple`): the issue period is the UTC calendar
month, for every subscription, monthly and yearly alike. A claim in the
last 7 days of a month gets next month's token when the subscription will
still be paid on the 1st, unless the request asks for the current month
(`current: true`, used by a device whose household has lapsed):

```
M          = nextMonth(now)                 -- 00:00 UTC on the 1st of next month
if now ≥ M − 7 × DAY and paidEnd > M and not current:
    per        = M                          -- next month's token (early until M)
    period_end = nextMonth(M)
else:
    per        = monthStart(now)            -- this month's token
    period_end = M
exp        = period_end + 3 × DAY
```

So the renewal window for a month runs from 7 days before it starts to
the 4th, when last month's tokens expire: about 10 days. A claim on 26
November and a claim on 2 December both get the December token, with the
same `period_end` (1 January), the same `exp` (4 January) and, for the
same claim secret, the same `jti`.

**Sandbox** (`apple-sandbox`, `test: true`): the issue period is the UTC
day.

```
per        = nextDay(now) − 1 × DAY         -- 00:00 UTC today
period_end = nextDay(now)
exp        = period_end + 1 hour
```

A Sandbox token is never early, and `current` changes nothing.

A Sandbox token is valid for at most 25 hours (claimed just after
midnight) and at least 1 hour (claimed just before). A reviewer who comes
back on any day gets that day's token, and a test household's device
claims the next day's token from midnight, in the hour before `exp`.

Examples:

- Yearly, claim on 10 November: `period_end` = 1 December, `exp` =
  4 December 00:00 UTC. The bound device claims again from 24 November
  (`E − 10 days`) and gets the December token.
- Yearly, claim on 26 November: the December token, `exp` 4 January.
- Monthly, renewal day the 15th, claim on 26 November: paid end
  15 December is after 1 December, so the December token, `exp`
  4 January. The renewal on 15 December needs no new token.
- Monthly, renewal day the 2nd, claim on 26 November: paid end 2 December
  is after 1 December, so the December token, `exp` 4 January. If the
  renewal on 2 December fails, the household still runs to 4 January.
- Monthly, renewal day the 28th, claim on 25 November: paid end
  28 November is not after 1 December, so the November token again
  (`exp` 4 December, the token the device already has). The device tries
  again daily; after the renewal on 28 November (paid end 28 December) it
  gets the December token.
- Purchase on 20 November: the November token, `exp` 4 December; the
  window for December opens on 24 November.
- Purchase on 27 November: the December token at once, `exp` 4 January.
  It is early until 1 December, which does not stop it creating a
  household.
- Household lapsed since 4 December, bound device back on 26 December:
  a claim with `current: true` gets the December token (`exp` 4 January),
  which reopens the household at once; the plain claim that follows gets
  the January token, early, which extends the now open household to
  4 February.
- Sandbox, claim at 15:00 on 20 November: `exp` = 21 November 01:00 UTC.

Consequences, stated plainly:

- Every non-test household that renewed for a month has the same
  `ent_exp`: 00:00 UTC on the 4th of the month after. The date no longer
  points to a subscription (§What version 2 lets the operator learn says
  what still can).
- A cancelled, lapsed or refunded subscription keeps its household until
  the 4th of the month after the one its paid end falls in (paid end
  exactly on a 1st at 00:00 counts as the month before). Worst case: a
  paid end just after 00:00 UTC on the 1st of a 31-day month, for example
  1 December 00:01, still gets the December token in the last week of
  November, so the household runs to 4 January: about 34 days of service
  that was not paid for. A paid end near the end of a month gives 3 to 4
  days; on average about 18 days.
- Everyone renews in the same window, so clients spread their claims
  over 5 days (§What each client must do).

`exp` depends only on `period_end`, so every claim that gets the same
month's token gets the same `exp`, whether it was made in the last week
before the month or in its first days.

### Derived values

`‖` is concatenation, labels are ASCII, `0x00` is one zero byte, and
`period_end` and `exp` are 8-byte big-endian integers.

```
marker = HMAC-SHA-256(claim key, "sitr-claim v2 marker" ‖ 0x00 ‖ source ‖ 0x00 ‖ subscription ID)
binder = HMAC-SHA-256(claim key, "sitr-claim v2 binder" ‖ 0x00 ‖ marker ‖ claim secret)
jti    = first 16 bytes of
         HMAC-SHA-256(claim key, "sitr-claim v2 jti"    ‖ 0x00 ‖ marker ‖ period_end ‖ exp ‖ claim secret)
```

`source` is `polar`, `apple` or `apple-sandbox`, so a Sandbox
transaction can never share a marker with a production one.

**Re-issue without storing the token.** Every claim with the same claim
secret in the same period yields the same `jti` and the same `exp`;
Ed25519 signatures are deterministic, so the token is byte-identical
unless `plan` or `term` changed in between. Either way the sync server
accepts only one token with that `jti`. A retry is therefore safe, and
two devices that share a claim secret (iOS devices through iCloud
Keychain) get the same token.

**Why the `jti` joins nothing.** The `jti` is an HMAC output under a key
the sync process does not hold, so to the sync server it is a random
value. The claim service could recompute a `jti` only with the claim
secret, and it stores only the binder, from which the claim secret (256
random bits) cannot be recovered. So neither database, nor both together
with the claim key, can link a used `jti` to a marker through the `jti`.
Dates do not link them either: every production token of a month has the
same `exp`. What remains is time and requests: an operator who watches
both databases over time, or logs requests, can match events (see §What
version 2 lets the operator learn).

### Claim API

The claim process (`claim-server.ts`) serves these routes on its own
hostname, `https://claim.sitrshield.com`. The sync host never receives a
claim request. Every response carries `Cache-Control: no-store`.

**Two services.** Production runs on Railway, which has no path routing
between services, so the claim process is its own Railway service with
its own volume (its SQLite file) and its own hostname, beside the sync
service with its volume. The two share no key, table or file. The sync
service's variables hold at most the entitlement public key: never the
private key, the claim key, or any Polar or Apple setting, and none of
these is a project-wide shared variable. The deployment steps are in
§Owner's operating rules.

| Route | Called by |
|---|---|
| `POST /v1/entitlement/claim` | clients (extension, Android, iOS); a page on the website for Institutions |
| `GET /v1/entitlement/subscription/{checkoutId}` | the website's welcome page: exchanges a checkout ID for the subscription code |
| `POST /v1/entitlement/apple/notifications` | Apple (App Store Server Notifications V2) |
| `POST /v1/entitlement/polar/webhook` | Polar (optional, not built first) |
| `GET /v1/entitlement/claim/{checkoutId}` | the website: version 1, with the limits in §Transition and cut-over, removed at the cut-over |

#### `POST /v1/entitlement/claim`

Request: a JSON body, at most 16 KiB. The `Content-Type` header is not
checked, and unknown fields are ignored.

```json
{
  "source": "polar",
  "credential": "<subscription code>",
  "claim_secret": "<32 random bytes, base64url, 43 characters>",
  "replace": false,
  "current": false
}
```

- `source`: `polar` or `apple`.
- `credential`: for `polar`, the subscription code, a UUID of any
  version in its canonical 36-character form (any case; lower-cased before use); for
  `apple`, the compact JWS of the signed transaction.
- `claim_secret`: the client's claim secret for this subscription, the
  same value every month.
- `replace`: optional, default `false`. See the replacement rule.
- `current`: optional, default `false`. `true` asks for the current
  month's token even in the last 7 days of a month (§The issue period).
  A client sends it when its household is lapsed. The binding and
  determinism rules are the same: the current month's token for a claim
  secret is the same token whether asked for with `current` or by a plain
  claim earlier in that month.

The request carries no household ID, no auth credential and no other
device identifier. The claim secret is stable, so it links a device's
monthly claims to each other; the subscription ID already does that.

Success: `200`, `Content-Type: application/json`, body
`{"token":"sitr-ent-v2.…"}`. The client reads `plan`, `term`, `exp` and
`test` from the payload; it does not need to check the signature.

Errors: `Content-Type: application/json`, body `{"error":"<reason>"}`,
plus `retry_after` (epoch ms) on `replacement-used`. Clients show their
own text for each reason.

| Status | `error` | Meaning |
|---|---|---|
| 400 | `bad-request` | not JSON, a field missing or malformed, claim secret not 32 bytes |
| 404 | `not-found` | no such route |
| 404 | `unknown-code` | Polar knows no such subscription |
| 405 | `method-not-allowed` | |
| 402 | `payment-pending` | Polar subscription is `past_due` (a renewal is being retried) |
| 402 | `inactive` | the subscription is not active, or the paid end has passed |
| 402 | `revoked` | the purchase was refunded or revoked (`revocationDate`, or the receipt's transaction is in `revoked_transactions`) |
| 409 | `bound-to-other-device` | the marker is bound to another claim secret, and `replace` is `false` |
| 409 | `replacement-used` | `replace: true`, but a replacement was made less than `SITR_REPLACEMENT_DAYS` (default 180) days ago |
| 413 | `too-large` | body over 16 KiB |
| 422 | `invalid-receipt` | the JWS fails verification, or its bundle ID is not ours |
| 422 | `wrong-product` | a present product that is not in the configured list, or whose interval disagrees with the list |
| 422 | `test-purchase` | Xcode or local-testing receipt (always), or Sandbox receipt while Sandbox is off |
| 422 | `family-sharing` | `inAppOwnershipType` is not `PURCHASED` |
| 429 | `slow-down` | per-IP or per-marker limit reached |
| 502 | `billing-unavailable` | Polar did not answer, or answered with an error |
| 503 | `claims-disabled` | signing key, claim key or database missing, or the source's configuration missing |
| 500 | (empty) | a fault of the Apple verifier itself; one log line without request data |

Order of checks: route and method; `503` if the signing key, the claim
key or the database is missing; the per-IP limit; size and JSON; `503`
if the chosen source's configuration is missing; the credential (by
source, below); the per-marker limit; the receipt's transaction
revocation (Apple only); then the
binding rules. The per-marker limit applies to every source, and the
transaction revocation check to every Apple source, Sandbox included. A failed check stores nothing.

The binding rules run in one SQLite write transaction. `BEGIN IMMEDIATE`
makes the read and the write of the binding one step even if a second
process opens the database; with the single claim process this design
requires, it is defence in depth. Tests show that a held write lock
refuses a second binder and that a committed binding is seen by another
connection; they cannot show the interleaving itself.

**Binding rules** (production sources). With `period_end`, `exp` and
`binder` computed, and the marker's row read (it may not exist). The
binding is **stale** when the row has a binder but `last_period_end +
3 × DAY ≤ now`: the newest token the bound claim secret got has expired,
so it missed the whole renewal window.

1. No row, no binder, or a stale binding: set `binder`, set
   `last_period_end = period_end`, and issue. `replace` is ignored and
   uses up nothing.
2. The stored binder equals `binder`: set `last_period_end =
   max(last_period_end, period_end)` and issue. `replace` is ignored.
   (A claim on the 26th and another on the 2nd store the same value.)
3. The stored binder differs and is not stale:
   - `replace` is `false`: `409 bound-to-other-device`.
   - `replace` is `true` and `replaced_day` is NULL or at least `R` days
     ago (`R` = `SITR_REPLACEMENT_DAYS`, default 180): rebind (set
     `binder`, `replaced_day` = today as a UTC day number,
     `last_period_end = period_end`) and issue. This is the
     **replacement rule**: at most one rebind per marker in any `R`
     days. It yields the token the period rule gives at that moment
     (this month's, or next month's in the last 7 days unless `current`
     is set), even if the old claim secret already got the same month's
     token.
   - otherwise `409 replacement-used`, with `retry_after` =
     `(replaced_day + R) × DAY`.

**Sandbox** (`apple-sandbox`, which covers every accepted environment
other than `Production`): the binding rules do not apply. Every claim
with a valid receipt from such an environment is issued, and no binder,
`last_period_end` or `replaced_day` is stored. App Review uses several
devices on several days, and a binding would lock the second one out.
Each claim secret still gets one token per day.

**Not an oracle.** The endpoint answers only what a holder of the
credential needs. An Apple JWS can be checked offline by anyone with
Apple's public root certificate, so the service reveals nothing new
about it. A Polar subscription ID is a UUID; the service accepts any
version and does not rely on how many of its bits are random (a
version 4 UUID has 122, a time-based one fewer and partly predictable).
Guessing one is slowed only by the per-IP limit, and a guessed ID
still meets the binding: once the buyer has claimed, it gets
`bound-to-other-device`, not a token. The answers
(`unknown-code`, `inactive`) say no more than version 1's answers about
a checkout. An error never names the
plan, the term or the paid end. `bound-to-other-device` tells a
credential holder that another device renews this subscription, which a
holder must know.

**Rate limits.** In memory, cleared every hour, as today. Per
SHA-256(IP): `SITR_CLAIM_PER_IP_HOUR` (default 60 an hour), shared by
the version 1 and version 2 routes. It replaces today's reuse of the
create limit (20 an hour) for claims, because every subscriber now claims
in the same window each month, and many households can sit behind one
carrier NAT address. Per marker: 10 issued claims an hour (a claim that
binds, matches or rebinds, and every Sandbox claim). Refused claims
(`bound-to-other-device`, `replacement-used`, `revoked`) do not count per
marker; the per-IP limit bounds them. So a holder of the code without the
claim secret cannot use up the bound device's allowance. What remains:
each refused website claim still costs one call to Polar, bounded only
per IP, so an attacker with many addresses could push the organisation's
Polar allowance towards its limit and cause `billing-unavailable` for
everyone for as long as they keep it up. Apple refusals cost no outbound
call. Sizing: with first attempts spread evenly over
5 days, 10 000 subscribers make about 85 claims an hour (one every 43
seconds), plus one retry a day from monthly subscribers whose renewal
day falls in the last week. A website claim makes one Polar call. Polar
allows 500 requests a minute per organisation; even if all 10 000 claimed
in one hour, that is about 170 a minute. The exchange route makes one
call and the version 1 route two, both rare. Refinement: both limits are
new.

#### Polar verification (`source: "polar"`)

One call. Every Polar request from the claim service carries the
organisation token and `Polar-Version: 2026-10` (a constant in the code,
changed only together with a review of the fields below), with a 10 s
timeout.

1. `GET {SITR_POLAR_API}/v1/subscriptions/{credential}`. `404` →
   `unknown-code`; any other failure → `billing-unavailable`.
2. Read only `status`, `product_id`, `recurring_interval` and
   `current_period_end`. A body that is not JSON → `billing-unavailable`
   (as any other failure). A JSON value that is not an object, or an
   object in which `status`, `product_id`, `recurring_interval` or
   `current_period_end` is missing or of the wrong type, → `inactive`.
   `past_due` → `payment-pending`. Any other status than `active` →
   `inactive`. `product_id` not in `SITR_POLAR_PRODUCTS`
   → `wrong-product`. `recurring_interval` ≠ the configured `term` →
   `wrong-product` (this catches a configuration mistake).
   `current_period_end` ≤ `now` → `inactive`.
3. Subscription ID = the credential in lower case; `paidEnd` =
   `current_period_end`; `plan` and `term` from `SITR_POLAR_PRODUCTS`.

Polar's answers also carry the buyer's email, name, address and IP
address. The service parses each answer into the allow-listed fields
above and drops the rest at once. It never logs a request or response
body, and it reads `customer_id` from no answer.

Why the subscription ID and not the checkout ID: Polar documents the
subscription ID as a UUID that the customer can read through Polar's
customer portal API and that is never placed in a URL, while nothing
guarantees that a checkout stays readable for the life of a
subscription. A subscription ID is not presented by Polar as a secret:
it reaches every webhook consumer of the organisation and anyone holding
the organisation token. What a holder can do with it, and how the binding
limits that, is in [threat-model.md](threat-model.md) T15.

#### `GET /v1/entitlement/subscription/{checkoutId}`

The welcome page calls it after checkout to show the subscription code.
`checkoutId` matches `[A-Za-z0-9_-]{1,128}`, as in version 1.

1. Per-IP limit (`SITR_CLAIM_PER_IP_HOUR`, shared with the claim routes).
2. `GET {SITR_POLAR_API}/v1/checkouts/{checkoutId}`. Read only `status`
   and `subscription_id`. `404` → `unknown-checkout`; any other failure
   → `billing-unavailable`. `status` ≠ `succeeded` → `not-paid`.
   Refinement: version 1 also accepts `confirmed`; this route does not.
   No `subscription_id` → `not-a-subscription`.
3. `200`, `{"code":"<subscription ID, lower case>"}`.

It stores nothing. Its `503` needs only the Polar token to be missing.
Responses carry `Cache-Control: no-store` and the same CORS headers as
version 1 (`GET, OPTIONS` from the site's origin).
Errors are JSON `{"error":"<reason>"}`: `404 not-found`, `405
method-not-allowed`, `404 unknown-checkout`, `402 not-paid`, `422
not-a-subscription`, `429 slow-down`, `502 billing-unavailable`, `503
claims-disabled`.

What it reveals, and to whom: to anyone who holds a checkout ID, that
checkout's subscription ID. The checkout ID is in the buyer's own
welcome-page URL, so in practice that is the buyer, or anyone the URL
leaks to (browser history, a shared link). Such a person gets the
subscription code and with it what T15 describes for a holder of the
code; the binding stops them once the buyer has claimed.

A subscription cancelled at the period's end stays `active` until then,
so it can claim until its paid end. Its last token runs to the end of
that month plus 3 days.

#### Apple verification (`source: "apple"`)

All offline; the service calls nobody. It uses the Node standard library
only (`node:crypto`), so the server keeps zero runtime dependencies.
Apple's library `@apple/app-store-server-library` is used only in
development, as the reference that the tests compare results against.

The pinned root is Apple Root CA - G3: the certificate file, downloaded
from Apple's certificate authority page, is kept in the repository and
its SHA-256 fingerprint is a constant in the code. A person compares
that fingerprint with the value on Apple's page before the first
deployment (§Owner's operating rules).
The verifier does not read that constant itself: it takes a **trust
anchor** (the root fingerprint and the two extension OIDs it requires in
steps 6 and 10) and the set of accepted environments as constructor
arguments. See §How this is tested before Apple's setup exists.

Every failure in steps 1 to 11 → `invalid-receipt`, and nothing is
stored. A fault of the verifier itself, as opposed to a receipt that
fails a check, is a `500` with one log line that holds no request data.
(The notification route answers `500` the same way.)

1. The credential is three base64url parts separated by dots: header,
   payload, signature. Decode the header as JSON.
2. `header.alg` is exactly `ES256`.
3. `header.x5c` is an array of exactly 3 strings (leaf, intermediate,
   root). Each is standard base64 (not base64url) of a DER certificate
   and parses with `new X509Certificate(der)`.
4. Decode the payload as JSON and read `signedDate` (epoch ms), a number.
   Nothing else in the payload is trusted before step 11.
5. Each of the three certificates is valid at `signedDate`: `validFrom ≤
   signedDate ≤ validTo`.
6. The root's `fingerprint256` equals the pinned fingerprint.
7. `intermediate.checkIssued(root)` is true and
   `intermediate.verify(root.publicKey)` is true.
8. `leaf.checkIssued(intermediate)` is true and
   `leaf.verify(intermediate.publicKey)` is true.
9. `intermediate.ca` is true and `leaf.ca` is false.
10. The leaf carries the extension `1.2.840.113635.100.6.11.1` (DER `06 0A
    2A 86 48 86 F7 63 64 06 0B 01`) and the intermediate carries
    `1.2.840.113635.100.6.2.1` (DER `06 0A 2A 86 48 86 F7 63 64 06 02
    01`). `X509Certificate` does not list extensions, so a small DER
    reader walks TBSCertificate → `[3]` extensions → each `extnID` and
    compares it. A byte search over the whole certificate is not enough.
11. The leaf's public key is EC P-256
    (`asymmetricKeyDetails.namedCurve === "prime256v1"`), the signature
    decodes to 64 bytes, and `crypto.verify("sha256", <header part> "."
    <payload part> as ASCII bytes, { key: leaf.publicKey, dsaEncoding:
    "ieee-p1363" }, signature)` is true.

Certificates are not checked for revocation (OCSP is an online check).
Apple's library does the same when its online checks are off.

Then the payload rules:

12. Read only `bundleId`, `environment`, `productId`,
    `originalTransactionId`, `transactionId`, `expiresDate`,
    `revocationDate`, `inAppOwnershipType` and `signedDate`.
    `transactionId` is read only to compute its keyed hash for the refund
    check; it is never stored raw and never logged; missing →
    `invalid-receipt`. Everything else in the payload is ignored and never
    stored, including the storefront country, the price and any
    device-verification value.
13. `bundleId` ≠ `SITR_APPLE_BUNDLE_ID` → `invalid-receipt`.
14. `environment` must be in the verifier's accepted set, else
    `test-purchase`. Production accepts `Production`, plus `Sandbox` when
    `SITR_APPLE_SANDBOX=1`, never `Xcode` or local testing. Any accepted
    environment other than `Production` is treated like Sandbox: the
    token gets `test: true`, the source label `apple-sandbox`, the Sandbox
    issue period and no binding. (The local test server accepts `Xcode`
    this way; §How this is tested.) The exact environment strings are to
    confirm.
15. `productId` not in `SITR_APPLE_PRODUCTS` → `wrong-product`.
16. `inAppOwnershipType` ≠ `PURCHASED` → `family-sharing`. Family Sharing
    and multiseat are off for both products.
17. `revocationDate` present → `revoked`.
18. `expiresDate` not a number, or `expiresDate` ≤ `now` → `inactive`.
    How Apple marks a transaction
    that an upgrade replaced is to confirm; such a transaction
    is refused as `inactive`.
19. Subscription ID = `originalTransactionId` (missing →
    `invalid-receipt`); `paidEnd` = `expiresDate`; `plan` and `term` from
    `SITR_APPLE_PRODUCTS`.

The iOS app never sets `appAccountToken`, which would put a stable
account ID into every transaction.

#### Revocation

The claim database's `revoked_transactions` table blocks replay of a
receipt whose purchase was refunded or revoked: such a receipt has no
`revocationDate` and may still have a future `expiresDate`. Each row is
`tx_hash = HMAC-SHA-256(claim key, "sitr-claim v2 revoked transaction" ‖
0x00 ‖ source ‖ 0x00 ‖ transactionId)`, where `source` is `apple` or
`apple-sandbox`, that transaction's `expiresDate`, the `signedDate` of
the newest refund or reversal notice for it, and whether that notice
was a refund. A claim whose receipt's `transactionId` hash is in the
table as refunded is refused with `revoked`. A refund blocks only the refunded transaction: a later
renewal, or a new purchase on the same subscription, is a different
transaction and passes. (An earlier design kept a revocation date on the
marker; it could lock a buyer out of a later, shorter purchase after a
refunded long one, and one `REFUND_REVERSED` could lift another
transaction's block.)

**`POST /v1/entitlement/apple/notifications`.** Body
`{"signedPayload":"<JWS>"}`, at most 64 KiB. Wrong method → `405`;
missing configuration (bundle ID) → `503`. The service verifies the JWS
with steps 1 to 11; a `bundleId` that is not ours → `400`; an environment
the verifier does not accept → `200` and nothing stored.

- `REFUND`, `REVOKE` or `REFUND_REVERSED`: it verifies
  `data.signedTransactionInfo` the same way and writes the hash of its
  `transactionId` with its `expiresDate` (keeping the later `expiresDate`
  if the row exists). The notice with the later `signedDate` (the
  notification's own) decides whether the transaction is refunded or
  reversed, whichever arrives first; on equal dates the reversal does.
  A reversal touches that transaction's row only. Notifications create
  no marker rows.
- Every other type (`DID_RENEW`, `EXPIRED`, `DID_FAIL_TO_RENEW`, …):
  `200`, nothing stored.

Responses, all with an empty body: `200` for every verified
notification; `400` only when verification fails (including a bundle ID
that is not ours), storing nothing. A verified notification whose signed
transaction has no `transactionId` or no numeric `expiresDate` is
answered `200` and stores nothing; such a receipt is
refused at claim time anyway. Other answers: `405`, `413` over 64 KiB,
`429` over the limit, `503` when not configured. The service stores nothing from a notification
but that hash, the expiry, the notice's `signedDate` and the refunded or
reversed state, not even the notification ID; the handling is
idempotent. The URL is set in App Store Connect and needs no
API key. An in-memory per-IP-hash limit (600 an hour) bounds the cost of
junk requests.

If a notification never arrives, an old receipt of the refunded period
can still be claimed until its `expiresDate`: up to about a month for a
monthly subscription, up to the end of the year paid for a yearly one.
The binding narrows this: only the bound claim secret, or a rebind, can
use it. Apple retries failed deliveries (the schedule is to confirm).
Version 2 has no other defence; asking Apple's server API would need an
API key, which this design avoids.

**`POST /v1/entitlement/polar/webhook` (optional).** Verifies the
Standard Webhooks signature with `SITR_POLAR_WEBHOOK_SECRET` (`400`,
empty body, when it fails), answers `200` and stores nothing. It is not
built: revocation is kept per Apple transaction only, and every Polar
claim reads the live status, so a revoked Polar subscription, which is
not `active`, gets no token without any stored record.

### Stored data

**Claim service.** Its own SQLite file (`SITR_CLAIM_DB`), opened only by
the claim process. It shares no table, file or key with the sync
database.

```sql
CREATE TABLE markers (
  marker          BLOB    PRIMARY KEY,  -- 32 bytes
  binder          BLOB,                 -- 32 bytes, or NULL (no claim yet, or Sandbox)
  last_period_end INTEGER,              -- epoch ms of the last period claimed for, or NULL
  replaced_day    INTEGER               -- UTC day number of the last rebind, or NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE revoked_transactions (
  tx_hash     BLOB    PRIMARY KEY,  -- HMAC of source and transactionId (§Revocation)
  exp         INTEGER NOT NULL,     -- that transaction's expiresDate
  notice_date INTEGER NOT NULL,     -- signedDate of the newest refund or reversal notice
  revoked     INTEGER NOT NULL      -- 1 refunded or revoked, 0 reversed
) STRICT, WITHOUT ROWID;

-- transition only (§Transition and cut-over); emptied by the first prune
-- (hourly and at start-up) on or after the cut-over date
CREATE TABLE v1_claims (
  checkout_hash BLOB    PRIMARY KEY,  -- HMAC-SHA-256(claim key, "sitr-claim v1 checkout" ‖ 0x00 ‖ checkout ID)
  exp           INTEGER NOT NULL      -- the exp of the version 1 token issued for it
) STRICT, WITHOUT ROWID;
```

There is no per-period table. The binder replaces it: the bound claim
secret always gets the same token in a period, so nothing per period
needs remembering. Refinement: the brief's per-period row with a nonce
hash is dropped.

Pruned every hour:

- a `markers` row once its binding is absent or stale (`last_period_end +
  3 × DAY ≤ now`) and `replaced_day` is NULL or at least `R` days ago;
- a `revoked_transactions` row once `exp ≤ now`.

So the service holds, per subscription that renews, one row: its marker,
binder and `last_period_end` (the same value for every subscription that
claimed for the same month), and a rebind day for up to `R` days. A
subscription that stops renewing loses its row once its newest token has
expired (the 4th of a month), unless a recent rebind keeps it. For each
refunded or revoked Apple transaction (and each reversed one) it holds a
keyed hash, the transaction's expiry, the date of the newest refund or
reversal notice and which of the two it was, until that expiry. Until the cut-over it also holds
one row per checkout redeemed on the version 1 route. It stores no
token, no `jti`, no claim secret, no subscription ID, no transaction ID,
no checkout ID, no product, no name, no email and no IP address. `WITHOUT ROWID` keeps rows in key
order, not in the order they were written.

**Sync server.** Two new columns and one new table:

```sql
ALTER TABLE blobs ADD COLUMN ent_exp INTEGER;          -- epoch ms; NULL = legacy household, or open mode
ALTER TABLE blobs ADD COLUMN test_delete_day INTEGER;  -- UTC day number; NULL = not a test household

CREATE TABLE used_tokens (
  token_hash BLOB    PRIMARY KEY,  -- version 2: SHA-256 of the 16 jti bytes;
                                   -- version 1: SHA-256 of the payload bytes
  exp        INTEGER NOT NULL      -- the token's exp
) STRICT, WITHOUT ROWID;
```

`used_tokens` has no household ID. Its rows are pruned every hour once
`exp < now`; by then the token is refused as expired anyway. A version 1
token has no `jti`; its payload (`v`, `plan`, `exp`) stands in for one.

### Sync-server rules

Configuration: `SITR_V1_CUTOVER`, an ISO date (UTC midnight), unset until
the owner sets the cut-over date.

**Effective end.** For a household, `E = ent_exp`, or, when `ent_exp` is
NULL, the cut-over date, or, with no cut-over date set, no end. A
household is **lapsed** when `E ≤ now`.

**Usable token.** The `X-Sitr-Entitlement` header holds a usable version 2
token when all of these hold: prefix `sitr-ent-v2`, three parts, the
signature verifies, the payload parses with `v: 2` and valid fields
(`per` a UTC midnight, `per < exp`), `exp > now`, `plan` is `family`, and
SHA-256(`jti`) is not in `used_tokens`. A usable token may be early
(`now < per`).

**Verifying a token.** The verifier ignores unknown payload keys and the
order of keys; only the signer fixes the order (§Token format). A version
1 token's `plan` is not checked, as today. Any token is expired when
`exp ≤ now`.

**Create** (`PUT` to an ID with no row, with `If-None-Match: *`, or in
enforcing mode also with `If-Match`; the latter is also a fix in the live
version 1 code). Only a device that created the household sends it; a
joining device never creates one (§API):

- A usable token, early or not: in one transaction, insert the household
  with `ent_exp = exp`, set `test_delete_day = today + 7` when the token
  has `test: true`, and insert the `jti` hash into `used_tokens`. `201`.
  An early token may create, so a buyer in the last week of a month can
  start at once.
- A valid version 1 token before the cut-over date: create as today,
  with `ent_exp` NULL (a **legacy household**). The sync server tells
  old and new version 1 tokens apart with no new data, by how far away
  the token's `exp` is when it is used:
  - `exp − now > 8 × DAY`: an **old** token, minted before deployment
    with today's 366-day lifetime. Accepted as today, as often as today,
    until the cut-over (owner's decision D3). Nothing is recorded.
  - `exp − now ≤ 8 × DAY`: a **new** token, minted after deployment with
    the 7-day redeem deadline. Single-use: refused with `token-used` if
    its payload hash is in `used_tokens`; otherwise the household is
    created and the hash inserted with the token's `exp`, in one
    transaction. An old token in its own last 8 days falls under this
    rule too: its first use there is recorded and later uses are
    refused.
  Tokens minted by hand after deployment use the ops CLI `mint.js`,
  whose `--days` defaults to 7; more than 7 needs the explicit flag
  `--old-style-token`, because such a token counts as old and creates any
  number of legacy households until the cut-over.
- Otherwise `402`, with the reason of the first check in this table
  that fails (so a used new version 1 token after the cut-over answers
  `token-used`):

| Reason | When |
|---|---|
| `token-required` | no header, or empty |
| `token-invalid` | bad format, bad signature, wrong `v`, bad field |
| `token-expired` | `exp ≤ now` |
| `plan-not-accepted` | an Institutions token |
| `token-used` | the `jti` (version 2) or the payload hash (new version 1 token) is in `used_tokens` |
| `v1-ended` | a version 1 token on or after the cut-over date |

The per-IP create limit is charged only for a request that creates a
row, after the token check, whichever precondition header it carries, in
open mode too.

`If-None-Match: *` for an ID that already has a row answers `401` or
`409` without checking or burning the token and without charging the
create limit. This is what a client meets when it retries a creation
whose `201` it never received. Refinement: today's code checks the token
before it looks for the row. A `PUT` carrying both `If-None-Match: *` and
`If-Match` to an existing row takes the update path.

The whole `PUT` decision (lookup, authorisation, the `401`/`409`/`402`
rules and the write) runs in one `BEGIN IMMEDIATE` transaction.

**Update** (`PUT` with `If-Match`), in this order:

1. The bearer credential must match (`401` otherwise). A `402` is never
   sent before this, so a stranger cannot learn whether a household has
   lapsed.
2. If the header holds a usable token whose `test` flag matches the
   household's (test household: `test: true`; other household: no
   `test`), and the token is not early or the household is not lapsed
   (`E > now`, judged before applying), it will be applied: `ent_exp =
   max(ent_exp, exp)`, or `exp` for a legacy household, which turns it
   into a tracked one. A usable token that does not move `ent_exp` is
   still burned.
3. Anything else in the header (nothing, a used `jti`, an expired or
   invalid token, a version 1 token, an Institutions token, a token with
   the wrong `test` flag, an early token on a lapsed household) counts as
   no token and is not burned. It is not an error, because clients send
   the header on every `PUT`. An early token refused here works on the
   same household from its `per`.
4. If the household is lapsed after step 2: `402 lapsed`.
5. If `If-Match` is stale: `409`, as today.
6. Write. The `jti` insert, the `ent_exp` change and the blob write commit
   in one transaction; if any part fails, nothing is burned.

**GET** and **DELETE** work as today, lapsed or not. A lapsed household
stays readable so every device keeps its last settings, and its owner can
delete it.

**Telling clients the end.** In enforcing mode, `GET` `200`, `PUT` `200`
and `201`, and `402 lapsed` carry `X-Sitr-Entitlement-Expires: <E>` (epoch
ms) when `E` exists. A device learns from it when a claim is due and
whether its household is covered, also when another device did the
claiming. Only a holder of the bearer credential sees it. Refinement: this
header is new.

**Reason format.** Sync-server `402` bodies stay `text/plain`; the first
line is the reason code alone (`lapsed`, `token-used`, …). Refinement:
version 1 sends prose; clients today show only "server responded 402",
so nothing breaks. Other statuses keep today's prose bodies.

**Why an early token cannot reopen a lapsed household.** Otherwise a
buyer could claim next month's token from the 24th and use it to reopen
a second household that lapsed on the 4th, keeping two households alive
together for about 10 days a month. With this rule, alternating tokens
between two existing households overlaps them by at most the 3-day grace
(the old token's household runs to the 4th, the other reopens on the
1st). Holding two households longer needs a fresh household each month,
which starts empty and loses every pairing.

**Test households.** Created by a `test: true` token, deleted by the
hourly GC once `test_delete_day < today`, lapsed or not. A test token
never extends a non-test household and a production token never extends
a test household; both count as no token.

**Pruning.** Hourly, beside today's 18-month idle rule: test households
as above; `used_tokens` rows with `exp < now`. A lapsed household is kept
until the 18-month idle rule removes it; nothing else deletes it.

### Transition and cut-over

1. **Version 2 ships.** The sync server accepts version 1 tokens for
   creation (legacy households, no end; single-use only for tokens minted
   after deployment, see Create) and version 2 tokens. The claim service
   serves both routes, on the claim host. The iOS app sells the
   subscription. Until the cut-over the website's welcome page, which
   calls the claim host, shows both: the subscription code (for
   renew-capable builds, and for later) and a version 1 token from the
   version 1 route (for the extension and Android builds published today,
   which accept only `sitr-ent-v1.` tokens). As far as Railway shows, the
   version 1 route has not been reachable in production so far (buyers'
   tokens were minted by hand), so "restricting" it is in practice
   introducing it, with these limits from the first day:
   - `410 v1-ended` on or after the cut-over date is checked before
     `503`.
   - It mints only while the checkout's subscription is `active`: it
     reads the checkout as today (status `succeeded` or `confirmed`),
     then the checkout's subscription as in Polar verification, sending
     `Polar-Version` on both calls. A checkout without `subscription_id`,
     a subscription that answers `404`, or anything but `active` with a
     future paid end gets `402` with body `inactive`. Only a product
     mapped to `family` in `SITR_POLAR_PRODUCTS` mints a version 1 token;
     any other gets `422` with body `wrong-product`.
   - It mints at most once per checkout. All the Polar checks above run
     before this lookup. After the first success it
     stores the checkout's keyed hash and the token's `exp` in
     `v1_claims`. A repeat request before that `exp` gets the
     byte-identical token again (same payload, same deterministic
     signature, so the sync server's single-use rule still holds); after
     that `exp` it gets `409` with body `already-claimed`. It stores
     nothing on failure.
   - The token's `exp` is a redeem deadline, `SITR_ENTITLEMENT_DAYS`,
     whose default changes from 366 to 7 days; the claim service refuses
     to start with a value above 7, because the sync server treats a
     version 1 token as single-use only when `exp − now ≤ 8 days`. The sync server checks a
     version 1 token only at creation, so `exp` limits only how long the
     token can be redeemed.
2. **Renew-capable extension and Android builds are published.** The
   owner then sets `SITR_V1_CUTOVER` to a date at least 90 days later and
   announces it (owner's decision D3). From that moment legacy households
   see `X-Sitr-Entitlement-Expires: <cut-over date>`.
3. **Cut-over date.** Version 1 tokens are refused (`402 v1-ended` on
   create; the version 1 claim route answers `410` with body `v1-ended`).
   A legacy household that received no version 2 token is lapsed from
   that date, with the same rules as any other.

Version 1 route answers, all `text/plain`: `200` with `{"token":…}`
(JSON, as today); today's prose bodies for `404`, `405`, `429`, `502`,
`503` and the unpaid checkout (`402`); and the new reason codes
`inactive` (`402`), `already-claimed` (`409`), `wrong-product` (`422`)
and `v1-ended` (`410`), each a code alone.

**What stays open until the cut-over.** For a new purchase, one
checkout yields at most one version 1 token and so one legacy household,
plus the households of version 2. Open until the cut-over:

- Households created before version 2 is deployed stay, with no end.
- Version 1 tokens minted before the deployment are unchanged (owner's
  decision D3): each still creates any number of legacy households,
  until 8 days before its own `exp` or the cut-over, whichever comes
  first. Tokens already handed out, for example in store review notes,
  keep working until the cut-over. So does any token minted later with
  `mint.js --old-style-token`.
- Two version 1 tokens minted in the same millisecond for the same plan
  have identical payloads, and Ed25519 is deterministic, so they are the
  same token: the second buyer's creation gets `402 token-used`. That
  needs two claims (or a claim and a manual mint) in the same
  millisecond: at up to ten version 1 claims a day, a chance of less than
  one in a million a day. Support fixes it by minting a new token or
  giving the buyer their subscription code.

A legacy household has no end until the cut-over, so a subscription that
lapses before then keeps its legacy household until the cut-over.

A version 2 token turns a legacy household into a tracked one only when a
renew-capable client holds a code of an active subscription; the
household then renews every month instead of waiting for the cut-over. A
household whose claim fails stays legacy until the cut-over (owner's
decision D3).

### Owner's operating rules

- **Refunds on Polar.** A Polar refund does not end the subscription.
  After refunding a website purchase, the owner also revokes the
  subscription in Polar; otherwise it stays `active` and keeps getting
  tokens.
- **Subscription codes for existing buyers.** Existing buyers got
  tokens minted by hand, not a subscription ID. Before the cut-over is announced,
  every existing buyer gets their subscription code (for example an email
  sent through Polar, or support looking it up in Polar).
- **Node release.** The image is pinned to a specific Node 22 release
  (22.10 or later); the owner bumps it deliberately, never by a floating
  tag.
- **Polar API version.** The code pins `Polar-Version: 2026-10`. Polar
  makes `2027-01` current on 1 January 2027; the owner has the claim
  service tested against it before then, and the pin changes only with
  that review.
- **Deploying the claim service (Railway).** Before version 2 goes
  live: create the claim service and its own volume; set its variables
  (`SITR_ENTITLEMENT_PRIVKEY`, `SITR_CLAIM_KEY`, `SITR_CLAIM_DB` on that
  volume, the Polar and Apple settings) on that service only, never as
  project-wide shared variables; add the DNS record and the custom domain
  `claim.sitrshield.com`; then remove the private key, and any Polar
  setting, from the sync service, which keeps only
  `SITR_ENTITLEMENT_PUBKEY`.
- **Apple root fingerprint.** Before the first deployment, a person
  compares the fingerprint constant of Apple Root CA - G3 in the code
  with the value on Apple's certificate authority page.
- **Apple notification URL.** The owner sets
  `https://claim.sitrshield.com/v1/entitlement/apple/notifications` as the
  App Store Server Notifications V2 URL in App Store Connect, for
  production and Sandbox, before the first sale. Without it a refund
  stops nothing until the receipt expires.
- **Notice before the cut-over.** The cut-over date is announced at least
  90 days ahead, and only after renew-capable extension and Android
  builds are published (owner's decision D3).

### Institutions tokens

The claim route issues them from the Institutions products in
`SITR_POLAR_PRODUCTS` (`plan` `inst-starter` or `inst-standard`), with the
same issue period, binding, replacement and revocation rules. They are
proof of an active plan only (owner's decision D6): nothing in the
product is gated, and the sync server refuses them for creation
(`plan-not-accepted`) and ignores them on update.

Checking one needs no stored data: verify the Ed25519 signature with the
published public key (the value of `SITR_ENTITLEMENT_PUBKEY`) and check
`exp > now`. The ops CLI gains `mint.js --verify <token>`, which prints
`plan`, `term`, `exp` and whether the token is valid now. Exit codes: 0
valid, 1 invalid or expired, 2 usage error, 3 no usable public key. Proof tokens are
not burned, so the check says nothing about use. How an institution
calls the claim route (a page on the website, which the CORS rule below
allows, or a `curl` line in the admin guide) is decided in step 6.

**CORS.** The extension calls both hosts under host permissions (below),
which lift CORS in Chrome but not in Safari's service worker, whose
origin (`safari-web-extension://<per-install ID>`) cannot be listed. So:
responses from `POST /v1/entitlement/claim`, preflight (`OPTIONS`) and
error answers included, carry `Access-Control-Allow-Origin: *` with
`POST, OPTIONS` allowed and the `Content-Type` request header, never
`Access-Control-Allow-Credentials`: the token is useful only to whoever
sent the subscription code and claim secret, and no cookie or other
ambient credential exists. The other claim routes keep the site's
origin. Every sync-server response carries `Access-Control-Allow-Origin:
*`, `GET, PUT, DELETE, OPTIONS`, the request headers `Authorization`,
`If-Match`, `If-None-Match`, `X-Sitr-Entitlement` and `Content-Type`,
and `Access-Control-Expose-Headers: ETag, X-Sitr-Entitlement-Expires`;
`OPTIONS` on a blob path is answered `204` before the bearer check.

### What each client must do

Rules for all clients:

- **One call site, two hosts.** The claim call goes through the client's
  existing single HTTP call site (extension `client.ts`, Android
  `SyncHttp.kt`, iOS `URLSessionTransport`), with a second base-URL
  constant, `https://claim.sitrshield.com`, used only by the claim call.
  The claim host is a second host; `docs/data-flow.md` lists it.
- **Claim secret.** Generate 32 random bytes before the first claim for a
  subscription, keep them with the credential, and send the same value
  every month. Delete them only together with the credential. Never send
  them to the sync server and never put them in the household blob: every
  household device can read the blob, including a child's, and the claim
  secret with the credential is the power to renew or rebind the
  subscription. One claimer per subscription is the point of the binding.
- **Who claims.** Only the device bound to the subscription renews it
  (on iOS, every device that shares the claim secret through iCloud
  Keychain). Other guardian devices of the household that hold the
  credential do nothing while `E` keeps moving.
- **When to claim.** A device that holds a credential claims: (a) to
  create a household; (b) at once, when it has never applied a version 2
  token to its current household (a legacy household, or a credential
  just entered); (c) in the renewal window, which opens at `E − 10 ×
  DAY` (the 24th or 25th, 7 days before the month ends) and closes at
  `E` (the 4th). The device picks a time evenly at random in the first
  5 days, `[E − 10 × DAY, E − 5 × DAY)`, and claims at its first run
  after that time; from `E − 5 × DAY` on it claims at its first run with
  no delay. That leaves at least 5 days for retries and for a rebind. If
  the answer is a token whose `exp` is not later than `E` (a monthly
  subscription whose renewal day is still ahead), it tries again a day
  later. For a test household, (c) is instead "when `E` is less than 1
  hour away", that is, from midnight UTC. The device remembers (b) as a
  flag per household. (d) When its household is lapsed (`E ≤ now`, or a
  `402 lapsed`), at once and with `current: true`; after that token is
  applied, it continues with (c), whose window may already be open.
- **Using the token.** Store it; send it in `X-Sitr-Entitlement` on every
  `PUT`, as today. After receiving a new token, write the household at
  the next sync even when nothing changed, so the token reaches the
  server. Delete it once a response shows `E ≥` its `exp`. A device that
  holds two tokens (this month's and an early one for next month) sends
  the one that is not early first, and the early one at the next write.
- **Claim errors.**
  - `bound-to-other-device`: another device renews this subscription. The
    device remembers this answer for its household until a claim
    succeeds, the credential is entered again or removed, or the device
    leaves.
    - While it is remembered and `E` is in the future (or there is no
      `E`), the device makes no automatic claim: not by rule (b), not in
      the window, and no daily retry.
    - Once `E` has passed (`E ≤ now`, or a `402 lapsed`), it makes one
      claim without `replace`, with `current: true` (rule (d)). Usually
      the old binding is stale then and this claim binds the device
      without using the rebind. It may not be stale: when the bound claim
      secret got a later token than the one that set `E` (next month's,
      claimed but not applied here, or one for another household), or in
      a legacy household, whose `E` no token set. So if this claim is
      refused as bound, the device tries again at most once a day while
      the household stays lapsed, and stops if `E` moves into the future.
    - The user may choose "Renew on this device" (the claim with
      `replace: true`, plus `current: true` on a lapsed household) only
      when a token is needed now: to create a household, or when `E − now
      < 2 × DAY` and, if `E` has passed, the claim without `replace` has
      already been refused. Had `E` moved in this window it would be at
      least 28 days away, so this test needs no stored state. Ask the
      user first, because a rebind can be made only once in 180 days.
  - `replacement-used`: show the date in `retry_after`.
  - `payment-pending`, `inactive`, `revoked`: show the reason with the
    way to fix it (renew, update the payment method), then try at most
    once a day, or when the user asks.
  - `unknown-code`, `wrong-product`, `invalid-receipt`, `test-purchase`,
    `family-sharing`, `bad-request`: show the reason and stop until the
    user acts.
  - `429`, `502`, `503`, no network: retry at later sync runs, with
    backoff. The household keeps working until `E`.
- **Sync `402`.**
  - `lapsed`: the device keeps filtering with its last settings; local
    changes are kept on the device and sync once the household is
    renewed. A device with a credential claims at once, with `current:
    true` (rule (d)). What the UI says
    depends on what this device knows:
    - By default, a neutral state: "Waiting for renewal on the
      subscriber's device. Filtering continues; changes will sync after
      renewal." This covers every device without a credential, and a
      device whose claim got `bound-to-other-device`, a network error, or
      no answer yet. A lapse is usually a renewing device that was off.
    - "Family has ended" (with the way to renew) only when a claim on this
      device came back `inactive` or `revoked`.
    - "Payment problem" (update the payment method) when it came back
      `payment-pending`.
    The same texts apply while `E` is less than 2 days away and has not
    moved, before the household lapses, shown as a notice.
  - `token-used`, `token-expired`, `token-invalid`, `token-required` on
    create: claim once more, then retry the creation once.
  - `plan-not-accepted`: "This is a code for Sitr for Institutions."
  - `v1-ended`: ask for the subscription code.
- **No `X-Sitr-Entitlement-Expires` header.** The sync server deployed
  today still runs version 1 (`server/sync/src/http.ts` and
  `entitlement.ts` at the tag `server-hotfix-live`) and sends this header
  on no response. A version 2 server also sends none in open mode, and
  none for a legacy household before a cut-over date is set. A client
  treats a household whose responses carry no such header as a legacy
  version 1 household: never lapsed, no subscription notice or text, and
  no claim unless the user has entered a subscription code. With a code
  it claims once by rule (b) and then not again while it holds that
  token: with no header, no response can show the token applied. It
  claims again only after the held token's `exp` has passed (a time to
  claim, not a judgement of the token). Rules (c) and (d) need `E`, so
  they do not apply. On a version 1 server, creating a household needs a
  version 1 token; a version 2 token gets `malformed entitlement token`.
  The claim service is not deployed yet either; whatever a client meets
  there instead (no host, or an answer that is not the claim API's JSON)
  is handled like no network. The version 1 server's `402` bodies are
  `text/plain`, one line, sent only on a `PUT` that creates a household,
  and a client must still understand them: `entitlement required`
  (read as `token-required`); `malformed entitlement token`, `invalid
  entitlement signature`, `malformed entitlement payload` and
  `unsupported entitlement version` (read as `token-invalid`);
  `entitlement expired — please renew` (read as `token-expired`).
- **Clocks.** A client never judges a token by its own clock; only the
  servers' clocks decide. A wrong device clock only moves the time a
  claim is made: too early gets the token it already has (and it tries
  again a day later), too late is covered by the rest of the 10-day
  window.
- **Offline.** Filtering never depends on a claim or a sync.

**Extension and Android (Polar clients).** They sell nothing; the buyer
subscribes on the website and enters the subscription code.

- **Who handles the code.** Only a guardian device (or a device with no
  household, to create one) enters, removes or moves a subscription code, gated like changing the PIN: refused under a
  managed lock and on a child device, then the household's guardian PIN
  when one is set, with no wait. On Android it is also refused while the
  child lock is on. A child-role device never holds a code and never
  claims.
- **Removing the code** while staying in the household is allowed, gated
  the same way. The code and the claim secret are deleted together; the
  device stops renewing, and the screen says that this device no longer
  renews the subscription and that the household runs until `E`.
- **Leaving the household** deletes the subscription code and the claim
  secret from the device, together. The subscription stays bound to the
  deleted claim secret until that binding is stale (its newest token has
  expired). So a new household created with the same subscription before
  then, on this or any device, gets `bound-to-other-device` and needs the
  rebind that is possible once in 180 days; in the same month that is
  always so. Removing the code has the same consequence.
- **One input field.** Until the cut-over (the client learns it has
  passed from `v1-ended`, not from a date it holds) the field accepts either a
  subscription code (a UUID in its canonical 36-character form, any case)
  or a version 1 token (`sitr-ent-v1.…`), and tells them apart by shape;
  anything else is refused on the device and sends nothing. A version 1
  token is used as today, for creation only.
- **A code of an Institutions plan.** The claim succeeds and the token's
  `plan` is not `family`. The client reads `plan` itself (on an update
  the sync server ignores such a token without an error), shows "This is
  a code for Sitr for Institutions.", deletes the code, the claim secret
  and the token, and creates nothing. The claim has still bound the
  institution's subscription to the deleted claim secret, when it was
  unbound or stale, and no request undoes that: the institution's own
  claims get `bound-to-other-device` until that binding is stale (the 4th
  of the next month, or of the month after when the claim was made in the
  last 7 days of a month), unless the institution uses its rebind. If the
  institution had already bound it, the client gets
  `bound-to-other-device` instead and cannot tell the plan, because an
  error never names it; a rebind the user then agrees to would take the
  institution's subscription and use up its one rebind in 180 days, and
  the token is refused as above.
- **A legacy household after the cut-over is announced** (its `E` is the
  cut-over date). A device that holds no code shows: "Enter your
  subscription code on one guardian device before <date>." It knows the
  household is legacy when `E` is more than 41 days away (no token
  reaches further: one claimed on the 24th of a 30-day month runs to the
  4th of the month after next), or when `E` still has a value that this
  device once saw more than 41 days away. Otherwise it shows the ordinary
  notices.
- **`v1-ended`**: "Tokens are no longer accepted. Enter your subscription
  code."

**Extension.** The subscription code and the claim secret are kept in
`storage.local`, beside the existing subscription-token item. The user
enters the code once on the options page. The claim host is an optional
host permission (`optional_host_permissions`), requested when the user
enters a subscription code, never a required one: a new required host
would disable the installed extension until the user accepted it.
Claims run in the service worker during the 30-minute sync alarm, and
from the options page when a household is created. Android and iOS need
no permission for the second host.

**Android.** The subscription code and the claim secret are kept in
app-private preferences, encrypted at rest under the Android Keystore key
that protects the root secret; the token stays in app-private
preferences, as today. Claims run in `SyncWorker` and at household
creation.

**iOS.** Sitr stores no credential: StoreKit holds the transaction, and
the app reads the latest one (`Transaction.currentEntitlements`) when a
claim is due. The claim secret is a Keychain item, synchronizable in
iCloud Keychain together with the household root secret when the switch
below is on, and device-only when it is off. The token lives in App
Group storage. Purchase flow: the purchase sheet, then the claim, then
the household is created, then the pairing code is shown. The app
finishes the StoreKit transaction once the token is stored or the claim
is finally refused. Claims also run on `Transaction.updates`, on
foreground and in the background refresh task. Restore calls
`AppStore.sync()`. The app is no longer join-only. A device that joined
by pairing code and has no purchase on its Apple ID holds no credential;
it shows `E` and the lapse state only.

**iCloud Keychain (owner's decision D4).** The iOS app keeps the household
root secret, and the claim secret, as synchronizable Keychain items when
the switch "Keep the household key in iCloud Keychain" is on (on by
default). The buyer's other Apple devices then get both, so they can
rejoin and renew without a rebind; they compute the same token as the
first device, and only one copy of it can be used. Turning the switch off
writes non-synchronizable items and deletes the synchronizable ones. A
device on the same Apple ID that finds the root secret offers to join the
household; joining that way goes through the same gate, wait and PIN as
joining by pairing code. This is a flow from the device to Apple, not to
Sitr.

### How this is tested before Apple's setup exists

Apple signs no Sandbox or Production receipt for this app until the
owner's App Store Connect setup exists (an active Paid Apps Agreement and
the two products). The verifier and the iOS flow must therefore work
against certificate chains that are not Apple's, without opening a way
for production to accept them.

**The trust anchor is an argument, not a setting.**

- The Apple verifier takes, as constructor arguments, its trust anchor
  (the root's SHA-256 fingerprint and the OIDs it requires on the leaf
  and the intermediate) and the set of environments it accepts. The same
  verifier checks transactions and notifications.
- The claim server's entry point (`claim-server.ts`) is the only place
  that constructs the production verifier. It passes the pinned Apple
  constant and accepts `Production`, plus `Sandbox` when
  `SITR_APPLE_SANDBOX=1`. It never passes `Xcode`.
- No environment variable, config file or request can change the anchor
  or add `Xcode`. `SITR_APPLE_SANDBOX` only adds Sandbox under Apple's
  anchor.
- Tests generate their own root, intermediate and leaf, with the two
  OIDs as extensions (with `openssl`, kept as test fixtures, because
  `node:crypto` cannot create certificates), sign transactions with the
  leaf, and pass the test root's fingerprint. They make each of the
  numbered steps fail once. In development the same fixtures are also
  checked with Apple's library, as the reference.

**A local claim server for iOS Debug builds.**

- A development entry point, kept under `tests/` and not part of the
  server build or its Docker image, starts the claim process with a test
  anchor taken from Xcode's StoreKit test certificate (Xcode's local
  StoreKit environment signs with its own root certificate, which can be
  exported from Xcode), the accepted environment `Xcode`, a throwaway
  signing key, its own database file, and a local sync server set up
  with the matching public key. The app's Debug build points its two base
  URLs (sync and claim) at these two local servers.
- Whether Xcode-signed transactions carry a three-certificate chain with
  Apple's OIDs is to confirm. If they do not, the test anchor
  describes what they carry; the production anchor does not change.

**The iOS app.**

- Debug builds: the scheme uses a StoreKit configuration file (local
  products, environment `Xcode`), the claim and sync base URLs can be
  pointed at the local servers (for example by a launch argument), and an
  App Transport Security exception for `localhost` exists only in the
  Debug configuration. The whole purchase flow (buy, claim, create,
  renew, restore) runs on the simulator this way.
- Release builds: the override code is compiled out (`#if DEBUG`), the
  base URL is the production constant, no StoreKit configuration file is
  included and there is no ATS exception. A Release build can talk only
  to the production claim service, which refuses `Xcode` receipts.
- Whether a UI test can drive Apple's purchase sheet on the current Xcode
  is still unknown (proposal §7).

**Polar.** Tests stub `fetch`, as `tests/src/entitlement.test.ts` does
today; Polar's sandbox API (`SITR_POLAR_API`) serves manual tests.

### Failure cases

| Case | What happens |
|---|---|
| Lost device | iOS with the iCloud copy on: the buyer's other Apple devices have the transaction and the claim secret and renew as before. Otherwise another device with the credential (extension and Android: enter the subscription code) gets `bound-to-other-device`. If `E` has not moved 2 days before it, the user may rebind with `replace: true` and get the token the period rule gives, or, without using the rebind, wait until `E` has passed (the 4th), when the old binding is stale (unless the lost device had already claimed next month's token) and a plain claim binds it; the household is read-only in between, and other devices show the neutral "waiting for renewal" state. |
| Lost everything | Every device, the pairing code and the Keychain copy are gone, so the household's key and the claim secret are gone. The subscription still works: create a new household with a rebind. If a rebind was made in the last 180 days, wait until the lost claim secret's newest token expires; its binding is then stale and the first claim binds the new device. That is the next 4th, or, if the lost device had already claimed next month's token in the last week, the 4th of the month after: at most about 40 days. The old household lapses and is deleted after 18 months idle. |
| Lost subscription code | The household keeps working; the bound device still holds the code. If that device is lost too, the household runs until `E`, then is read-only. The buyer can read the subscription ID through Polar's customer portal (whether the portal page shows it, rather than only its API, is to confirm), or the owner looks it up in Polar from the buyer's email. |
| Refund (Apple) | The `REFUND` notification records the refunded transaction; no further token from that receipt. A later renewal or new purchase is a different transaction and claims normally; if Apple does not stop auto-renewal after a refund (to confirm), the next renewal therefore gets tokens, which is the intended reading. Without one, the household is read-only after its current `E`: the 4th of the next month, or of the month after if next month's token was already claimed in the last week; at most about 41 days later. |
| Refund (Polar) | Only after the owner revokes the subscription in Polar: claims then get `inactive` from the live status (nothing is stored), and the household is read-only after its current `E`, as above. |
| Payment retry | Polar `past_due` → `payment-pending`; Apple: the latest transaction's `expiresDate` has passed → `inactive`. A claim made before the failed renewal already covers the rest of the month. Otherwise the household works until `E`, then is read-only until the payment succeeds; the next claim then extends it. How Apple's Billing Grace Period shows in the transaction is to confirm (recommended off). |
| First purchase late in a month | In the last 7 days of a month the first claim already gets next month's token. Earlier, it gets this month's token and the renewal window opens on the 24th or 25th. |
| Monthly, renewal day 1st to 4th | The paid end (for example 2 December) is after the 1st, so a claim in the last week of November gets the December token, `exp` 4 January. A renewal that then fails leaves the household running to 4 January unpaid (the worst case in §The issue period). |
| Monthly, renewal day in the last week | Until the renewal, claims in the window get the token the device already has; it tries again daily, and the first claim after the renewal gets next month's token. If the renewal is still being retried on the 4th, the household lapses until the payment succeeds. |
| Laptop closed from 31 December to 4 January (yearly, the laptop is the only device with the code) | The window for January opens on 25 December. The laptop picks a time between 25 and 30 December and claims while open, before 31 December: the January token, `E` = 4 February. The closed days change nothing; nobody sees anything. If the laptop had been closed from 25 December already, it would claim at its first run after reopening on 4 January: the household is lapsed from 00:00 UTC on 4 January until that run, other devices show "waiting for renewal on the subscriber's device", their changes stay on the device, and everything syncs once the laptop's claim and write go through. |
| iPhone app not opened on days 1 to 3 | The window opened on the 24th or 25th. The claim happens at the first foreground launch or background refresh after the iPhone's chosen time, any time in the 10 days; one launch or one refresh between the 25th and the 31st is enough, so days 1 to 3 do not matter. Only if the app neither runs in the background nor is opened for all 10 days does the household lapse on the 4th; other devices then show the neutral state, and the next launch claims and renews. |
| Household lapsed since the 4th, bound device back on the 26th | The device sees `E ≤ now` and claims with `current: true`: this month's token, not early, which reopens the household at once. Its window for next month is open, so its next claim gets next month's token, early, which the now open household accepts. Without `current`, it would get next month's token, early, which a lapsed household refuses (not burned), and the household would stay read-only until the 1st. |
| Legacy household converted | A legacy household is not lapsed before the cut-over (`E` is the cut-over date, or none), so any usable token, early or not, converts it; it then renews like any other. On or after the cut-over it is lapsed, and the device claims with `current: true` first. |
| Test household | Sandbox tokens are for the current UTC day and never early, so the early rule never applies to them. |
| Clock skew | Servers decide by their own clocks. A client's clock only moves when it claims (see Clocks). |
| Token claimed but never used | The bound device asks again with the same claim secret and gets the same token. An unused token simply expires. |
| Two devices claim at once | With the same claim secret (iOS through iCloud Keychain): both get the same token; the sync server uses it once and the second `PUT` counts as no token. With different claim secrets: the first to bind wins; the other gets `bound-to-other-device` and does nothing while `E` moves. |
| Replay of an old receipt or token | Paid end in the past → `inactive`. A receipt of a refunded transaction → `revoked` via `revoked_transactions`. A receipt of the current period without the bound claim secret → `bound-to-other-device`. A held early token used on a lapsed household is refused until its `per`. |
| Stolen subscription code, or a copy of a receipt | Once the buyer has claimed, the thief gets `bound-to-other-device`. A thief who claims before the buyer ever does binds the subscription; the buyer then needs a rebind. A thief who also rebinds (once in 180 days, the same allowance the buyer has) takes it back, so a persistent thief with the code can hold it for up to 180 days at a time. The thief cannot reach the household (that needs the pairing code) and learns no buyer data from Sitr. A Polar code cannot be rotated: the fix is to cancel and buy again. Polar's subscription ID is also known to the owner, to every webhook consumer and to anyone with the organisation token; each of them is a "holder of the code" in this sense. A copy of an Apple receipt works only until its `expiresDate`. |
| Polar down | `502 billing-unavailable`; retries at later syncs; the household works until `E`. |
| Cancelled at period end | Claims succeed while the paid end is ahead (for next month's token, while it is after the 1st). The household runs to the 4th of the month after the paid end's month: up to about 34 days, about 18 on average, not paid for. |
| Everyone renews in the same window | First attempts spread over 5 days; the per-IP limit is sized for it (§Rate limits). A claim that fails is retried within the window. |
| Monthly to yearly | The subscription ID stays the same (Apple: `originalTransactionId`; Polar: to confirm), so the marker and its binding do too. The current token keeps `term: month` until the next month. |
| App Review, TestFlight | Sandbox on: each claim gets a token for the current UTC day (at most 25 hours), on any device and any day; no binding. The test household is deleted after 7 days. |

### What version 2 lets the operator learn

Stated as exactly as we can, neither softened nor overclaimed:

- No stored value joins a household to a subscription. The claim service
  knows markers and binders; the sync server knows used-token hashes and
  end dates. They share no key, table or file.
- A marker cannot be read back. An operator who holds the claim key and
  already knows a subscription ID can compute its marker and see whether
  that subscription is bound, claimed this month, or was rebound in the
  last 180 days. An operator who already knows an Apple transaction ID
  can likewise test whether that transaction was refunded or revoked.
  For website purchases the operator knows
  every subscription ID (Polar's dashboard and API list them with the
  buyers' names), so for them the marker hides nothing from the
  operator: every website marker can be matched to a named buyer. Apple
  does not give the operator transaction IDs without an API key, which
  this design does not use. What stays unlinked in both cases is marker
  to household.
- `ent_exp` no longer points to a subscription: every non-test household
  that renewed for a month has the same date, and `last_period_end` is
  the same for every marker that claimed for that month. They show only
  whether a household or a subscription renewed for this month, next
  month, or neither. Neither database records the day of a claim; only
  copies taken at different moments show when a value changed (next
  point).
- What remains is time. An operator who compares copies of both
  databases taken at different moments can see when a household first
  appeared and in which month it stopped renewing, and when a marker
  first appeared and in which month it stopped claiming. With few
  subscribers, such events can be matched, and Polar's dashboard shows
  the operator when each named website buyer bought and cancelled. Test
  households also carry their creation day (`test_delete_day` − 7).
- An operator who logged requests could match a claim to the write that
  follows it, from the same IP address a moment later. The claim secret
  is sent every month, so one logged claim would let the operator compute
  that subscription's future `jti`s. This class of risk exists today for
  the version 1 claim and creation. The servers log nothing per request.
- `used_tokens` shows how many tokens were used and when they end; it has
  no household ID. `v1_claims` shows how many checkouts used the version
  1 route.

### Facts to confirm

Not asserted in this section until checked:

- Polar: whether a plan change keeps the subscription ID; whether the
  customer portal page (not only its API) shows the subscription ID.
- Apple: the exact environment strings; how a transaction replaced by an
  upgrade is marked; how Billing Grace Period shows in a transaction; the
  notification retry schedule; the shape of Xcode-signed transactions
  (chain length, OIDs); that a transaction carries `transactionId` under
  that name, and that `REFUND_REVERSED` carries the original
  transaction's `transactionId`; whether Apple stops auto-renewal after a
  refund. If it does not, the next renewal is a new transaction and gets
  tokens, which is the intended reading of "a refund blocks only the
  refunded transaction".

`Polar-Version: 2027-01` is an operating step, not an open fact
(§Owner's operating rules).

### Configuration (new)

| Variable | Process | Meaning |
|---|---|---|
| `SITR_CLAIM_KEY` | claim | 32 bytes, base64: the claim key |
| `SITR_CLAIM_DB` | claim | SQLite path of the claim database |
| `SITR_POLAR_PRODUCTS` | claim | `productId=plan:term`, comma-separated, Family and Institutions products |
| `SITR_POLAR_WEBHOOK_SECRET` | claim | optional webhook secret |
| `SITR_APPLE_BUNDLE_ID` | claim | the iOS app's bundle ID |
| `SITR_APPLE_PRODUCTS` | claim | `productId=plan:term`, comma-separated |
| `SITR_APPLE_SANDBOX` | claim | `1` accepts Sandbox receipts (test tokens) |
| `SITR_REPLACEMENT_DAYS` | claim | days between rebinds per marker; default 180 |
| `SITR_CLAIM_PER_IP_HOUR` | claim | claims per IP hash per hour, both routes; default 60 |
| `SITR_V1_CUTOVER` | sync and claim | the cut-over date; unset until announced |
| `SITR_ENTITLEMENT_DAYS` (existing) | claim | version 1 redeem deadline in days; default changes from 366 to 7; above 7 the claim service refuses to start |

Unchanged: `SITR_ENTITLEMENT_PUBKEY`, `SITR_ENTITLEMENT_PRIVKEY`,
`SITR_POLAR_TOKEN`, `SITR_POLAR_API`, `SITR_CLAIM_ORIGIN`,
`SITR_CLAIM_PORT`, `SITR_TRUSTED_PROXY`. `SITR_CLAIM_ORIGIN` must be an
origin only (scheme, host, optional port; no path). `SITR_POLAR_API` is
an origin (no path, no trailing slash). The Apple root
fingerprint and the `Polar-Version` value are constants in the code, not
configuration.

**Start-up checks.** A variable that is set but unusable stops the
process at start-up, with a message that names the variable and never
its value. A variable set to an empty or blank value counts as unset
where unset only falls back to a default; it is refused for
`SITR_SYNC_DB`, `SITR_CLAIM_DB`, `SITR_ENTITLEMENT_PUBKEY`,
`SITR_ENTITLEMENT_PRIVKEY`, `SITR_CLAIM_KEY`, `SITR_POLAR_TOKEN` and
`SITR_V1_CUTOVER`, where unset would switch off a check (a blank public
key would mean an open server). Only a variable that is absent is unset.
`SITR_SYNC_DB` and `SITR_CLAIM_DB` must be file paths; an in-memory
database is refused. The claim service also refuses partial setups: one of the
signing key and the claim key without the other; a billing source
without both keys; a Polar token without Polar products, or the reverse;
an Apple bundle ID without Apple products, or the reverse; Sandbox
without Apple configured.

**Runtime.** Node 22.10 or later for both services: the certificate
validity dates the Apple check reads were added to `X509Certificate`
then. The image is pinned to a specific Node 22 release (§Owner's
operating rules).

Placeholders only, for example
`SITR_APPLE_PRODUCTS=com.example.family.month=family:month,com.example.family.year=family:year`.

## Test vectors

Root secret = bytes `00 01 02 … 1f` (0..31).

- household id (hex, 16 B): derive per table above; the reference
  implementation's vectors are asserted in
  [`tests/src/syncCrypto.test.ts`](../tests/src/syncCrypto.test.ts) and the
  server integration tests — run `npm test` to verify your implementation
  against them.
- CRC-16/CCITT-FALSE of ASCII `123456789` = `0x29B1`.

Exact-value vectors (derived ids, keys, encoded pairing codes) are pinned
in the conformance fixtures at `apps/shared/fixtures/`, generated from the
reference TypeScript implementation. Native clients must match them
byte-for-byte.
