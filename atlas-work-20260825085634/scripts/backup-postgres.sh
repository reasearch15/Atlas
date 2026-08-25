#!/usr/bin/env bash
# Timestamped PostgreSQL logical backup (custom format). Does not print passwords.
set -Eeuo pipefail

ATLAS_BACKUP_DIR="${ATLAS_BACKUP_DIR:-/opt/atlas/shared/backups/postgres}"
ATLAS_PG_DUMP="${ATLAS_PG_DUMP:-pg_dump}"
ATLAS_BACKUP_RETENTION_DAYS="${ATLAS_BACKUP_RETENTION_DAYS:-14}"
DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}"
# Prisma query params (e.g. ?schema=public) break pg_dump - strip them.
PG_DUMP_URL="${DATABASE_URL%%\?schema=*}"

mkdir -p "$ATLAS_BACKUP_DIR"
chmod 700 "$ATLAS_BACKUP_DIR" || true

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
outfile="${ATLAS_BACKUP_DIR}/atlas-${stamp}.dump"

log() { printf '[backup-postgres] %s\n' "$*"; }
die() { printf '[backup-postgres] ERROR: %s\n' "$*" >&2; exit 1; }

command -v "$ATLAS_PG_DUMP" >/dev/null || die "pg_dump not found"

log "writing $outfile"
# pg_dump accepts connection URIs; never pass Prisma ?schema= and never echo credentials.
"$ATLAS_PG_DUMP" --format=custom --no-owner --no-acl --file="$outfile" "$PG_DUMP_URL"

[[ -s "$outfile" ]] || die "backup file missing or empty: $outfile"
chmod 600 "$outfile" || true
log "backup ok ($(wc -c <"$outfile") bytes)"

if [[ "$ATLAS_BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ ]] && [[ "$ATLAS_BACKUP_RETENTION_DAYS" -gt 0 ]]; then
  find "$ATLAS_BACKUP_DIR" -type f -name 'atlas-*.dump' -mtime "+${ATLAS_BACKUP_RETENTION_DAYS}" -delete || true
  log "retention: deleted dumps older than ${ATLAS_BACKUP_RETENTION_DAYS} days"
fi
