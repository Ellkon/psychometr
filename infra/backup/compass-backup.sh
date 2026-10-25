#!/bin/sh
# S-10, NFR-4: encrypted PostgreSQL backups and a measured restore check.
#
#   backup                  pg_dump (custom format) | age -r $AGE_RECIPIENT > /backups/compass-<UTC>.dump.age
#   restore-verify <file>   age -d | pg_restore into a throwaway database, compare row counts with the
#                           live database, report RTO; the throwaway database is always dropped
#   restore <file>          full restore into $PGDATABASE (disaster recovery; the API must be stopped)
#
# The plain dump never touches the disk: it is streamed through age. Output is one JSON line,
# with no data, so it can go to a log.
set -eu
# A failing pg_dump must fail the pipeline, not leave a truncated file marked complete.
set -o pipefail

mode="${1:-}"
backups=/backups
# busybox date has no %N; /proc/uptime has centiseconds.
now_ms() { awk '{ printf "%d", $1 * 1000 }' /proc/uptime; }
tables="users patients patient_identity care_team questionnaire_responses observations rule_evaluations tasks medication_requests dose_log adverse_events alerts audit_events"

counts() {
  db="$1"
  for table in $tables; do
    printf '%s=%s ' "$table" "$(psql -X -tA -d "$db" -c "select count(*) from $table")"
  done
}

case "$mode" in
  backup)
    : "${AGE_RECIPIENT:?AGE_RECIPIENT must hold an age public key}"
    umask 077
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    out="$backups/compass-$stamp.dump.age"
    start="$(now_ms)"
    trap 'rm -f "$out.partial"' EXIT INT TERM HUP
    pg_dump --format=custom --no-password "$PGDATABASE" | age -r "$AGE_RECIPIENT" -o "$out.partial"
    mv "$out.partial" "$out"
    trap - EXIT INT TERM HUP
    sha="$(sha256sum "$out" | cut -d' ' -f1)"
    printf '{"event":"backup.completed","file":"%s","bytes":%s,"sha256":"%s","durationMs":%s}\n' \
      "$(basename "$out")" "$(wc -c < "$out")" "$sha" "$(( $(now_ms) - start ))"
    ;;

  restore-verify)
    file="${2:?usage: restore-verify <file.dump.age>}"
    : "${AGE_IDENTITY_FILE:?AGE_IDENTITY_FILE must point to the age private key}"
    # Random name: parallel runs never drop each other's database.
    target="compass_verify_$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
    start="$(now_ms)"
    # The throwaway database holds a full copy of the data: drop it on any exit or signal.
    trap 'psql -X -q -d postgres -c "drop database if exists \"$target\" with (force)" >/dev/null 2>&1 || true' EXIT INT TERM HUP
    psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "create database \"$target\""
    age -d -i "$AGE_IDENTITY_FILE" "$backups/$(basename "$file")" \
      | pg_restore --exit-on-error --no-password -d "$target"
    rto="$(( $(now_ms) - start ))"
    restored="$(counts "$target")"
    live="$(counts "$PGDATABASE")"
    taken="$(basename "$file" | sed -n 's/^compass-\([0-9T]*Z\)\.dump\.age$/\1/p')"
    printf '{"event":"restore.verified","rtoMs":%s,"backupTakenAt":"%s","restored":"%s","live":"%s"}\n' \
      "$rto" "$taken" "$(echo "$restored" | sed 's/ $//')" "$(echo "$live" | sed 's/ $//')"
    ;;

  restore)
    file="${2:?usage: restore <file.dump.age>}"
    : "${AGE_IDENTITY_FILE:?AGE_IDENTITY_FILE must point to the age private key}"
    start="$(now_ms)"
    age -d -i "$AGE_IDENTITY_FILE" "$backups/$(basename "$file")" \
      | pg_restore --clean --if-exists --exit-on-error --no-password -d "$PGDATABASE"
    printf '{"event":"restore.completed","rtoMs":%s}\n' "$(( $(now_ms) - start ))"
    ;;

  *)
    echo "usage: compass-backup {backup | restore-verify <file> | restore <file>}" >&2
    exit 2
    ;;
esac
