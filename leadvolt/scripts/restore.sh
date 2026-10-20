#!/usr/bin/env bash
set -euo pipefail
umask 077
backup_file=${1:?Supply the verified .dump backup file}
restore_database=${RESTORE_DATABASE_NAME:?Set an existing, empty restore database name}
if [[ "${CONFIRM_RESTORE_DATABASE:-}" != "$restore_database" ]]; then echo "Set CONFIRM_RESTORE_DATABASE to the exact empty destination database name." >&2; exit 1; fi
[[ "$restore_database" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || { echo "Invalid destination database name." >&2; exit 1; }
read -r expected_hash ignored < "$backup_file.sha256"
actual_hash=$(sha256sum "$backup_file")
[[ "${actual_hash%% *}" == "$expected_hash" ]] || { echo "Backup checksum does not match." >&2; exit 1; }
if [[ -n "${DB_CONTAINER:-}" ]]; then
  docker exec -i "$DB_CONTAINER" pg_restore -U "${DB_OWNER_USER:-leadvolt}" -d "$restore_database" --no-owner --no-privileges --exit-on-error --single-transaction < "$backup_file"
else
  restore_url=${RESTORE_DATABASE_URL:?Set RESTORE_DATABASE_URL}
  PGDATABASE="$restore_url" psql -X -A -t -c 'SELECT current_database()' | { read -r actual_db; [[ "$actual_db" == "$restore_database" ]]; }
  PGDATABASE="$restore_url" pg_restore --no-owner --no-privileges --exit-on-error --single-transaction < "$backup_file"
fi
# pg_dump deliberately excludes role credentials and ACLs; restore the application ACLs explicitly.
acl_sql='GRANT USAGE ON SCHEMA public TO leadvolt_app,leadvolt_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO leadvolt_app,leadvolt_worker;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO leadvolt_app,leadvolt_worker;
REVOKE UPDATE,DELETE,TRUNCATE ON audit_log FROM leadvolt_app,leadvolt_worker;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON schema_migrations FROM leadvolt_app,leadvolt_worker;'
if [[ -n "${DB_CONTAINER:-}" ]]; then
  docker exec -i "$DB_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U "${DB_OWNER_USER:-leadvolt}" -d "$restore_database" <<< "$acl_sql" > /dev/null
else
  PGDATABASE="$restore_url" psql -X -v ON_ERROR_STOP=1 <<< "$acl_sql" > /dev/null
fi
echo "Restored into the empty destination and reapplied runtime permissions. Validate the application before switching traffic."
