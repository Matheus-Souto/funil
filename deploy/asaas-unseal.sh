#!/bin/sh
# Rollback do cartão isolado: regrava as conexões Asaas em v1 (abríveis pela imagem anterior). Uso, no servidor, com
# CARD_ISOLATED=0 já aplicado (`docker compose up -d`):
#   docker compose exec app asaas-unseal
set -eu
cd /app
exec node /app/cli/scripts/asaas-unseal.mjs "$@"
