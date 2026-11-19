#!/usr/bin/env bash
# Smoke de deploy: constrói a imagem (deploy/Dockerfile), sobe a pilha do compose.yaml completa (app + Postgres + Caddy,
# mais um Mailpit só do smoke) com DOMAIN=localhost (HTTPS pela CA interna do Caddy), e confere:
#   1. /api/health pelo Caddy; Postgres e app sem portas publicadas; app como usuário não-root;
#   2. o Caddy preserva o Host e manda X-Forwarded-Proto (POST de cartão da mesma origem passa do 403) e HSTS; o
#      entrypoint gera e imprime o código do primeiro acesso (SETUP_TOKEN) quando o .env não traz um;
#   3. fluxo mínimo pelo navegador (tests/deploy/flow.spec.ts): setup -> produto com PDF de ~46 MB -> oferta -> Pix
#      manual -> liberar -> e-mail -> download carimbado (Worker de PDF dentro do container);
#   4. memória: pico do container no fluxo (cgroup memory.peak) abaixo de 700 MiB e nenhum OOM kill (teto 768 MB);
#      ociosa (docker stats) abaixo de 512 MiB; tamanho da imagem;
#   4b. o servidor (tini e node) roda sem OWNER_DATABASE_URL, sem core dump e sem swap; a CLI store-create via
#       `docker compose exec` funciona e avisa da troca obrigatória da senha temporária;
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
  rm -f "$OUT/guia-grande.pdf" "$OUT/again.pdf" # PDFs de ~46 MB
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

step "HSTS no Caddy e código de configuração inicial gerado pelo entrypoint"
HEALTH_HEADERS="$(curl -fsSk -D - -o /dev/null "$BASE/api/health")" || fail "/api/health pelo Caddy (cabeçalhos)"
printf '%s\n' "$HEALTH_HEADERS" | grep -qi '^strict-transport-security: max-age=31536000' \
  || fail "o Caddy não manda Strict-Transport-Security"
# Sem SETUP_TOKEN no .env do smoke: o entrypoint gera, guarda no volume e imprime no log do app.
SETUP_TOKEN="$(dc logs --no-color app | sed -n 's/.*código de configuração inicial (\/admin\/setup): \([0-9a-f]\{48\}\).*/\1/p' | tail -n1)"
[ -n "$SETUP_TOKEN" ] || fail "o entrypoint não imprimiu o código de configuração inicial"

step "fluxo pelo navegador"
# Amostrador dentro do container: maior memória anônima (heap do Next + Worker de PDF + buffers, sem o cache de
# arquivos) a cada 100 ms durante o fluxo. O total com cache vem exato do memory.peak abaixo.
dc exec -d app sh -c 'm=0; while [ ! -f /tmp/anon-stop ]; do a=$(sed -n "s/^anon //p" /sys/fs/cgroup/memory.stat); if [ "$a" -gt "$m" ]; then m=$a; echo "$m" > /tmp/anon-peak; fi; sleep 0.1; done'
TF=$(date +%s)
BASE_URL="$BASE" MAILPIT_URL="http://127.0.0.1:$MAIL_PORT" SMOKE_OUT="$OUT" SETUP_TOKEN="$SETUP_TOKEN" \
  bunx playwright test --config tests/deploy/playwright.config.ts
FLOW_S=$(( $(date +%s) - TF ))

