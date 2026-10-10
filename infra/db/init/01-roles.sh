#!/bin/sh
# Se ejecuta UNA sola vez, al crear el volumen de PostgreSQL.
#  - ubermart_owner: dueño del esquema; solo lo usan las migraciones.
#  - ubermart_app:   usuario de la API, sin permisos para alterar tablas,
#                    ni para modificar/borrar el libro contable o la auditoría.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE ROLE ubermart_owner LOGIN PASSWORD '${OWNER_DB_PASSWORD}';
CREATE ROLE ubermart_app LOGIN PASSWORD '${APP_DB_PASSWORD}' CONNECTION LIMIT 40;

REVOKE ALL ON DATABASE ${POSTGRES_DB} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO ubermart_owner, ubermart_app;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO ubermart_owner;
GRANT USAGE ON SCHEMA public TO ubermart_app;

ALTER DEFAULT PRIVILEGES FOR ROLE ubermart_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ubermart_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ubermart_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ubermart_app;

ALTER ROLE ubermart_app SET statement_timeout = '10s';
ALTER ROLE ubermart_app SET idle_in_transaction_session_timeout = '30s';
EOSQL
