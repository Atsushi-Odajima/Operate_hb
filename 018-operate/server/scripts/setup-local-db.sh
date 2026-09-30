#!/usr/bin/env bash
# Local development only: creates roles + database. Production: see docs/OPERATIONS.md
set -euo pipefail
DB=${1:-operate}
psql_su() { if [ "$(id -u)" = "0" ]; then su postgres -c "psql -v ON_ERROR_STOP=1 -q $*"; else psql -v ON_ERROR_STOP=1 -q "$@"; fi; }
psql_su "-c \"DO \\\$\\\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='operate_app') THEN CREATE ROLE operate_app LOGIN PASSWORD 'operate_app' NOSUPERUSER NOBYPASSRLS; END IF; END \\\$\\\$;\""
psql_su "-c \"DROP DATABASE IF EXISTS $DB WITH (FORCE)\""
psql_su "-c \"CREATE DATABASE $DB TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8'\""
echo "database $DB ready"
