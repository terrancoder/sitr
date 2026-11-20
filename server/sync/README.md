# sitr-sync — the Family sync server

A blind mailbox: one E2E-encrypted blob per household, which this server
cannot read. Protocol and privacy guarantees: [docs/sync-protocol.md](../../docs/sync-protocol.md).
This code is intentionally small (zero runtime dependencies: node:http,
node:sqlite, node:crypto — Apple's receipts are verified with node:crypto
alone) so an auditor can read all of it in one sitting.

## Processes

Node ≥ 22.10 (`engines` in package.json: Apple verification needs
`X509Certificate.validFromDate`, added in v22.10.0 / v23.0.0, and the claim
service refuses to start without it). `node:sqlite` needs
`--experimental-sqlite` on 22.10 to 22.12 (it is unflagged from v22.13.0 and
v23.4.0); the commands below pass it, which is harmless on later versions.
The Dockerfile pins `node:22.23.4-alpine`; bump it deliberately.

- **sync** (`dist/server.js`) — the blob API at `https://sync.sitrshield.com`.
  Holds at most the entitlement *public* key. Parses untrusted traffic.
- **claim** (`dist/claim-server.js`) — `/v1/entitlement/*` only, at
  `https://claim.sitrshield.com`: the version 2 claim, the checkout →
  subscription-code exchange, Apple's server notifications and, until the
  cut-over, the version 1 claim. The only process holding the Ed25519
  *minting* key, the claim key, the Polar token and the claim database, so
  a compromise of the blob parser never yields any of them.

Neither process assumes it shares a host with the other. `SITR_CLAIM_ORIGIN`
is the website's origin (the browser origin the checkout exchange and the
version 1 claim allow by CORS), not the sync host. The version 2 claim and
every sync answer allow any origin without credentials, for the Safari
extension (docs/sync-protocol.md §CORS).

## Production layout: two services, one image

The supported production layout is two Railway services built from
`server/sync/Dockerfile` (build context: repository root), each with its
own hostname and its own volume. They share the image and nothing else:
no variable holding a secret, no volume, no database file.

| | sync service | claim service |
|---|---|---|
| Hostname | `sync.sitrshield.com` | `claim.sitrshield.com` |
| Start command | the image's `CMD` (`dist/server.js`) | set in Railway: `node --experimental-sqlite --no-warnings=ExperimentalWarning dist/claim-server.js` |
| Listen port | `SITR_SYNC_PORT` (8787) | `SITR_CLAIM_PORT` (8788) |
| Volume | `/data` (`SITR_SYNC_DB=/data/blobs.sqlite`, set by the image) | its own, e.g. `/claim-data` with `SITR_CLAIM_DB=/claim-data/claims.sqlite` |

**Ports.** The code reads `SITR_SYNC_PORT` / `SITR_CLAIM_PORT`, not
Railway's `PORT`. Set each service's target port in Railway's networking
settings to the port it listens on (8787 and 8788).

**Volumes and the `sitr` user.** The image runs as the unprivileged user
`sitr`, while Railway mounts volumes owned by root, so a process running as
`sitr` cannot create its database there. Nothing in the Dockerfile can fix
this: the volume is mounted at run time, after any `chown` in the build.
Railway's documented remedy is the service variable `RAILWAY_RUN_UID=0`,
which runs the container as root. The sync service writes `/data` today, so
it presumably has that variable or an equivalent setting; this repository
does not record which, so check the sync service's settings and give the
claim service the same. The Dockerfile is unchanged.

**Variables.**

Sync service:

| Variable | Meaning |
|---|---|
| `SITR_SYNC_PORT`, `SITR_SYNC_DB` | listen port (8787), SQLite path (both set by the image) |
| `SITR_ENTITLEMENT_PUBKEY` | Ed25519 public key; unset = open server (no checks, no end dates) |
| `SITR_V1_CUTOVER` | `YYYY-MM-DD` (UTC): version 1 tokens refused and legacy households lapse from this date; unset until announced |
| `SITR_SYNC_CREATES_PER_IP_HOUR`, `SITR_SYNC_REQS_PER_ID_MIN` | limits (20, 60) |
| `SITR_TRUSTED_PROXY` | see below |

