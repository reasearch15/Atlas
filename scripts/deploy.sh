#!/usr/bin/env bash
# Atlas release deploy script (templates for Ubuntu). Do not invent hostnames.
# Required env (see docs/production-deployment.md):
#   ATLAS_ROOT=/opt/atlas
#   ATLAS_REPO_URL=...
#   ATLAS_REF=main            # commit SHA or tag
# Optional:
#   ATLAS_KEEP_RELEASES=5
#   ATLAS_RUN_TESTS=0
#   ATLAS_SYSTEMD_PREFIX=atlas
set -Eeuo pipefail

ATLAS_ROOT="${ATLAS_ROOT:-/opt/atlas}"
ATLAS_REF="${ATLAS_REF:?ATLAS_REF (commit/tag) is required}"
ATLAS_REPO_URL="${ATLAS_REPO_URL:?ATLAS_REPO_URL is required}"
ATLAS_KEEP_RELEASES="${ATLAS_KEEP_RELEASES:-5}"
ATLAS_RUN_TESTS="${ATLAS_RUN_TESTS:-0}"
ATLAS_SYSTEMD_PREFIX="${ATLAS_SYSTEMD_PREFIX:-atlas}"
NODE_MIN="22.11.0"
PNPM_EXPECTED="9.15.4"

RELEASES_DIR="${ATLAS_ROOT}/releases"
SHARED_DIR="${ATLAS_ROOT}/shared"
CURRENT_LINK="${ATLAS_ROOT}/current"
LOCK_FILE="${ATLAS_ROOT}/.deploy.lock"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RELEASE_ID="${TIMESTAMP}-${ATLAS_REF}"
RELEASE_DIR="${RELEASES_DIR}/${RELEASE_ID}"
HEALTHCHECK="${ATLAS_ROOT}/current/scripts/healthcheck.sh"

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

cleanup_lock() {
  if [[ -n "${LOCK_HELD:-}" ]]; then
    rm -f "$LOCK_FILE"
  fi
}
trap cleanup_lock EXIT

acquire_lock() {
  if [[ -e "$LOCK_FILE" ]]; then
    die "another deploy holds $LOCK_FILE"
  fi
  printf '%s\n' "$$" >"$LOCK_FILE"
  LOCK_HELD=1
}

version_ge() {
  # returns 0 if $1 >= $2
  printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1 | grep -qx "$2"
}

verify_tooling() {
  command -v node >/dev/null || die "node not found"
  command -v pnpm >/dev/null || die "pnpm not found"
  command -v git >/dev/null || die "git not found"
  local node_v pnpm_v
  node_v="$(node -v | sed 's/^v//')"
  pnpm_v="$(pnpm -v)"
  version_ge "$node_v" "$NODE_MIN" || die "Node $node_v < required $NODE_MIN"
  [[ "$pnpm_v" == "$PNPM_EXPECTED" ]] || die "pnpm $pnpm_v != required $PNPM_EXPECTED"
  [[ -f "${SHARED_DIR}/.env" ]] || die "missing ${SHARED_DIR}/.env"
}

rollback_on_failure() {
  local previous=$1
  log "deploy failed; restoring previous release $previous"
  ln -sfn "$previous" "$CURRENT_LINK"
  systemctl restart "${ATLAS_SYSTEMD_PREFIX}-backend.service" || true
  systemctl restart "${ATLAS_SYSTEMD_PREFIX}-frontend.service" || true
  systemctl restart "${ATLAS_SYSTEMD_PREFIX}-telegram-worker.service" || true
}