step "memória do app: pico no fluxo (upload e carimbo de ~46 MB) e ociosa"
# cgroup v2 do próprio container: memory.peak = maior uso desde a criação (exato, sem amostragem; inclui o cache de
# arquivos, que conta para o teto); memory.events oom_kill = processos mortos por falta de memória.
PEAK_BYTES=$(dc exec -T app cat /sys/fs/cgroup/memory.peak) || fail "sem /sys/fs/cgroup/memory.peak (precisa de cgroup v2, kernel 5.19+)"
PEAK_MIB=$(( PEAK_BYTES / 1048576 ))
OOM_KILLS=$(dc exec -T app sh -c "sed -n 's/^oom_kill //p' /sys/fs/cgroup/memory.events")
dc exec -T app touch /tmp/anon-stop
ANON_PEAK_MIB=$(( $(dc exec -T app cat /tmp/anon-peak) / 1048576 ))
LIMIT_MIB=$(( $(dc exec -T app cat /sys/fs/cgroup/memory.max) / 1048576 ))
echo "    pico: ${PEAK_MIB} MiB de ${LIMIT_MIB} MiB (só memória dos processos, amostrada: ${ANON_PEAK_MIB} MiB); oom_kill: $OOM_KILLS"
[ "$OOM_KILLS" = "0" ] || fail "OOM kill no container do app durante o fluxo"
[ "$PEAK_MIB" -lt 700 ] || fail "pico de ${PEAK_MIB} MiB (margem mínima de ~10% abaixo do teto de 768 MB)"
APP_CID=$(dc ps -q app)
MEM=$(docker stats --no-stream --format '{{.MemUsage}}' "$APP_CID")
MEM_MIB=$(printf '%s' "$MEM" | node -e '
  const [used] = require("fs").readFileSync(0, "utf8").split("/");
  const m = /([\d.]+)\s*([KMG]i?B)/.exec(used); const f = { KiB: 1 / 1024, KB: 1 / 1024, MiB: 1, MB: 1, GiB: 1024, GB: 1024 };
  console.log(Math.round(Number(m[1]) * f[m[2]]));')
echo "    ociosa: $MEM"
[ "$MEM_MIB" -lt 512 ] || fail "app ocioso com ${MEM_MIB} MiB"

step "servidor sem o papel dono; CLI store-create com ele"
# Ambiente dos processos do servidor (tini = PID 1, e node); o `sh` do exec herda o ambiente do container e fica de fora.
[ "$(dc exec -T app cat /proc/1/comm)" = "tini" ] || fail "PID 1 do app deveria ser o tini"
leaks=$(dc exec -T app sh -c 'n=0; for p in /proc/[0-9]*; do case "$(cat $p/comm 2>/dev/null)" in tini|node) if tr "\0" "\n" < $p/environ | grep -q "^OWNER_DATABASE_URL="; then n=$((n+1)); fi;; esac; done; echo $n')
[ "$leaks" = "0" ] || fail "OWNER_DATABASE_URL no ambiente de $leaks processo(s) do servidor"
# O processo que recebe o cartão: sem core dump e sem swap (cgroup do container).
dc exec -T app sh -c 'grep -Eq "^Max core file size +0 +0 " /proc/1/limits' || fail "core dump deveria estar desligado no app (ulimit core 0)"
[ "$(dc exec -T app cat /sys/fs/cgroup/memory.swap.max)" = "0" ] || fail "o container do app não deveria usar swap (memswap_limit = mem_limit)"
# Saída inteira numa variável (grep -q fecharia o pipe antes das últimas linhas da CLI: EPIPE com pipefail).
cli_out="$(dc exec -T -e MODE=multi -e PLATFORM_DOMAIN=lojas.localhost app \
  store-create --name "Loja CLI" --slug loja-cli --owner-email cli@exemplo.com)" || fail "store-create via docker compose exec"
printf '%s\n' "$cli_out" | grep -q "Loja criada: loja-cli" || fail "store-create via docker compose exec (saída inesperada)"
printf '%s\n' "$cli_out" | grep -q "exige trocar esta senha" || fail "store-create deveria avisar da troca obrigatória da senha temporária"

step "recriar o app: migração repetida e /data persistente"
dc up -d --wait --wait-timeout 180 --force-recreate --no-deps app
dc logs --no-color app | grep -q "migrate: ok" || fail "migração não rodou ao recriar o app"
link="$(cat "$OUT/download-link.txt")"
code=$(curl -sk -o "$OUT/again.pdf" -w '%{http_code}' -X POST -H "origin: $BASE" "$link")
[ "$code" = "200" ] && [ "$(head -c 5 "$OUT/again.pdf")" = "%PDF-" ] || fail "download depois de recriar o app veio $code"

TOTAL_S=$(( $(date +%s) - T0 ))
cat > "$OUT/metrics.json" <<JSON
{ "imageBytes": $IMAGE_BYTES, "imageMB": $(( IMAGE_BYTES / 1000000 )), "idleMemMiB": $MEM_MIB, "idleMem": "$MEM",
  "peakMemMiB": $PEAK_MIB, "peakAnonMiB": $ANON_PEAK_MIB, "memLimitMiB": $LIMIT_MIB, "oomKills": $OOM_KILLS,
  "buildSec": $BUILD_S, "upSec": $UP_S, "flowSec": $FLOW_S, "totalSec": $TOTAL_S }
JSON
cat "$OUT/metrics.json"
