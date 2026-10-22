#!/bin/sh
# DB roles bootstrap (NFR S-4): the app connects as `app` (DML only, for
# audit_event INSERT/SELECT only), migrations run as `migrator` (DDL).
# Executed once by the postgres entrypoint on an empty data volume.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	DO \$\$
	BEGIN
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app') THEN
	    CREATE ROLE app LOGIN PASSWORD '${POSTGRES_APP_PASSWORD}';
	  END IF;
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'migrator') THEN
	    CREATE ROLE migrator LOGIN PASSWORD '${POSTGRES_MIGRATOR_PASSWORD}';
	  END IF;
	END
	\$\$;
	GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO app;
	GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO migrator;
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	GRANT USAGE, CREATE ON SCHEMA public TO migrator;
	GRANT USAGE ON SCHEMA public TO app;
EOSQL

echo "db-init: roles app and migrator are ready"
