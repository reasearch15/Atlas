#!/usr/bin/env bash
# Atlas DEVELOPMENT deploy — always deploys messenger-dev into /opt/atlas-dev.
# Production must use /opt/atlas/deploy.sh. This script never restarts prod services.
set -Eeuo pipefail

APP_ROOT="/opt/atlas-dev"
PROD_ROOT="/opt/atlas"
RELEASES_DIR="$APP_ROOT/releases"
CURRENT_LINK="$APP_ROOT/current"
SHARED_ENV="$APP_ROOT/shared/.env"
BACKUP_DIR="$APP_ROOT/shared/backups/postgres"
REPO="git@github.com:reasearch15/Atlas.git"
BRANCH="messenger-dev"
KEEP_RELEASES=5
LOCK_FILE="/run/lock/atlas-dev-deploy.lock"

BACKEND_HOST_PORT="127.0.0.1:4201"
FRONTEND_HOST_PORT="127.0.0.1:3201"
BACKEND_HEALTH="http://${BACKEND_HOST_PORT}/health"
FRONTEND_HEALTH="http://${FRONTEND_HOST_PORT}/login"
PUBLIC_URL="https://dev.atlast.work"

SERVICES=(
  atlas-dev-backend
  atlas-dev-frontend
  atlas-dev-telegram-worker
)

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Safety: never operate on production
# ---------------------------------------------------------------------------
cwd="$(pwd -P 2>/dev/null || pwd)"
case "$cwd" in
  "$PROD_ROOT"|"$PROD_ROOT"/*)
    die "Refusing to run inside production tree ($PROD_ROOT). Use /opt/atlas-dev."
    ;;
esac

script_path="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || realpath "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
case "$script_path" in
  "$PROD_ROOT"|"$PROD_ROOT"/*)
    die "Refusing to run a deploydev script located under $PROD_ROOT."
    ;;
esac

[[ "$APP_ROOT" == "$PROD_ROOT" ]] && die "APP_ROOT must not equal production root"
[[ -d "$APP_ROOT" ]] || die "Missing development root: $APP_ROOT"
[[ -d "$PROD_ROOT" ]] || die "Production root missing (expected at $PROD_ROOT for isolation checks)"

# Ignore any CLI branch argument — development always deploys messenger-dev.
if [[ "${1:-}" != "" && "${1:-}" != "$BRANCH" ]]; then
  die "deploydev.sh always deploys '$BRANCH' (refusing argument: $1)"
fi

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  die "Another Atlas DEV deployment is already running."
fi

timestamp="$(date +%Y%m%d%H%M%S)"
release_dir="$RELEASES_DIR/$timestamp"
previous_release=""
prod_head_before=""

if [[ -L "$CURRENT_LINK" ]]; then
  previous_release="$(readlink -f "$CURRENT_LINK")"
fi

if [[ -L "$PROD_ROOT/current" || -d "$PROD_ROOT/current" ]]; then
  prod_head_before="$(git -C "$PROD_ROOT/current" -c safe.directory=* rev-parse HEAD 2>/dev/null || true)"
fi

rollback() {
  code=$?
  if [[ $code -eq 0 ]]; then
    return
  fi

  echo
  echo "DEV deployment failed. Restoring previous development release."

  if [[ -n "$previous_release" && -d "$previous_release" ]]; then
    ln -sfn "$previous_release" "$CURRENT_LINK"
    chown -h atlas:atlas "$CURRENT_LINK"

    systemctl restart atlas-dev-backend || true
    systemctl restart atlas-dev-frontend || true
    systemctl restart atlas-dev-telegram-worker || true
  fi

  echo "Development database was not automatically restored."
  echo "Production services were not restarted."
  exit "$code"
}

trap rollback ERR

echo "== Atlas DEV Deploy =="
echo "Environment: Development"
echo "Branch: $BRANCH"
echo "Release: $release_dir"

test -f "$SHARED_ENV" || die "Missing $SHARED_ENV"

systemctl is-active --quiet postgresql@16-main
systemctl is-active --quiet redis-server
systemctl is-active --quiet atlas-minio

mkdir -p "$RELEASES_DIR" "$BACKUP_DIR"
chown atlas:atlas "$RELEASES_DIR" "$BACKUP_DIR"

echo
echo "== Clone latest $BRANCH =="

sudo -u atlas git clone \
  --branch "$BRANCH" \
  --single-branch \
  "$REPO" \
  "$release_dir"

# Ensure we have the absolute tip of messenger-dev (fetch + hard reset).
sudo -u atlas git -C "$release_dir" fetch --force origin "$BRANCH"
sudo -u atlas git -C "$release_dir" checkout --force -B "$BRANCH" "origin/$BRANCH"

# Clean git state in the release (clone should already be clean).
if [[ -n "$(sudo -u atlas git -C "$release_dir" status --porcelain)" ]]; then
  die "Release git working tree is not clean after checkout"
fi

ln -sfn "$SHARED_ENV" "$release_dir/.env"
chown -h atlas:atlas "$release_dir/.env"

commit="$(sudo -u atlas git -C "$release_dir" rev-parse HEAD)"
branch_name="$(sudo -u atlas git -C "$release_dir" rev-parse --abbrev-ref HEAD)"
[[ "$branch_name" == "$BRANCH" ]] || die "Expected branch $BRANCH, got $branch_name"

echo "Commit: $commit"

cd "$release_dir"

echo
echo "== Install dependencies =="
sudo -u atlas pnpm install --frozen-lockfile

echo
echo "== Generate Prisma =="
sudo -u atlas pnpm db:generate

echo
echo "== Typecheck =="
sudo -u atlas pnpm typecheck

echo
echo "== Build =="
sudo -u atlas pnpm build

test -f apps/backend/dist/apps/backend/src/index.js
test -f apps/telegram-worker/dist/apps/telegram-worker/src/worker.js
test -d apps/frontend/.next

echo
echo "== Backup development database =="
set -a
# shellcheck disable=SC1091
source "$SHARED_ENV"
set +a

backup_file="$BACKUP_DIR/atlas-dev-predeploy-$timestamp.dump"
PG_DUMP_URL="${DATABASE_URL%%\?schema=*}"

# Guard: never dump production DB by accident
case "$PG_DUMP_URL" in
  */atlas_dev|*/atlas_dev\?*|*@127.0.0.1:5432/atlas_dev*)
    ;;
  *)
    # Accept URL forms that contain /atlas_dev
    if [[ "$PG_DUMP_URL" != *"/atlas_dev"* ]]; then
      die "DATABASE_URL does not target atlas_dev — refusing backup"
    fi
    ;;
