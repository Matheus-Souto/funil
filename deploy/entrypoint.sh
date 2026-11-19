#!/bin/sh
# Entrada da imagem: `start` (padrão) migra o banco com o papel DONO (OWNER_DATABASE_URL) e inicia o app, que usa o
# papel `app` (DATABASE_URL, sujeito a RLS). As migrações são idempotentes e serializadas por trava no banco: rodam a
# cada início do container. Qualquer outro comando é executado como veio (ex.: `docker compose run --rm app sh`).
set -eu

if [ "${1:-start}" != "start" ]; then
  exec "$@"
fi

fail() {
  echo "entrypoint: $*" >&2
  exit 1
}

# Senha forte: 16+ caracteres e nunca os valores de desenvolvimento. Gere com `openssl rand -hex 24`.
check_password() { # <nome> <valor>
  case "$2" in
    app | owner) fail "$1 com valor de desenvolvimento; gere uma senha com: openssl rand -hex 24" ;;
  esac
  [ "${#2}" -ge 16 ] || fail "$1 precisa ter 16 caracteres ou mais (openssl rand -hex 24)"
}

[ -n "${OWNER_DATABASE_URL:-}" ] || fail "defina OWNER_DATABASE_URL (papel dono, só para migrações)"
[ -n "${DATABASE_URL:-}" ] || fail "defina DATABASE_URL (papel app)"
[ -n "${APP_DB_PASSWORD:-}" ] || fail "defina APP_DB_PASSWORD (senha do papel app)"
check_password APP_DB_PASSWORD "$APP_DB_PASSWORD"
# Senha do papel dono = POSTGRES_PASSWORD do compose (postgres://owner:<senha>@...).
owner_password="${OWNER_DATABASE_URL#*://}"
owner_password="${owner_password%%@*}"
owner_password="${owner_password#*:}"
check_password POSTGRES_PASSWORD "$owner_password"
unset owner_password

cd /app
node /app/cli/src/lib/db/migrate.mjs
# O servidor roda SEM o papel dono: a URL sai do ambiente antes do exec (as CLIs via `docker compose exec` recebem o
# ambiente do container, com ela). O tini vira o PID 1 depois do unset (repassa sinais e recolhe processos órfãos) e
# por isso também não guarda a URL no próprio ambiente.
unset OWNER_DATABASE_URL
exec tini -- node /app/server.js
