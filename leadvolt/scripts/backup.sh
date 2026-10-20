#!/usr/bin/env bash
set -euo pipefail
umask 077
backup_file=${1:-"backups/leadvolt-$(date -u +%Y%m%dT%H%M%SZ).dump"}
if [[ -e "$backup_file" || -e "$backup_file.sha256" ]]; then echo "Refusing to overwrite an existing backup." >&2; exit 1; fi
mkdir -p "$(dirname "$backup_file")"
cleanup(){ rm -f -- "$backup_file" "$backup_file.sha256"; }
trap cleanup ERR
set -o noclobber
if [[ -n "${DB_CONTAINER:-}" ]]; then
  docker exec "$DB_CONTAINER" pg_dump -U "${DB_OWNER_USER:-leadvolt}" -d "${DB_NAME:-leadvolt}" --format=custom --no-owner --no-privileges > "$backup_file"
else
  PGDATABASE="${BACKUP_DATABASE_URL:?Set a privileged backup connection URL or DB_CONTAINER}" pg_dump --format=custom --no-owner --no-privileges > "$backup_file"
fi
sha256sum "$backup_file" > "$backup_file.sha256"
echo "Backup created with a SHA-256 integrity file. Keep both files in encrypted backup storage."
