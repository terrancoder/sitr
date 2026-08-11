# sitr-sync — the Family sync server

A blind mailbox: one E2E-encrypted blob per household, which this server
cannot read. Protocol and privacy guarantees: [docs/sync-protocol.md](../../docs/sync-protocol.md).
This code is intentionally small (zero runtime dependencies, node:http +
node:sqlite) so an auditor can read all of it in one sitting.

## Run

Node ≥ 22.5 (`--experimental-sqlite` needed below 23.4; unflagged after).

```sh
npm run build:server           # from the repo root
SITR_SYNC_PORT=8787 SITR_SYNC_DB=/var/lib/sitr-sync/blobs.sqlite \
  node server/sync/dist/server.js
```

Run behind TLS. Example Caddyfile:

```
sync.sitrshield.com {
  reverse_proxy 127.0.0.1:8787
}
```

Alternatives in this directory: `Dockerfile`, `sitr-sync.service` (systemd).

## Operational privacy rules (enforced in code — keep them true)

- No request logging. The only startup log line is the listen port.
- Timestamps are stored rounded to the day.
- Blobs idle ≥ ~18 months are garbage-collected hourly.
- The only IP-derived state is the in-memory create-rate limiter, cleared
  hourly, keyed by SHA-256(ip).
- Auth credentials are stored only as SHA-256 hashes.

If any change would weaken one of these, docs/sync-protocol.md and
docs/data-flow.md must be updated FIRST (repo rule).
