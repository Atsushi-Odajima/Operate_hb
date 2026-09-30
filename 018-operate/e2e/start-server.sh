#!/usr/bin/env bash
# Fresh database + sample organization, then start the API serving the production web build.
set -euo pipefail
cd "$(dirname "$0")/../server"
DB=${E2E_DB:-operate_e2e}
./scripts/setup-local-db.sh "$DB" >/dev/null
export DATABASE_ADMIN_URL="postgres://postgres:postgres@127.0.0.1:5432/$DB"
export DATABASE_URL="postgres://operate_app:operate_app@127.0.0.1:5432/$DB"
npx tsx src/cli/seed.ts >/dev/null
# a second tenant, used to prove isolation in the UI
npx tsx -e "import('./src/services/seed.ts').then(m => m.seedSample('other-co', 'Other株式会社')).then(() => process.exit(0))"
export WEB_DIST="$(cd ../web && pwd)/dist" PORT=${E2E_PORT:-8090} NODE_ENV=e2e RUN_WORKER=true
exec npx tsx src/index.ts
