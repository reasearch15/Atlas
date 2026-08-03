#!/usr/bin/env bash
# Linux production build verification (runs inside Node 22 container).
set -Eeuo pipefail

SRC="${1:-/src}"
APP="${2:-/tmp/atlas-build}"

echo "[verify] Node $(node -v) pnpm preparing 9.15.4"
corepack enable
corepack prepare pnpm@9.15.4 --activate
echo "[verify] pnpm $(pnpm -v)"

rm -rf "$APP"
mkdir -p "$APP"
# Copy sources without Windows node_modules / build artifacts
tar -C "$SRC" \
  --exclude=node_modules \
  --exclude=.next \
  --exclude=dist \
  --exclude=coverage \
  --exclude=.git \
  --exclude='*.log' \
  -cf - . | tar -C "$APP" -xf -

cd "$APP"

# Safe placeholder env for generate/build (not production secrets)
cat > .env <<'EOF'
DATABASE_URL=postgresql://atlas:atlas@postgres:5432/atlas_migrate_verify?schema=public
REDIS_URL=redis://redis:6379
S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_BUCKET=atlas
S3_ACCESS_KEY_ID=atlas
S3_SECRET_ACCESS_KEY=change-me-minio-secret
JWT_ACCESS_SECRET=linux-verify-access-secret-at-least-sixty-four-characters-long!!
JWT_REFRESH_SECRET=linux-verify-refresh-secret-at-least-sixty-four-characters-long!
ACCESS_TOKEN_TTL_SECONDS=900
REFRESH_TOKEN_TTL_SECONDS=2592000
COOKIE_DOMAIN=localhost
COOKIE_SECURE=false
FRONTEND_ORIGIN=http://localhost:3000
BACKEND_HOST=0.0.0.0
BACKEND_PORT=4000
TELEGRAM_SESSION_ENCRYPTION_KEY=linux-verify-telegram-session-encryption-key-at-least-64-chars!!
ADMIN_VERIFICATION_TTL_SECONDS=600
ADMIN_VERIFICATION_RESEND_COOLDOWN_SECONDS=60
ADMIN_TRUSTED_DEVICE_TTL_SECONDS=2592000
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_linux_verify_placeholder_key
EMAIL_FROM=Atlas Security <security@example.com>
BOOTSTRAP_ADMIN_EMAIL=
ENABLE_DEV_FIXTURES=false
TELEGRAM_WORKER_ID=telegram-worker-linux-verify
TELEGRAM_LEASE_SECONDS=45
NEXT_PUBLIC_API_URL=http://localhost:4000
NODE_ENV=development
EOF

export NEXT_PUBLIC_API_URL=http://localhost:4000

echo "[verify] pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile

echo "[verify] db:generate"
pnpm db:generate

echo "[verify] build workspace libraries before tests"
pnpm --filter @atlas/shared --filter @atlas/types --filter @atlas/ui build

echo "[verify] typecheck"
pnpm typecheck

echo "[verify] test"
pnpm test

echo "[verify] build"
pnpm build

echo "[verify] compiled entries"
test -f apps/backend/dist/apps/backend/src/index.js
test -f apps/telegram-worker/dist/apps/telegram-worker/src/worker.js
test -d apps/frontend/.next
# Ensure ESM relative imports were rewritten
grep -E 'from "\./config/env\.js"' apps/backend/dist/apps/backend/src/index.js
grep -E 'from "\./env\.js"' apps/telegram-worker/dist/apps/telegram-worker/src/worker.js
grep -E 'from "\./api\.js"' packages/shared/dist/index.js

echo "[verify] migrate status/deploy against disposable DB"
# Pending migrations make `migrate status` exit non-zero; that is expected before deploy.
set +e
pnpm db:migrate:status
status_before=$?
set -e
echo "[verify] migrate status before deploy exit=$status_before (pending expected)"
pnpm db:migrate:deploy
pnpm db:migrate:status
echo "[verify] migrate deploy + post-status OK"

echo "[verify] production entry boot smoke (module load + env parse)"
# Backend should fail fast connecting to infra or listen; module path must resolve.
set +e
timeout 8s pnpm --filter @atlas/backend start > /tmp/backend-start.log 2>&1
backend_ec=$?
set -e
if grep -q 'ERR_MODULE_NOT_FOUND' /tmp/backend-start.log; then
  echo "[verify] backend module resolution failed:"
  cat /tmp/backend-start.log
  exit 1
fi
if grep -q 'Cannot find module' /tmp/backend-start.log; then
  echo "[verify] backend cannot find module:"
  cat /tmp/backend-start.log
  exit 1
fi
echo "[verify] backend start log (truncated):"
tail -n 20 /tmp/backend-start.log || true
echo "[verify] backend exit code after timeout/start: $backend_ec (non-MODULE_NOT_FOUND is acceptable)"

set +e
timeout 8s pnpm --filter @atlas/telegram-worker start > /tmp/worker-start.log 2>&1
worker_ec=$?
set -e
if grep -q 'ERR_MODULE_NOT_FOUND' /tmp/worker-start.log; then
  echo "[verify] worker module resolution failed:"
  cat /tmp/worker-start.log
  exit 1
fi
echo "[verify] worker start log (truncated):"
tail -n 20 /tmp/worker-start.log || true
echo "[verify] worker exit code after timeout/start: $worker_ec"

echo "[verify] frontend start command present"
node -e "const p=require('./apps/frontend/package.json'); if(!p.scripts['start:production']?.includes('next start')) process.exit(1)"

echo "LINUX_PRODUCTION_BUILD_OK"
