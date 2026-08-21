# sitr-sync — the Family sync server

A blind mailbox: one E2E-encrypted blob per household, which this server
cannot read. Protocol and privacy guarantees: [docs/sync-protocol.md](../../docs/sync-protocol.md).
This code is intentionally small (zero runtime dependencies, node:http +
node:sqlite) so an auditor can read all of it in one sitting.

## Run

Node ≥ 22.5 (`--experimental-sqlite` needed below 23.4; unflagged after).

Two processes, deliberately separate:

- **sync** (`server.js`) — the blob API. Holds at most the entitlement
  *public* key. Parses untrusted traffic.
- **claim** (`claim-server.js`) — `/v1/entitlement/claim/*` only. The only
  process holding the Ed25519 *minting* key and the Polar token, so a
  compromise of the blob parser never yields the key.

```sh
npm run build:server           # from the repo root
SITR_SYNC_PORT=8787 SITR_SYNC_DB=/var/lib/sitr-sync/blobs.sqlite \
  SITR_TRUSTED_PROXY=1 \
  node server/sync/dist/server.js

SITR_CLAIM_PORT=8788 SITR_TRUSTED_PROXY=1 \
  SITR_ENTITLEMENT_PRIVKEY=... SITR_POLAR_TOKEN=... \
  node server/sync/dist/claim-server.js
```

Run behind TLS. Example Caddyfile (the path split is what keeps the
minting key out of the sync process):

```
sync.sitrshield.com {
  handle /v1/entitlement/* {
    reverse_proxy 127.0.0.1:8788
  }
  handle {
    reverse_proxy 127.0.0.1:8787
  }
}
```

`SITR_TRUSTED_PROXY=1` makes rate limiting use the last `X-Forwarded-For`
entry (the hop the proxy appended). Set it ONLY behind your own proxy;
without it the header is ignored so direct clients cannot spoof it.

Alternatives in this directory: `Dockerfile`, `sitr-sync.service` and
`sitr-claim.service` (systemd).

## Deployment invariants

- **Single instance.** The rate limiters are per-process and in-memory —
  correct *because* exactly one instance of each process runs. A second
  replica would silently weaken them; scaling out is a redesign, not a
  config change. (Capacity note: at 64 KiB max per blob and one sync per
  household per 30 minutes, one instance with WAL comfortably serves
  100k+ households.)
- **Back up the database.** SQLite runs in WAL mode; take a nightly
  snapshot with `sqlite3 /var/lib/sitr-sync/blobs.sqlite ".backup ..."`
  (safe while the server runs).

## Operational privacy rules (enforced in code — keep them true)

- No request logging. The only startup log line is the listen port.
- Timestamps are stored rounded to the day.
- Blobs idle ≥ ~18 months are garbage-collected hourly.
- The only IP-derived state is the in-memory create-rate limiter, cleared
  hourly, keyed by SHA-256(ip).
- Auth credentials are stored only as SHA-256 hashes.

If any change would weaken one of these, docs/sync-protocol.md and
docs/data-flow.md must be updated FIRST (repo rule).