The sync service must **never** have `SITR_ENTITLEMENT_PRIVKEY`,
`SITR_CLAIM_KEY`, `SITR_POLAR_TOKEN`, `SITR_POLAR_PRODUCTS` or any
`SITR_APPLE_*` variable. Do not put any of them in Railway's project-level
shared variables, which every service can read.

Claim service (a route answers `503 claims-disabled` while what it needs is missing):

| Variable | Meaning |
|---|---|
| `SITR_CLAIM_PORT` | listen port (8788) |
| `SITR_ENTITLEMENT_PRIVKEY` | Ed25519 private key (`mint.js --keygen`) |
| `SITR_CLAIM_KEY` | 32 bytes, base64: keys the marker, binder and `jti` HMACs (`openssl rand -base64 32`) |
| `SITR_CLAIM_DB` | the claim database, on the claim service's own volume |
| `SITR_POLAR_TOKEN`, `SITR_POLAR_API` | Polar organisation token, API base |
| `SITR_POLAR_PRODUCTS` | `productId=plan:term,…` (plans `family`, `inst-starter`, `inst-standard`; terms `month`, `year`) |
| `SITR_APPLE_BUNDLE_ID`, `SITR_APPLE_PRODUCTS` | the iOS app's bundle ID and products, same format |
| `SITR_APPLE_SANDBOX` | `1` accepts Sandbox receipts (test tokens, test households) |
| `SITR_REPLACEMENT_DAYS` | days between rebinds per subscription (180) |
| `SITR_CLAIM_PER_IP_HOUR` | claims per IP hash per hour, all claim routes (60) |
| `SITR_ENTITLEMENT_DAYS` | version 1 redeem deadline in days (default 7, at most 7: the sync server treats a token with more than 8 days left as an old, reusable one, so the claim service refuses to start above 7) |
| `SITR_V1_CUTOVER` | as above; the version 1 route answers `410 v1-ended` from it |
| `SITR_CLAIM_ORIGIN` | the website origin allowed by CORS on the exchange and version 1 routes (default `https://sitrshield.com`) |
| `SITR_TRUSTED_PROXY` | see below |

The claim service does not need `SITR_ENTITLEMENT_PUBKEY`.

**Apple's root.** `apple.ts` pins the SHA-256 fingerprint of Apple Root
CA - G3; the certificate itself is in `certs/` (see the README there). A
person compares that fingerprint with Apple's page before the first
deployment.

