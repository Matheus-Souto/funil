#!/usr/bin/env bash
# Verificação ponta a ponta: lint/tipos/testes, build, app de produção com o cartão isolado (serviço `card` empacotado)
# + Playwright mobile.
# Uso: bash scripts/verify.sh [--deploy]
# Grava .verify/<sha>.json (carimbo) e .verify/state.json (contador de rodadas falhas).
set -uo pipefail
export PATH="$HOME/.bun/bin:$PATH"

DEPLOY=0
[ "${1:-}" = "--deploy" ] && DEPLOY=1

ROOT="$(git rev-parse --show-toplevel)" || { echo "verify: fora de um repositório git" >&2; exit 1; }
cd "$ROOT" || exit 1

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
SHA="$(git rev-parse HEAD)"
SHORT="$(git rev-parse --short=8 HEAD)"
STATE=.verify/state.json
mkdir -p .verify

# --- Etapa 1: trava de 3 rodadas ---------------------------------------------------------
# state.json guarda falhas consecutivas por branch e um contador global (entre branches):
#   { "global": N, "branches": { "<branch>": N, ... } }
# Falha: soma 1 no branch e no global. Sucesso: zera o branch e o global.
# Trava quando o branch atual OU o global chega a 3 (trocar de branch não escapa da trava).
# Falha de infraestrutura (sinal INT/TERM, timeout, Docker indisponível, porta ocupada, instalação/rede) NÃO conta como
# rodada de correção (INFRA=1): só falha de check, build, e2e ou deploy conta.
declare -A S_BRANCHES=()
S_GLOBAL=0
read_state() {
  S_BRANCHES=(); S_GLOBAL=0
  [ -f "$STATE" ] || return 0
  local line name n
  S_GLOBAL="$(sed -n 's/^  "global": \([0-9][0-9]*\),\{0,1\}$/\1/p' "$STATE" | head -n1)"
  S_GLOBAL="${S_GLOBAL:-0}"
  while IFS= read -r line; do
    name="$(printf '%s' "$line" | sed -n 's/^    "\(.*\)": [0-9][0-9]*,\{0,1\}$/\1/p')"
    n="$(printf '%s' "$line" | sed -n 's/^    ".*": \([0-9][0-9]*\),\{0,1\}$/\1/p')"
    [ -n "$name" ] && S_BRANCHES["$name"]="$n"
  done < "$STATE"
}
write_state() {
  local k keys=() i last
  for k in "${!S_BRANCHES[@]}"; do keys+=("$k"); done
  {
    echo "{"
    echo "  \"global\": $S_GLOBAL,"
    echo "  \"branches\": {"
    last=$(( ${#keys[@]} - 1 ))
    for i in "${!keys[@]}"; do
      if [ "$i" -lt "$last" ]; then echo "    \"${keys[$i]}\": ${S_BRANCHES[${keys[$i]}]},"; else echo "    \"${keys[$i]}\": ${S_BRANCHES[${keys[$i]}]}"; fi
    done
    echo "  }"
    echo "}"
  } > "$STATE"
}
read_state
if [ "${S_BRANCHES[$BRANCH]:-0}" -ge 3 ] || [ "$S_GLOBAL" -ge 3 ]; then
  echo "PARE: 3 rodadas de correção falharam. Chame o dono do projeto."
  exit 3
fi

RUN_DIR=".verify/runs/$SHA"
rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR"

STARTED_AT="$(date -u +%FT%TZ)"
T0="$(date +%s.%N)"
STEPS=()
APP_PID=""
FAKE_PID=""
CARD_PID=""
DB_NAME="verify_${SHORT}"
DB_CREATED=0
FINISHED=0
INFRA=0

elapsed() { awk -v a="$1" -v b="$(date +%s.%N)" 'BEGIN { printf "%.1f", b - a }'; }

stop_app() {
  if [ -n "$APP_PID" ]; then
    kill "$APP_PID" 2>/dev/null
    wait "$APP_PID" 2>/dev/null
    APP_PID=""
  fi
}

stop_card() {
  if [ -n "$CARD_PID" ]; then
    kill "$CARD_PID" 2>/dev/null
    wait "$CARD_PID" 2>/dev/null
    CARD_PID=""
  fi
}

stop_fake() {
  if [ -n "$FAKE_PID" ]; then
    kill "$FAKE_PID" 2>/dev/null
    wait "$FAKE_PID" 2>/dev/null
    FAKE_PID=""
  fi
}

drop_db() {
  if [ "$DB_CREATED" = 1 ]; then
    docker compose -f compose.dev.yaml exec -T db psql -U owner -d postgres -q \
      -c "drop database if exists \"$DB_NAME\" with (force)" >/dev/null 2>&1
    DB_CREATED=0
  fi
}

# Etapa 9 (sempre) + etapa 10: derruba app e banco, grava carimbo e estado.
finish() {
  local ok="$1"
  [ "$FINISHED" = 1 ] && return
  FINISHED=1
  stop_app
  stop_card
  stop_fake
  drop_db

  local dirty=false
  [ -n "$(git status --porcelain)" ] && dirty=true
  local total; total="$(elapsed "$T0")"

  {
    echo "{"
    echo "  \"sha\": \"$SHA\","
    echo "  \"branch\": \"$BRANCH\","
    echo "  \"dirty\": $dirty,"
    echo "  \"startedAt\": \"$STARTED_AT\","
    echo "  \"durationSec\": $total,"
    echo "  \"steps\": ["
    local i last=$(( ${#STEPS[@]} - 1 ))
    for i in "${!STEPS[@]}"; do
      if [ "$i" -lt "$last" ]; then echo "    ${STEPS[$i]},"; else echo "    ${STEPS[$i]}"; fi
    done
    echo "  ],"
    echo "  \"ok\": $ok"
    echo "}"
  } > ".verify/$SHA.json"

  read_state
  if [ "$ok" = false ] && [ "$INFRA" = 1 ]; then
    : # infraestrutura: não soma rodada de correção
  elif [ "$ok" = false ]; then
    S_BRANCHES["$BRANCH"]=$(( ${S_BRANCHES[$BRANCH]:-0} + 1 ))
    S_GLOBAL=$((S_GLOBAL + 1))
  else
    S_BRANCHES["$BRANCH"]=0
    S_GLOBAL=0
  fi
  write_state
  local fails="${S_BRANCHES[$BRANCH]:-0}"

  if [ "$ok" = true ]; then
    echo "VERIFY OK em ${total}s (carimbo .verify/$SHA.json)"
  else
    if [ "$INFRA" = 1 ]; then
      echo "VERIFY INTERROMPIDO por falha de infraestrutura em ${total}s (não conta como rodada de correção; tente de novo)"
    else
      echo "VERIFY FALHOU em ${total}s (falhas consecutivas neste branch: $fails, global: $S_GLOBAL)"
    fi
  fi
}

on_signal() { INFRA=1; finish false; exit 130; }
trap on_signal INT TERM
trap 'finish false' EXIT

run_step() {
  local name="$1"; shift
  local t; t="$(date +%s.%N)"
  echo "==> $name"
  "$@" > "$RUN_DIR/$name.log" 2>&1
  local rc=$?
  local d; d="$(elapsed "$t")"
  if [ "$rc" -eq 0 ]; then
    STEPS+=("{ \"name\": \"$name\", \"ok\": true, \"durationSec\": $d }")
  else
    STEPS+=("{ \"name\": \"$name\", \"ok\": false, \"durationSec\": $d }")
    # timeout/morto por sinal (124, 137, 143) e etapas só de infraestrutura não contam como rodada de correção
    case "$rc" in 124|137|143) INFRA=1 ;; esac
    case "$name" in install|compose) INFRA=1 ;; esac
    echo "FALHOU na etapa '$name' (log completo: $RUN_DIR/$name.log)"
    tail -n 40 "$RUN_DIR/$name.log"
    finish false
    exit 1
  fi
}

free_port() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }

# Marcador do E2E: com e2e/.card-isolated, o app sobe com o cartão isolado (CARD_ISOLATED=1 e CARD_ORIGIN) e o
# Playwright recebe CARD_ORIGIN. Sem ele, o app sobe como antes (formulário de cartão no próprio app). O CI roda o
# verify.sh do main contra o e2e/ do branch: o marcador chega junto com o E2E que precisa dele.
card_isolated() { [ -f e2e/.card-isolated ]; }

# Sobe o app e o serviço de cartão isolado. O ambiente de cada um (BASE_URL, SECRET, DATABASE_URL...) vai só para o
# processo que precisa, via `env` inline: nada é exportado, então não vaza para docker compose nem para o smoke de deploy.
# Serviço de cartão (dist/card/server.js, empacotado na etapa card-build): sobe sempre, em outra origem (CARD_ORIGIN =
# 127.0.0.1 em outra porta; http só vale em loopback), com `env -i` e a lista mínima de variáveis: sem SECRET, papel
# dono nem APP_DB_PASSWORD (ele recusa subir com elas). O app só embute o iframe dele com o marcador (card_isolated).
start_app() {
  local port; port="$(free_port)" || { INFRA=1; return 1; }
  local card_port; card_port="$(free_port)" || { INFRA=1; return 1; }
  echo "$port" > "$RUN_DIR/port"
  echo "$card_port" > "$RUN_DIR/card-port"
  docker compose -f compose.dev.yaml exec -T db psql -U owner -d postgres -q -v ON_ERROR_STOP=1 \
    -c "drop database if exists \"$DB_NAME\" with (force)" \
    -c "create database \"$DB_NAME\"" || { INFRA=1; return 1; }
  DB_CREATED=1
  local owner_url="postgres://owner:owner@localhost:5433/$DB_NAME"
  local app_url="postgres://app:app@localhost:5433/$DB_NAME"
  # Papel `card` com login (CARD_DB_PASSWORD): o serviço de cartão entra com ele. Papéis valem para o cluster inteiro;
  # a senha de desenvolvimento `card` é a mesma dos testes (tests/card-role.test.ts), como `app` para o papel `app`.
  local card_url="postgres://card:card@localhost:5433/$DB_NAME"
  env OWNER_DATABASE_URL="$owner_url" DATABASE_URL="$app_url" APP_DB_PASSWORD=app CARD_DB_PASSWORD=card bun run migrate || return 1
  # Dependências externas de teste: Mailpit real; Asaas falso (o servidor falso entra com os pagamentos).
  # E2E_SEED_ROUTES=1 liga a rota só do smoke (/api/test-only); o app a recusa fora de BASE_URL em loopback.
  # META_GRAPH_BASE_URL: API de Conversões do Meta falsa (mesmo servidor falso, em /meta); também só em loopback.
  local asaas_url="http://127.0.0.1:1/fake-asaas"
  if [ -f e2e/fakes/asaas-server.ts ]; then
    local fake_port; fake_port="$(free_port)" || { INFRA=1; return 1; }
    PORT="$fake_port" bun e2e/fakes/asaas-server.ts > "$RUN_DIR/asaas-fake.log" 2>&1 &
    FAKE_PID=$!
    asaas_url="http://127.0.0.1:$fake_port"
  fi
  # Três chaves diferentes entre si (o app e o serviço recusam subir com repetidas).
  local secret; secret="$(openssl rand -hex 32)"
  local ticket_key; ticket_key="$(openssl rand -hex 32)"
  local seal_key; seal_key="$(openssl rand -hex 32)"
  local base_url="http://127.0.0.1:$port"
  local card_origin="http://127.0.0.1:$card_port"
  # Código do primeiro acesso (/admin/setup): aleatório por rodada; o e2e recebe o mesmo valor (arquivo do run).
  openssl rand -hex 24 > "$RUN_DIR/setup-token" || { INFRA=1; return 1; }
  env -i PATH="$PATH" HOME="$HOME" SERVICE=card NODE_ENV=production MODE=single BASE_URL="$base_url" \
    DATABASE_URL="$card_url" CARD_ORIGIN="$card_origin" CARD_TICKET_KEY="$ticket_key" ASAAS_SEAL_KEY="$seal_key" \
    CARD_PORT="$card_port" TRUST_PROXY=0 ASAAS_BASE_URL="$asaas_url" \
    node dist/card/server.js > "$RUN_DIR/card.log" 2>&1 &
  CARD_PID=$!
  local isolated=()
  if card_isolated; then
    isolated=(CARD_ISOLATED=1 CARD_ORIGIN="$card_origin" CARD_TICKET_KEY="$ticket_key" ASAAS_SEAL_KEY="$seal_key")
  fi
  env OWNER_DATABASE_URL="$owner_url" DATABASE_URL="$app_url" APP_DB_PASSWORD=app \
    SMTP_HOST=localhost SMTP_PORT=1025 ASAAS_BASE_URL="$asaas_url" META_GRAPH_BASE_URL="$asaas_url/meta" \
    BASE_URL="$base_url" SECRET="$secret" MODE=single E2E_SEED_ROUTES=1 SETUP_TOKEN="$(cat "$RUN_DIR/setup-token")" \
    "${isolated[@]}" PORT="$port" HOSTNAME=127.0.0.1 NODE_ENV=production bun run start > "$RUN_DIR/app.log" 2>&1 &
  APP_PID=$!
  curl -fs --retry 40 --retry-delay 1 --retry-connrefused "$base_url/api/health" > /dev/null || return 1
  curl -fs --retry 40 --retry-delay 1 --retry-connrefused "$card_origin/healthz" > /dev/null
}

# E2E_OWNER_DATABASE_URL: banco descartável desta rodada (papel dono, loopback), para o E2E conferir o que o painel
# gravou (ex.: segredo da conexão Asaas em `a1.` com o cartão isolado).
e2e() {
  local port; port="$(cat "$RUN_DIR/port")"
  local card_port; card_port="$(cat "$RUN_DIR/card-port")"
  local card_origin=""
  card_isolated && card_origin="http://127.0.0.1:$card_port"
  BASE_URL="http://127.0.0.1:$port" CARD_ORIGIN="$card_origin" SETUP_TOKEN="$(cat "$RUN_DIR/setup-token")" \
    E2E_OWNER_DATABASE_URL="postgres://owner:owner@localhost:5433/$DB_NAME" \
    PW_OUTPUT_DIR="$RUN_DIR/playwright" bunx playwright test e2e/
}

# Cartões e CVVs que o E2E usa (e2e/smoke.spec.ts usa só estes): nenhum pode aparecer no log do app nem no do serviço
# de cartão (o Asaas falso ecoa número e CVV na recusa, como o real às vezes faz). Número com ou sem espaços; CVV como
# valor de uma chave cvv/ccv, ou sozinho entre aspas/espaços (não dentro de número, hora ou id: `:123` de uma duração
# não conta).
E2E_CARDS="4444444444444444 5184019740373151 4111111111111111 5555555555554444 4012888888881881 5500000000000004"
E2E_CVVS="123 987 321 737 582 604 739"
logs_no_card() {
  local f n cvv pat found=0
  for f in "$RUN_DIR/app.log" "$RUN_DIR/card.log"; do
    [ -f "$f" ] || { echo "log ausente: $f"; return 1; }
    for n in $E2E_CARDS; do
      pat="${n:0:4} ?${n:4:4} ?${n:8:4} ?${n:12:4}"
      if grep -Eq "$pat" "$f"; then echo "número de cartão de teste ${n:0:4}…${n:12:4} em $f"; found=1; fi
    done
    for cvv in $E2E_CVVS; do
      if grep -Eiq "(c[cv]v|cvc)[\"' :=]*$cvv([^0-9]|\$)|(^|[\"' ])$cvv([\"' ]|\$)" "$f"; then echo "CVV de teste $cvv em $f"; found=1; fi
    done
    if grep -Eiq '"(ccv|cvv)"' "$f"; then echo "chave ccv/cvv em $f"; found=1; fi
  done
  [ "$found" = 0 ] && echo "logs do app e do serviço de cartão sem número nem CVV de teste"
  [ "$found" = 0 ]
}

wants_deploy() {
  [ "$DEPLOY" = 1 ] && return 0
  local base=""
  for r in origin/main main; do
    if git rev-parse -q --verify "$r" > /dev/null 2>&1; then base="$r"; break; fi
  done
  [ -n "$base" ] || return 1
  git diff --name-only "$base"...HEAD 2>/dev/null | grep -Eq '^(deploy/|compose\.yaml$|Dockerfile$|tests/smoke\.sh$|tests/smoke\.compose\.yaml$|tests/deploy/)'
}

smoke_deploy() {
  [ -f tests/smoke.sh ] || { echo "tests/smoke.sh não existe, mas o deploy exige smoke"; return 1; }
  bash tests/smoke.sh
}

run_step install bun install --frozen-lockfile
run_step compose docker compose -f compose.dev.yaml up -d --wait
run_step check bun run check
run_step build bun run build
run_step card-build bun run card:build
run_step app-start start_app
run_step e2e e2e
run_step logs-no-card logs_no_card
if wants_deploy; then run_step smoke-deploy smoke_deploy; fi

finish true
exit 0
