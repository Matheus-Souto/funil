#!/usr/bin/env bash
# Smoke de deploy: constrói a imagem (deploy/Dockerfile), sobe a pilha do compose.yaml completa (app + Postgres + Caddy,
# mais um Mailpit só do smoke) com DOMAIN=localhost (HTTPS pela CA interna do Caddy), e confere:
#   1. /api/health pelo Caddy; Postgres e app sem portas publicadas; app como usuário não-root;
#   2. o Caddy preserva o Host e manda X-Forwarded-Proto (POST de cartão da mesma origem passa do 403);
#   3. fluxo mínimo pelo navegador (tests/deploy/flow.spec.ts): setup -> produto -> oferta -> Pix manual -> liberar
#      -> e-mail -> download (Worker de PDF dentro do container);
#   4. memória ociosa do app (docker stats) abaixo do teto de 512 MB; tamanho da imagem;
#   5. recriar o container do app: migrações rodam de novo no banco já migrado e o PDF continua no volume /data.
# Projeto compose com nome único e portas livres em 127.0.0.1: não toca no compose.dev.yaml nem em outros containers.
# Sempre termina com `docker compose down -v` (volumes do smoke apagados). Métricas em <saída>/metrics.json.
set -euo pipefail
export PATH="$HOME/.bun/bin:$PATH"

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

PROJECT="funil-smoke-$(date +%s)-$$"
OUT="$ROOT/.verify/smoke/$PROJECT"
mkdir -p "$OUT"
ENVF="$OUT/env"
T0=$(date +%s)

free_port() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
HTTPS_PORT="$(free_port)"
MAIL_PORT="$(free_port)"
BASE="https://localhost:$HTTPS_PORT"

# Ambiente só deste smoke (--env-file): nunca lê o .env do desenvolvedor.
umask 077
cat > "$ENVF" <<ENV
DOMAIN=localhost
BASE_URL=$BASE
MODE=single
SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
APP_DB_PASSWORD=$(openssl rand -hex 24)
SMOKE_HTTPS_PORT=$HTTPS_PORT
SMOKE_MAIL_PORT=$MAIL_PORT
ENV
umask 022

dc() { docker compose -p "$PROJECT" --env-file "$ENVF" -f compose.yaml -f tests/smoke.compose.yaml "$@"; }

cleanup() {
  local rc=$?
  dc logs --no-color > "$OUT/compose.log" 2>&1 || true
  dc down -v --remove-orphans > "$OUT/down.log" 2>&1 || true
  rm -f "$ENVF" # segredos aleatórios deste smoke
  if [ "$rc" -eq 0 ]; then echo "smoke de deploy: OK em $(( $(date +%s) - T0 ))s ($OUT)"; else echo "smoke de deploy: FALHOU (logs em $OUT)"; fi
}
trap cleanup EXIT

step() { echo "--> $*"; }
fail() { echo "FALHA: $*" >&2; exit 1; }

step "build da imagem"
TB=$(date +%s)
dc build app
BUILD_S=$(( $(date +%s) - TB ))
IMAGE_BYTES=$(docker image inspect -f '{{.Size}}' funil-smoke:latest)

step "subindo a pilha (projeto $PROJECT, HTTPS em $BASE)"
TU=$(date +%s)
dc up -d --wait --wait-timeout 180
UP_S=$(( $(date +%s) - TU ))

step "health pelo Caddy"
# --wait garante app saudável; o Caddy pode levar um instante para emitir o certificado interno de localhost.
curl -fsSk --retry 20 --retry-delay 1 --retry-all-errors "$BASE/api/health" | grep -q '"ok":true' \
  || fail "/api/health pelo Caddy"

step "portas: só o Caddy publica"
# `docker port` lista só as portas publicadas no host: vazio para postgres e app; o Caddy publica (controle do teste).
for svc in postgres app; do
  [ -z "$(docker port "$(dc ps -q "$svc")")" ] || fail "$svc publica porta no host"
done
[ -n "$(docker port "$(dc ps -q caddy)")" ] || fail "caddy deveria publicar a porta HTTPS"
[ "$(dc exec -T app id -u)" != "0" ] || fail "app roda como root"

step "Caddy preserva Host e manda X-Forwarded-Proto (POST de cartão da mesma origem)"
card='{"orderPublicId":"nao-existe","idempotencyKey":"6f1c1f5e-3c55-4a43-9a7b-0d6a3f1f2b11","installments":1}'
code=$(curl -sk -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "origin: $BASE" --data "$card" "$BASE/api/checkout/card")
[ "$code" = "404" ] || fail "POST de cartão da mesma origem deveria chegar ao app (404 pedido inexistente), veio $code"
code=$(curl -sk -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "origin: https://evil.example" --data "$card" "$BASE/api/checkout/card")
[ "$code" = "403" ] || fail "POST de cartão de outra origem deveria ser 403, veio $code"

step "fluxo pelo navegador"
TF=$(date +%s)
BASE_URL="$BASE" MAILPIT_URL="http://127.0.0.1:$MAIL_PORT" SMOKE_OUT="$OUT" \
  bunx playwright test --config tests/deploy/playwright.config.ts
FLOW_S=$(( $(date +%s) - TF ))

step "memória ociosa do app"
APP_CID=$(dc ps -q app)
MEM=$(docker stats --no-stream --format '{{.MemUsage}}' "$APP_CID")
MEM_MIB=$(printf '%s' "$MEM" | node -e '
  const [used] = require("fs").readFileSync(0, "utf8").split("/");
  const m = /([\d.]+)\s*([KMG]i?B)/.exec(used); const f = { KiB: 1 / 1024, KB: 1 / 1024, MiB: 1, MB: 1, GiB: 1024, GB: 1024 };
  console.log(Math.round(Number(m[1]) * f[m[2]]));')
echo "    app: $MEM"
[ "$MEM_MIB" -lt 512 ] || fail "app ocioso com ${MEM_MIB} MiB (teto 512)"

step "recriar o app: migração repetida e /data persistente"
dc up -d --wait --wait-timeout 180 --force-recreate --no-deps app
dc logs --no-color app | grep -q "migrate: ok" || fail "migração não rodou ao recriar o app"
link="$(cat "$OUT/download-link.txt")"
code=$(curl -sk -o "$OUT/again.pdf" -w '%{http_code}' -X POST -H "origin: $BASE" "$link")
[ "$code" = "200" ] && [ "$(head -c 5 "$OUT/again.pdf")" = "%PDF-" ] || fail "download depois de recriar o app veio $code"

TOTAL_S=$(( $(date +%s) - T0 ))
cat > "$OUT/metrics.json" <<JSON
{ "imageBytes": $IMAGE_BYTES, "imageMB": $(( IMAGE_BYTES / 1000000 )), "idleMemMiB": $MEM_MIB, "idleMem": "$MEM",
  "buildSec": $BUILD_S, "upSec": $UP_S, "flowSec": $FLOW_S, "totalSec": $TOTAL_S }
JSON
cat "$OUT/metrics.json"
