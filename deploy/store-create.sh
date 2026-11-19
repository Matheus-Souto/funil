#!/bin/sh
# Cria uma loja com dono (MODE=multi). Uso, no servidor:
#   docker compose exec app store-create --name "Minha Loja" --slug minhaloja --owner-email dono@exemplo.com
set -eu
cd /app
exec node /app/cli/scripts/store-create.mjs "$@"
