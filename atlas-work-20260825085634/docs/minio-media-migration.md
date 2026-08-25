# Migrating MinIO media from local Windows Docker to production

Atlas stores Telegram media under keys like:

`workspaces/{workspaceId}/telegram/{accountId}/{chatId}/{messageId}/{fileName}`

PostgreSQL `telegram_messages.media_storage_key` points at these objects. Migrating the DB without the bucket leaves `STORED` rows whose objects 404 — the UI now shows **Media unavailable** instead of a broken image, and media backfill can re-download from Telegram when the peer is still available.

## Source (local Windows Docker)

Typical compose service names: `minio` / `minio-mc`. Find the local bucket (often `atlas`) and endpoint (`http://127.0.0.1:9000`).

```powershell
# List buckets / sample keys
docker exec -it <minio-container> mc ls local/
docker exec -it <minio-container> mc ls local/atlas/workspaces/ --recursive | Select-Object -First 20
```

## Mirror to production

On a machine that can reach both endpoints:

```bash
mc alias set local http://127.0.0.1:9000 "$LOCAL_ACCESS_KEY" "$LOCAL_SECRET_KEY"
mc alias set prod https://s3.platform.atlast.work "$PROD_ACCESS_KEY" "$PROD_SECRET_KEY"
mc mirror --overwrite --preserve local/atlas prod/atlas
```

Or use `scripts/backup-minio.sh` as a template for dump/restore.

## Verify after mirror

```bash
# Counts only — apps/backend/scripts/inbox-diagnostics.mjs
pnpm --filter @atlas/backend inbox:diagnostics
```

Expect `mediaKeysMissingInMinioSample` to drop toward 0 for recently checked keys.

## If objects cannot be mirrored

1. Deploy the UNAVAILABLE / OBJECT_MISSING handling (this release).
2. Trigger media backfill per account: `POST /api/telegram/accounts/:accountId/media/backfill` (Coadmin).
3. Worker re-downloads from Telegram when possible; otherwise messages remain **Media unavailable** without deleting CRM history.

**Do not** make the MinIO bucket world-public. Keep signed URLs or an authenticated proxy.