esac

sudo -u atlas pg_dump \
  --format=custom \
  --no-owner \
  --no-acl \
  --file="$backup_file" \
  "$PG_DUMP_URL"

test -s "$backup_file"
chmod 600 "$backup_file"
chown atlas:atlas "$backup_file"
echo "Backup created: $backup_file"

echo
echo "== Apply migrations (development DB only) =="
sudo -u atlas pnpm db:migrate:deploy

echo
echo "== Activate release =="
ln -sfn "$release_dir" "$CURRENT_LINK"
chown -h atlas:atlas "$CURRENT_LINK"

echo
echo "== Restart development services only =="
systemctl restart atlas-dev-backend
sleep 2
systemctl restart atlas-dev-frontend
sleep 2
systemctl restart atlas-dev-telegram-worker
sleep 3

echo
echo "== Health checks =="
health_ok=1

if curl -fsS --max-time 15 "$BACKEND_HEALTH" >/dev/null; then
  backend_health_status="ok"
else
  backend_health_status="FAIL"
  health_ok=0
fi

if curl -fsS --max-time 15 "$FRONTEND_HEALTH" >/dev/null; then
  frontend_health_status="ok"
else
  frontend_health_status="FAIL"
  health_ok=0
fi

if ! systemctl is-active --quiet atlas-dev-backend; then
  backend_health_status="FAIL (inactive)"
  health_ok=0
fi
if ! systemctl is-active --quiet atlas-dev-frontend; then
  frontend_health_status="FAIL (inactive)"
  health_ok=0
fi
if ! systemctl is-active --quiet atlas-dev-telegram-worker; then
  health_ok=0
fi

# Isolation: production must be untouched
prod_head_after="$(git -C "$PROD_ROOT/current" -c safe.directory=* rev-parse HEAD 2>/dev/null || true)"
if [[ -n "$prod_head_before" && "$prod_head_before" != "$prod_head_after" ]]; then
  die "Production commit changed during DEV deploy ($prod_head_before -> $prod_head_after)"
fi

echo
echo "== Clean old development releases =="
mapfile -t old_releases < <(
  find "$RELEASES_DIR" \
    -mindepth 1 \
    -maxdepth 1 \
    -type d \
    -printf '%T@ %p\n' |
  sort -rn |
  awk -v keep="$KEEP_RELEASES" 'NR > keep {print $2}'
)

for old_release in "${old_releases[@]:-}"; do
  if [[ "$old_release" != "$(readlink -f "$CURRENT_LINK")" ]]; then
    rm -rf -- "$old_release"
  fi
done

echo
echo "Environment: Development"
echo "Branch: $BRANCH"
echo "Commit: $commit"
echo "Release: $release_dir"
echo "Frontend: http://${FRONTEND_HOST_PORT}  (public: ${PUBLIC_URL})"
echo "Backend: http://${BACKEND_HOST_PORT}"
echo "Health: backend=${backend_health_status} frontend=${frontend_health_status}"

if [[ "$health_ok" -ne 1 ]]; then
  die "Health checks failed"
fi

echo
echo "DEPLOYMENT COMPLETE (Development)"
echo "URL: $PUBLIC_URL"
echo "Production unchanged: ${prod_head_after:-unknown}"
