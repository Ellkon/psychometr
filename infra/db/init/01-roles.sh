#!/bin/sh
# Runs only on a new volume. psql's quoted variables safely escape passwords.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$POSTGRES_APP_PASSWORD" \
  --set=migrator_password="$POSTGRES_MIGRATOR_PASSWORD" \
  --set=db_name="$POSTGRES_DB" <<'SQL'
CREATE ROLE app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'app_password';
CREATE ROLE migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'migrator_password';
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
-- Bound runaway queries, stuck transactions and connection floods per role.
ALTER ROLE app CONNECTION LIMIT 30;
ALTER ROLE app SET search_path = public;
ALTER ROLE app SET statement_timeout = '10s';
ALTER ROLE app SET lock_timeout = '5s';
ALTER ROLE app SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE migrator CONNECTION LIMIT 2;
ALTER ROLE migrator SET search_path = public;
GRANT CONNECT ON DATABASE :"db_name" TO app, migrator;
GRANT CREATE ON DATABASE :"db_name" TO migrator;
GRANT USAGE, CREATE ON SCHEMA public TO migrator;
GRANT USAGE ON SCHEMA public TO app;
SQL