`SITR_TRUSTED_PROXY=1` makes rate limiting use the last `X-Forwarded-For`
entry (the hop the proxy appended). Set it ONLY behind a proxy you trust
(Railway's edge, or your own); without it the header is ignored so direct
clients cannot spoof it.

Ops (`node dist/mint.js …` in the image, `node server/sync/dist/mint.js …`
from the repository):

- `--keygen`: prints a new key pair as `SITR_ENTITLEMENT_PRIVKEY=…` and
  `SITR_ENTITLEMENT_PUBKEY=…`.
- `[--plan family] [--days N]` with `SITR_ENTITLEMENT_PRIVKEY` set: prints a
  manual version 1 token. `--days` defaults to 7 and is refused above 7
  unless `--old-style-token` is given: an old-style token, with more than
  8 days left when used, creates any number of legacy households until the
  cut-over. Exit 1 without a usable private key.
- `--verify <token>` with `SITR_ENTITLEMENT_PUBKEY` set: prints plan, term,
  exp and whether the token is valid now. Exit 0 valid, 1 invalid or
  expired, 3 no usable public key.
- Exit 2 for a usage error (unknown flag, missing value, bad `--days`).

**Start-up checks.** Both processes refuse to start, with a message that
names the variable and never its value, when a variable is set but
unusable (a non-numeric port or limit, a key of the wrong length, a
malformed date, product list, URL or origin, a `SITR_TRUSTED_PROXY` /
`SITR_APPLE_SANDBOX` other than `1`/`0`) or a database cannot be opened.
A blank value counts as unset where that only falls back to a default
(ports, limits, origins, product lists, flags). It is refused for
`SITR_SYNC_DB`, `SITR_CLAIM_DB`, `SITR_ENTITLEMENT_PUBKEY`,
`SITR_ENTITLEMENT_PRIVKEY`, `SITR_CLAIM_KEY`, `SITR_POLAR_TOKEN` and
`SITR_V1_CUTOVER`: a blank public key would otherwise make an open server
and a blank cut-over date would never end version 1. Leave a variable out
to unset it.
The claim process also refuses combinations that cannot work:
`SITR_ENTITLEMENT_DAYS` above 7; only one of `SITR_ENTITLEMENT_PRIVKEY` and
`SITR_CLAIM_KEY`; a billing source without both keys; `SITR_POLAR_TOKEN`
without `SITR_POLAR_PRODUCTS` or the reverse; `SITR_APPLE_BUNDLE_ID` without
`SITR_APPLE_PRODUCTS` or the reverse; `SITR_APPLE_SANDBOX` without Apple
configured.

## Self-hosting alternative: systemd and one reverse proxy

Self-hosters can run both processes on one machine with the systemd units
in this directory (`sitr-sync.service`, `sitr-claim.service`) and one
reverse proxy that splits the path, so both share one hostname:

```sh
npm run build:server           # from the repo root
SITR_SYNC_PORT=8787 SITR_SYNC_DB=/var/lib/sitr-sync/blobs.sqlite \
  SITR_TRUSTED_PROXY=1 \
  node --experimental-sqlite server/sync/dist/server.js

SITR_CLAIM_PORT=8788 SITR_TRUSTED_PROXY=1 \
  SITR_ENTITLEMENT_PRIVKEY=... SITR_CLAIM_KEY=... \
  SITR_CLAIM_DB=/var/lib/sitr-claim/claims.sqlite \
  SITR_POLAR_TOKEN=... SITR_POLAR_PRODUCTS=... \
  node --experimental-sqlite server/sync/dist/claim-server.js
```

Example Caddyfile (the path split keeps the minting key out of the sync
process):

```
sync.example.org {
  handle /v1/entitlement/* {
    reverse_proxy 127.0.0.1:8788
  }
  handle {
    reverse_proxy 127.0.0.1:8787
  }
}
```

The official clients call `claim.sitrshield.com` for claims, so a
self-hosted claim service is only reached by clients configured for it.
A self-hoster who does not sell subscriptions runs only the sync process,
with no `SITR_ENTITLEMENT_PUBKEY` (an open server).

## Deployment invariants

- **Single instance.** The rate limiters are per-process and in-memory —
  correct *because* exactly one instance of each process runs. A second
  replica would silently weaken them; scaling out is a redesign, not a
  config change. (Capacity note: at 64 KiB max per blob and one sync per
  household per 30 minutes, one instance with WAL comfortably serves
  100k+ households.)
- **Back up both databases.** SQLite runs in WAL mode; take a nightly
  snapshot of each (`sqlite3 <path> ".backup ..."`, safe while the server
  runs). Losing the claim database unbinds every subscription: the next
  claim per subscription binds afresh, and Apple refund blocks are lost.

## Operational privacy rules (enforced in code — keep them true)

- No request logging. The only startup log line is the listen port.
- Timestamps are stored rounded to the day.
- Blobs idle ≥ ~18 months are garbage-collected hourly.
- The only IP-derived state is the in-memory rate limiters (the sync
  process's create limiter, the claim process's per-IP limits), cleared
  hourly, keyed by SHA-256(ip).
- Auth credentials are stored only as SHA-256 hashes.
- The sync database holds per household an end date (`ent_exp`) and, for
  test households, a delete day; `used_tokens` holds token hashes and
  their `exp`, with no household ID, pruned once expired.
- The claim database (claim process only) holds per subscription a keyed
  hash (marker), a keyed hash of the device's claim secret (binder), the
  last period claimed for, a refund block and a rebind day; markers are
  pruned once their binding is stale and no refund block or recent rebind
  keeps them. Until the cut-over it also holds one keyed hash and `exp`
  per checkout redeemed on the version 1 route. It never stores a token,
  `jti`, claim secret, subscription ID, checkout ID, product, name, email
  or IP address, and nothing from a Polar answer beyond what it computes.
- Billing answers are parsed into allow-listed fields and never logged.

If any change would weaken one of these, docs/sync-protocol.md and
docs/data-flow.md must be updated FIRST (repo rule).
