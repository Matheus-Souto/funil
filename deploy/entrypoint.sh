#!/bin/sh
# Entrada da imagem: `start` (padrão) migra o banco com o papel DONO (OWNER_DATABASE_URL) e inicia o app, que usa o
# papel `app` (DATABASE_URL, sujeito a RLS). As migrações são idempotentes: rodam a cada início do container.
# Qualquer outro comando é executado como veio (ex.: `docker compose run --rm app sh`).
set -eu

if [ "${1:-start}" != "start" ]; then
  exec "$@"
fi

fail() {
  echo "entrypoint: $*" >&2
  exit 1
}

[ -n "${OWNER_DATABASE_URL:-}" ] || fail "defina OWNER_DATABASE_URL (papel dono, só para migrações)"
[ -n "${DATABASE_URL:-}" ] || fail "defina DATABASE_URL (papel app)"
[ -n "${APP_DB_PASSWORD:-}" ] || fail "defina APP_DB_PASSWORD (senha do papel app)"
# Senha fraca do papel do app (ou o valor de desenvolvimento) é recusada: gere com `openssl rand -hex 24`.
case "$APP_DB_PASSWORD" in
  app | owner) fail "APP_DB_PASSWORD com valor de desenvolvimento; gere uma senha com: openssl rand -hex 24" ;;
esac
[ "${#APP_DB_PASSWORD}" -ge 16 ] || fail "APP_DB_PASSWORD precisa ter 16 caracteres ou mais (openssl rand -hex 24)"

cd /app
node /app/cli/src/lib/db/migrate.mjs
exec node /app/server.js
