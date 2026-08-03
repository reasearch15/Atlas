#!/usr/bin/env bash
# Application rollback to the previous release symlink.
# Does NOT restore PostgreSQL unless --restore-database is passed with confirmation.
set -Eeuo pipefail

ATLAS_ROOT="${ATLAS_ROOT:-/opt/atlas}"
ATLAS_SYSTEMD_PREFIX="${ATLAS_SYSTEMD_PREFIX:-atlas}"
RELEASES_DIR="${ATLAS_ROOT}/releases"
CURRENT_LINK="${ATLAS_ROOT}/current"
RESTORE_DATABASE=0
CONFIRM_DB=""

usage() {
  cat <<'EOF'
Usage: rollback.sh [--to RELEASE_DIR] [--restore-database --confirm DESTROY_POST_CUTOVER_DATA]

Application rollback switches /opt/atlas/current and restarts systemd units.
Database rollback is separate and destructive: it can erase writes created after
the backup was taken. Prefer application-only rollback when migrations are
backward-compatible.
EOF
}

TARGET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --to)
      TARGET="${2:?}"
      shift 2
      ;;
    --restore-database)
      RESTORE_DATABASE=1
      shift
      ;;
    --confirm)
      CONFIRM_DB="${2:?}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

log() { printf '[rollback] %s\n' "$*"; }
die() { printf '[rollback] ERROR: %s\n' "$*" >&2; exit 1; }

[[ -d "$RELEASES_DIR" ]] || die "missing $RELEASES_DIR"
[[ -e "$CURRENT_LINK" ]] || die "missing $CURRENT_LINK"

current="$(readlink -f "$CURRENT_LINK")"

if [[ -z "$TARGET" ]]; then
  mapfile -t releases < <(ls -1dt "${RELEASES_DIR}"/* 2>/dev/null || true)
  for candidate in "${releases[@]}"; do
    if [[ "$(readlink -f "$candidate")" != "$current" ]]; then
      TARGET="$candidate"
      break
    fi
  done
fi

[[ -n "$TARGET" && -d "$TARGET" ]] || die "no previous release found"
[[ -f "${TARGET}/package.json" ]] || die "target does not look like an Atlas release: $TARGET"

log "switching current -> $TARGET (from $current)"
ln -sfn "$TARGET" "$CURRENT_LINK"

log "restarting services"
systemctl restart "${ATLAS_SYSTEMD_PREFIX}-backend.service"
systemctl restart "${ATLAS_SYSTEMD_PREFIX}-frontend.service"
systemctl restart "${ATLAS_SYSTEMD_PREFIX}-telegram-worker.service"

sleep 3
bash "${CURRENT_LINK}/scripts/healthcheck.sh" || die "healthcheck failed after application rollback"

if [[ "$RESTORE_DATABASE" -eq 1 ]]; then
  if [[ "$CONFIRM_DB" != "DESTROY_POST_CUTOVER_DATA" ]]; then
    die "refusing database restore without --confirm DESTROY_POST_CUTOVER_DATA"
  fi
  die "database restore is intentionally not automated here; restore a timestamped pg_dump manually after stopping writers (see docs/production-deployment.md)"
fi

log "application rollback complete"
log "NOTE: database schema/data were not modified"
