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

# Código do primeiro acesso (/admin/setup, modo single). O certificado do domínio aparece nos logs de Certificate
# Transparency em segundos; sem o código, um robô viraria dono da loja antes do dono de verdade. Sem SETUP_TOKEN no
# .env: gera um (48 hex), guarda no volume (o mesmo nas próximas subidas) e imprime aqui (docker compose logs app).
if [ -n "${SETUP_TOKEN:-}" ]; then
  echo "entrypoint: código de configuração inicial: definido no .env (SETUP_TOKEN)"
else
  token_file="${DATA_DIR:-/data}/.setup-token"
  if [ ! -s "$token_file" ]; then
    (umask 077 && od -An -N24 -tx1 /dev/urandom | tr -d ' \n' > "$token_file") || fail "não foi possível gravar $token_file"
  fi
  SETUP_TOKEN="$(cat "$token_file")"
  export SETUP_TOKEN
  echo "entrypoint: código de configuração inicial (/admin/setup): $SETUP_TOKEN"
fi

cd /app
node /app/cli/src/lib/db/migrate.mjs
# O servidor roda SEM o papel dono: a URL sai do ambiente antes do exec (as CLIs via `docker compose exec` recebem o
# ambiente do container, com ela). O tini vira o PID 1 depois do unset (repassa sinais e recolhe processos órfãos) e
# por isso também não guarda a URL no próprio ambiente.
unset OWNER_DATABASE_URL
exec tini -- node /app/server.js
