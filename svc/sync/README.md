# sync

A storage service for syncing a device's extension list and bookmarks across that user's own Helium
installs.

It is intentionally minimal: there are no accounts. A device authenticates with an opaque bearer
token it generates itself; whoever holds the token owns its namespace. The token is never stored —
only its SHA-256 hash is used as the storage key. The server never interprets the synced payload; it
stores opaque JSON blobs per collection.

## API

All requests require an `Authorization: Bearer <token>` header (token: 32–512 chars). Collections
are limited to an allowlist: `extensions`, `bookmarks`.

- `GET /{collection}` → `{ version, updatedAt, data }`. Returns `{ version: 0, data: null }` when
  nothing has been synced yet.
- `PUT /{collection}` with body `{ baseVersion, data }`:
  - `baseVersion` must equal the currently stored version (optimistic concurrency). On success the
    version is incremented and `{ version, updatedAt }` is returned.
  - On mismatch, responds `409` with the current `{ version, data }` so the client can merge and
    retry.
- `GET /healthz` → `ok` (used by the container healthcheck).

## Storage

Backed by Deno KV (SQLite). Set `DENO_KV_PATH` to a writable path on a persistent volume (the
Dockerfile mounts `/data`).

## Config

- `DENO_KV_PATH` — path to the KV database file.
- `SYNC_MAX_BYTES` — max payload size per collection (default 1 MiB).
