#!/bin/sh
# Rollback para uma imagem anterior ao cartão isolado: regrava as conexões Asaas em v1 (abríveis pela imagem
# anterior). Uso, no servidor, com o app desta versão no ar, e troque a imagem logo depois (docs/seguranca-pagamento.md):
#   docker compose exec app asaas-unseal
# A saída vai para este terminal (não para `docker compose logs app`).
set -eu
cd /app
exec node /app/cli/scripts/asaas-unseal.mjs "$@"
