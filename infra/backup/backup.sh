#!/bin/sh
# Backup stub (NFR S-10): pg_dump + age encryption, storage in RF.
# Full flow (off-host storage, verified restore, measured RPO/RTO) lands in
# stage 8 of docs/TZ.md § 11. Never commit dumps or keys (.gitignore).
set -eu

BACKUP_DIR="${BACKUP_DIR:-./backups}"
AGE_RECIPIENT="${AGE_RECIPIENT:?set AGE_RECIPIENT to an age public key}"
DATABASE_URL="${DATABASE_URL:?set DATABASE_URL}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/psychometr-$STAMP.sql.gz.age"

pg_dump "$DATABASE_URL" | gzip | age -r "$AGE_RECIPIENT" -o "$OUT"
echo "backup written: $OUT"
