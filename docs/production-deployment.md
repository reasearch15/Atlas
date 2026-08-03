# Atlas production deployment runbook (repository readiness).
# This document does not deploy anything. Fill VPS/domain specifics before cutover.

## Architecture

Monorepo (`pnpm` workspaces):

| Process | Package | Default port | Production entry |
|---------|---------|--------------|------------------|
| API + WebSocket | `@atlas/backend` | `BACKEND_PORT` (4000) | `apps/backend/dist/apps/backend/src/index.js` via `pnpm --filter @atlas/backend start` |
| UI | `@atlas/frontend` | 3000 | `next start` via `pnpm --filter @atlas/frontend start:production` |
| Telegram worker | `@atlas/telegram-worker` | none | `apps/telegram-worker/dist/apps/telegram-worker/src/worker.js` via `pnpm --filter @atlas/telegram-worker start` |

Dependencies: PostgreSQL 17, Redis 7, S3-compatible object storage (MinIO or managed), Nginx, Cloudflare, systemd.

Durable data:

- PostgreSQL: users, CRM, messages metadata, **encrypted Telegram sessions** (`sessionEncrypted`)
- Object storage: media bytes referenced by `mediaStorageKey` / `thumbnailStorageKey`
- Redis: queues, pub/sub, heartbeats, ephemeral auth OTP — not durable session storage

## Required versions

- Node `>=22.11.0` (pin Node 22 LTS in production)
- pnpm `9.15.4` (see `packageManager` field)
- Prisma migrations via **`pnpm db:migrate:deploy` only** in production

## Environment variables

See `.env.production.example` for categorized placeholders.

Critical migration rule: keep **`TELEGRAM_SESSION_ENCRYPTION_KEY` identical** when moving an existing database, or every Telegram account must re-authorize.

Production startup validation (backend):

- `COOKIE_SECURE=true`
- `ENABLE_DEV_FIXTURES=false`
- `COOKIE_DOMAIN` not `localhost`
- `FRONTEND_ORIGIN` must be `https://...`

## Folder layout (recommended)

```text
/opt/atlas/
  current -> releases/<id>
  releases/<timestamp-ref>/
  shared/.env
  shared/backups/postgres/
  shared/backups/minio/
  shared/scripts/   # optional copies of backup helpers
```

Templates: `deploy/systemd/*.service`, `deploy/nginx/atlas.conf.template`.

## First deployment sequence (VPS — not executed by this repo change)

1. Provision Ubuntu, Node 22, pnpm 9.15.4, Postgres, Redis, MinIO/S3, Nginx, Cloudflare.
2. Create user `atlas`, directories under `/opt/atlas`, place `shared/.env` (mode 600).
3. Install systemd units from `deploy/systemd/` (adjust `pnpm` path if needed).
4. Run `scripts/deploy.sh` with `ATLAS_ROOT`, `ATLAS_REPO_URL`, `ATLAS_REF`.
5. Configure Nginx from template (Arrangement A same-domain recommended).
6. Point Cloudflare; enable WebSockets; SSL Full (Strict) when origin certs exist.
7. `scripts/healthcheck.sh` must pass.

## Data migration sequence (Windows → Ubuntu)

1. Maintenance window: stop writers on Windows.
2. `scripts/backup-postgres.sh` equivalent dump of source DB.
3. Mirror MinIO/S3 bucket (`scripts/backup-minio.sh` or `mc mirror`).
4. Restore dump into VPS Postgres; restore objects into VPS/managed bucket.
5. Place `.env` with **identical** session encryption key (and JWT secrets if keeping cookies).
6. `pnpm db:migrate:deploy` (should be no-op if dump already at head).
7. Start services; verify Telegram accounts stay authorized without re-login.

## Service startup order

1. Postgres, Redis, object storage healthy
2. `atlas-backend`
3. `atlas-frontend`
4. `atlas-telegram-worker`
5. Healthcheck

## Health checks

- Public: `GET /health` (DB + Redis + S3)
- Script: `scripts/healthcheck.sh` (`ATLAS_BACKEND_URL`, `ATLAS_FRONTEND_URL`, optional Redis)
- Worker: Redis key `atlas:telegram-worker:heartbeat`
- Windows local: `pnpm status` (PowerShell) still available

## Cloudflare / Nginx

- Prefer **same-domain** Arrangement A in `deploy/nginx/atlas.conf.template`
- Proxy `/api/`, `/health`, `/ws` to backend; `/` to frontend
- WebSocket: upgrade headers, `proxy_buffering off`, long read timeouts
- Do not blindly trust `X-Forwarded-For`; use Cloudflare IP ranges with `real_ip` if needed

## Telegram sessions

- Stored encrypted in PostgreSQL — migrate DB + keep encryption key
- No `.session` files on disk
- Mid-login Redis OTP attempts will not survive cutover

## Media

- Local disk uploads are not used
- Migrate object storage; DB keys without objects break media

## Rollback

- Application: `scripts/rollback.sh` (symlink + restart + healthcheck)
- Database: **not** automatic — requires explicit destructive confirmation and manual `pg_restore`
- Migrating forward then rolling back app code can break if new migrations are incompatible with old code — take pre-migrate dumps

## Backups

- `scripts/backup-postgres.sh` — custom-format `pg_dump`, retention via `ATLAS_BACKUP_RETENTION_DAYS`
- `scripts/backup-minio.sh` — `mc mirror` to local timestamped dirs; never deletes remote objects

## Common failures

| Symptom | Likely cause |
|---------|--------------|
| Backend exits on boot | Missing env / production validation (`COOKIE_SECURE`, etc.) |
| Login works then refresh fails | `COOKIE_DOMAIN` / `COOKIE_SECURE` / HTTPS mismatch |
| WS disconnected | Nginx missing upgrade / Cloudflare WS off / wrong `NEXT_PUBLIC_API_URL` |
| All Telegram accounts unauthorized | Encryption key changed or incomplete DB restore |
| Media 404 | Object storage not migrated |

## Forbidden against production

- `prisma migrate dev`
- `prisma migrate reset`
- `docker compose down -v`
- Deleting PostgreSQL or MinIO volumes
- Changing `TELEGRAM_SESSION_ENCRYPTION_KEY` during migration
- Deploying with `ENABLE_DEV_FIXTURES=true`
- Committing real `.env` files or dumps
