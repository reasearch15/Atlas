#!/usr/bin/env bash
# Mirror S3-compatible (MinIO) bucket contents to a local timestamped directory.
# Does not delete remote objects. Requires mc configured or explicit aliases.
set -Eeuo pipefail

ATLAS_BACKUP_DIR="${ATLAS_BACKUP_DIR:-/opt/atlas/shared/backups/minio}"
ATLAS_BACKUP_RETENTION_DAYS="${ATLAS_BACKUP_RETENTION_DAYS:-14}"
ATLAS_S3_ALIAS="${ATLAS_S3_ALIAS:-atlaslocal}"
ATLAS_S3_BUCKET="${ATLAS_S3_BUCKET:-${S3_BUCKET:-atlas}}"
ATLAS_MC="${ATLAS_MC:-mc}"

# Optional one-shot alias configuration (password never printed):
# ATLAS_S3_ENDPOINT ATLAS_S3_ACCESS_KEY_ID ATLAS_S3_SECRET_ACCESS_KEY

mkdir -p "$ATLAS_BACKUP_DIR"
chmod 700 "$ATLAS_BACKUP_DIR" || true

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
outdir="${ATLAS_BACKUP_DIR}/atlas-media-${stamp}"
mkdir -p "$outdir"
chmod 700 "$outdir" || true

log() { printf '[backup-minio] %s\n' "$*"; }
die() { printf '[backup-minio] ERROR: %s\n' "$*" >&2; exit 1; }

command -v "$ATLAS_MC" >/dev/null || die "mc (MinIO client) not found"

if [[ -n "${ATLAS_S3_ENDPOINT:-}" && -n "${ATLAS_S3_ACCESS_KEY_ID:-}" && -n "${ATLAS_S3_SECRET_ACCESS_KEY:-}" ]]; then
  "$ATLAS_MC" alias set "$ATLAS_S3_ALIAS" "$ATLAS_S3_ENDPOINT" "$ATLAS_S3_ACCESS_KEY_ID" "$ATLAS_S3_SECRET_ACCESS_KEY" >/dev/null
fi

src="${ATLAS_S3_ALIAS}/${ATLAS_S3_BUCKET}"
log "mirroring $src -> $outdir"
"$ATLAS_MC" mirror --quiet "$src" "$outdir"

count="$("$ATLAS_MC" ls --recursive "$outdir" 2>/dev/null | wc -l | tr -d ' ')"
log "local object rows listed: ${count}"

if [[ "$count" == "0" ]]; then
  log "WARNING: mirror produced zero listed objects (bucket may be empty)"
fi

if [[ "$ATLAS_BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ ]] && [[ "$ATLAS_BACKUP_RETENTION_DAYS" -gt 0 ]]; then
  find "$ATLAS_BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name 'atlas-media-*' -mtime "+${ATLAS_BACKUP_RETENTION_DAYS}" -exec rm -rf {} + || true
  log "retention: removed local mirrors older than ${ATLAS_BACKUP_RETENTION_DAYS} days"
fi

log "guidance: enable S3 versioning on managed buckets when available; this script never deletes remote objects"