prune_releases() {
  mapfile -t releases < <(ls -1dt "${RELEASES_DIR}"/* 2>/dev/null || true)
  local count=${#releases[@]}
  if (( count <= ATLAS_KEEP_RELEASES )); then
    return 0
  fi
  local i
  for (( i=ATLAS_KEEP_RELEASES; i<count; i++ )); do
    local candidate=${releases[$i]}
    if [[ "$(readlink -f "$CURRENT_LINK")" == "$(readlink -f "$candidate")" ]]; then
      continue
    fi
    log "pruning old release $candidate"
    rm -rf "$candidate"
  done
}

main() {
  acquire_lock
  verify_tooling
  mkdir -p "$RELEASES_DIR" "$SHARED_DIR/backups/postgres" "$SHARED_DIR/backups/minio"

  local previous=""
  if [[ -L "$CURRENT_LINK" || -e "$CURRENT_LINK" ]]; then
    previous="$(readlink -f "$CURRENT_LINK")"
  fi

  log "creating release $RELEASE_DIR"
  git clone "$ATLAS_REPO_URL" "$RELEASE_DIR"
  git -C "$RELEASE_DIR" fetch --tags --force origin "$ATLAS_REF"
  git -C "$RELEASE_DIR" checkout --force "$ATLAS_REF"

  ln -sfn "${SHARED_DIR}/.env" "${RELEASE_DIR}/.env"

  cd "$RELEASE_DIR"
  log "pnpm install --frozen-lockfile"
  pnpm install --frozen-lockfile

  log "prisma generate"
  pnpm db:generate

  log "typecheck"
  pnpm typecheck

  if [[ "$ATLAS_RUN_TESTS" == "1" ]]; then
    log "test"
    pnpm test
  else
    log "skipping tests (ATLAS_RUN_TESTS=0)"
  fi

  log "build"
  pnpm build

  # Load DATABASE_URL for backup without printing secrets.
  if [[ -z "${DATABASE_URL:-}" && -f "${RELEASE_DIR}/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "${RELEASE_DIR}/.env"
    set +a
  fi
  DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required for pre-migrate backup}"
  # Prisma ?schema= must never be passed to pg_dump.
  PG_DUMP_URL="${DATABASE_URL%%\?schema=*}"
  export DATABASE_URL
  export PG_DUMP_URL

  if [[ -x "${SHARED_DIR}/scripts/backup-postgres.sh" ]]; then
    log "pre-migrate postgres backup"
    ATLAS_BACKUP_DIR="${SHARED_DIR}/backups/postgres" \
      DATABASE_URL="$DATABASE_URL" \
      bash "${SHARED_DIR}/scripts/backup-postgres.sh"
  elif [[ -x "${RELEASE_DIR}/scripts/backup-postgres.sh" ]]; then
    log "pre-migrate postgres backup"
    ATLAS_BACKUP_DIR="${SHARED_DIR}/backups/postgres" \
      DATABASE_URL="$DATABASE_URL" \
      bash "${RELEASE_DIR}/scripts/backup-postgres.sh"
  else
    log "pre-migrate postgres backup (inline)"
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    outfile="${SHARED_DIR}/backups/postgres/atlas-${stamp}.dump"
    mkdir -p "${SHARED_DIR}/backups/postgres"
    chmod 700 "${SHARED_DIR}/backups/postgres" || true
    pg_dump --format=custom --no-owner --no-acl --file="$outfile" "$PG_DUMP_URL"
    [[ -s "$outfile" ]] || die "backup file missing or empty: $outfile"
    chmod 600 "$outfile" || true
  fi

  log "prisma migrate deploy"
  pnpm db:migrate:deploy

  log "atomic symlink switch"
  ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"

  # Install/refresh systemd unit templates from the release so GitHub deploys
  # never require manual VPS unit edits (e.g. frontend 127.0.0.1:3200).
  if [[ -d "${CURRENT_LINK}/deploy/systemd" ]]; then
    log "syncing systemd units from release"
    install -m 644 "${CURRENT_LINK}/deploy/systemd/atlas-backend.service" \
      "/etc/systemd/system/${ATLAS_SYSTEMD_PREFIX}-backend.service"
    install -m 644 "${CURRENT_LINK}/deploy/systemd/atlas-frontend.service" \
      "/etc/systemd/system/${ATLAS_SYSTEMD_PREFIX}-frontend.service"
    install -m 644 "${CURRENT_LINK}/deploy/systemd/atlas-telegram-worker.service" \
      "/etc/systemd/system/${ATLAS_SYSTEMD_PREFIX}-telegram-worker.service"
    systemctl daemon-reload
  fi

  log "restart services"
  systemctl restart "${ATLAS_SYSTEMD_PREFIX}-backend.service"
  systemctl restart "${ATLAS_SYSTEMD_PREFIX}-frontend.service"
  systemctl restart "${ATLAS_SYSTEMD_PREFIX}-telegram-worker.service"

  sleep 3
  HEALTHCHECK="${CURRENT_LINK}/scripts/healthcheck.sh"
  export ATLAS_FRONTEND_URL="${ATLAS_FRONTEND_URL:-http://127.0.0.1:3200}"
  export ATLAS_BACKEND_URL="${ATLAS_BACKEND_URL:-http://127.0.0.1:4000}"
  if [[ -x "$HEALTHCHECK" ]]; then
    if ! bash "$HEALTHCHECK"; then
      if [[ -n "$previous" ]]; then
        rollback_on_failure "$previous"
      fi
      die "healthcheck failed after deploy"
    fi
  else
    die "healthcheck script missing at $HEALTHCHECK"
  fi

  prune_releases
  log "deploy complete: $RELEASE_ID"
}

main "$@"
