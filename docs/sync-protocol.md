# Sitr Family sync protocol (v1)

This is the normative spec for the ONE network endpoint Sitr Family may
contact (`docs/data-flow.md`). It is written so a third party can
reimplement both sides and audit every claim. Server source:
[`server/sync/`](../server/sync/). Client source:
[`extension/src/lib/sync/`](../extension/src/lib/sync/) — the sync client
is the repository's only `fetch(` call site.

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

## API

Base URL: `https://sync.sitr.app`. All requests carry
`Authorization: Bearer <auth credential hex>`. Responses carry
`Cache-Control: no-store`.

| Route | Semantics |
|---|---|
| `GET /v1/blob/{householdId}` | 200 with blob (binary) + `ETag: "<rev>"`; 404 if none; 401 wrong auth |
| `PUT /v1/blob/{householdId}` | body = blob. First PUT creates the row and binds SHA-256(auth) to the id. Requires `If-Match: "<rev>"` of the last seen ETag (or `If-None-Match: *` on create). 200 with new ETag; 409 on concurrent write; 401 wrong auth; 413 > 64 KiB; 429 rate-limited |
| `DELETE /v1/blob/{householdId}` | removes the row (used when a household rotates its secret). 204; 401 wrong auth |

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

**Acquiring a token.** Checkout happens on the website via a merchant of
record (Polar). Afterwards the site calls
`GET /v1/blob`-adjacent endpoint `GET /v1/entitlement/claim/{checkoutId}`
(CORS-restricted to the site's origin, rate-limited per IP). The server
asks the billing provider a single question — "is this checkout paid?" —
and if so returns a freshly minted token. This call is made by the
website, never by the extension; the extension's endpoint inventory is
unchanged. What the billing provider knows: that a purchase happened
(name/email/payment, as any merchant of record). What it can never learn:
household ids, keys, settings, devices, or browsing — the token is minted
by us, not them.

Ops: `server/sync/dist/mint.js --keygen` generates the keypair;
`--plan family --days 366` mints tokens manually for support cases.

## Test vectors

Root secret = bytes `00 01 02 … 1f` (0..31).

- household id (hex, 16 B): derive per table above; the reference
  implementation's vectors are asserted in
  [`tests/src/syncCrypto.test.ts`](../tests/src/syncCrypto.test.ts) and the
  server integration tests — run `npm test` to verify your implementation
  against them.
- CRC-16/CCITT-FALSE of ASCII `123456789` = `0x29B1`.
