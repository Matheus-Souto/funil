#!/bin/sh
# Define (ou apaga) o domínio de uma loja existente (MODE=multi). Uso, no servidor:
#   docker compose exec app store-domain --slug minhaloja --domain checkout.exemplo.com.br
#   docker compose exec app store-domain --slug minhaloja --clear
set -eu
cd /app
exec node /app/cli/src/cli/store-domain.mjs "$@"
