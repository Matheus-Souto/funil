#!/usr/bin/env bash
# Testa o contador de falhas de scripts/verify.sh (por branch + global) com ferramentas falsas no PATH.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERIFY="$HERE/scripts/verify.sh"
FAILS=0

D="$(mktemp -d)"
trap 'rm -rf "$D"' EXIT
mkdir -p "$D/bin" "$D/home" "$D/repo"

# Ferramentas falsas: tudo sucede, exceto `bun run check` quando FAKE_FAIL=1.
for t in bunx curl; do printf '#!/bin/sh\nexit 0\n' > "$D/bin/$t"; done
# docker falso: registra o ambiente de cada chamada; FAKE_DOCKER_FAIL=1 simula Docker indisponível.
cat > "$D/bin/docker" <<'EOS'
#!/bin/sh
env >> "${ENV_LOG:-/dev/null}"
[ "${FAKE_DOCKER_FAIL:-0}" = 1 ] && { echo "docker indisponível"; exit 1; }
exit 0
EOS
printf '#!/bin/sh\necho 4567\n' > "$D/bin/node"
cat > "$D/bin/bun" <<'EOS'
#!/bin/sh
if [ "$1 $2" = "run check" ] && [ "${FAKE_FAIL:-0}" = 1 ]; then echo "falha simulada"; exit 1; fi
if [ "$1 $2" = "run check" ] && [ "${FAKE_FAIL:-0}" = timeout ]; then echo "timeout simulado"; exit 124; fi
if [ "$1 $2" = "run check" ] && [ "${FAKE_FAIL:-0}" = signal ]; then kill -TERM "$PPID"; exit 0; fi
exit 0
EOS
chmod +x "$D/bin/"*

(
  cd "$D/repo" || exit 1
  git init -q -b a
  git config user.email t@t.t
  git config user.name t
  printf '.verify/*\n!.verify/gate-mode\n' > .gitignore
  echo x > x.txt
  mkdir tests
  printf '#!/bin/sh\nenv >> "$ENV_LOG"\n' > tests/smoke.sh
  git add -A
  git commit -q -m init
)

# Roda o verify no repositório falso; devolve o código de saída.
vrun() { (cd "$D/repo" && HOME="$D/home" PATH="$D/bin:$PATH" FAKE_FAIL="$1" bash "$VERIFY" >/dev/null 2>&1; echo $?); }
vrun_env() { (cd "$D/repo" && HOME="$D/home" PATH="$D/bin:$PATH" FAKE_FAIL=0 "$@" >/dev/null 2>&1; echo $?); }
branch() { git -C "$D/repo" checkout -q "$1" 2>/dev/null || git -C "$D/repo" checkout -q -b "$1"; }
state() { sed -n "s/^ *\"$1\": \([0-9]*\),\{0,1\}\$/\1/p" "$D/repo/.verify/state.json" | head -n1; }
expect() { if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FALHOU - $1 (esperado $2, obtido $3)"; FAILS=$((FAILS + 1)); fi; }

expect "sucesso grava ok" 0 "$(vrun 0)"
expect "sucesso: contador do branch a = 0" 0 "$(state a)"

expect "falha 1 sai com 1" 1 "$(vrun 1)"
expect "falha incrementa o branch" 1 "$(state a)"
expect "falha incrementa o global" 1 "$(state global)"

branch b
expect "falha no branch b" 1 "$(vrun 1)"
expect "trocar de branch não zera o contador de a" 1 "$(state a)"
expect "contador de b" 1 "$(state b)"
expect "global soma entre branches" 2 "$(state global)"

branch a
expect "segunda falha em a" 1 "$(vrun 1)"
expect "a = 2" 2 "$(state a)"
expect "global = 3" 3 "$(state global)"

branch novo
expect "branch novo não escapa da trava global" 3 "$(vrun 0)"
branch a
expect "trava no próprio branch" 3 "$(vrun 0)"

rm -f "$D/repo/.verify/state.json"
printf '{\n  "global": 1,\n  "branches": {\n    "a": 3\n  }\n}\n' > "$D/repo/.verify/state.json"
branch b
expect "branch b livre se só a está travado e global < 3" 0 "$(vrun 0)"
expect "sucesso zera o branch" 0 "$(state b)"
expect "sucesso zera o global" 0 "$(state global)"
expect "a permanece registrado" 3 "$(state a)"

# --- V1: o ambiente do app não vaza para docker compose nem para o smoke de deploy ---
rm -f "$D/repo/.verify/state.json"
ENV_LOG="$D/env.log"; : > "$ENV_LOG"; export ENV_LOG
branch v1
expect "verify --deploy com fakes sucede" 0 "$(vrun_env bash "$VERIFY" --deploy)"
expect "docker/smoke foram chamados" 1 "$([ -s "$ENV_LOG" ] && echo 1 || echo 0)"
leaks="$(grep -cE '^(SECRET|BASE_URL|MODE|DATABASE_URL|OWNER_DATABASE_URL|APP_DB_PASSWORD|ASAAS_BASE_URL)=' "$ENV_LOG")"
expect "nenhuma variável do app vaza para docker/smoke" 0 "$leaks"

# --- V2: falha de infraestrutura não conta como rodada de correção ---
rm -f "$D/repo/.verify/state.json"
branch infra
expect "docker indisponível sai com 1" 1 "$(vrun_env env FAKE_DOCKER_FAIL=1 bash "$VERIFY")"
expect "docker indisponível não conta no branch" "" "$(state infra)"
expect "docker indisponível não conta no global" 0 "$(state global)"
expect "timeout sai com 1" 1 "$(vrun_env env FAKE_FAIL=timeout bash "$VERIFY")"
expect "timeout não conta no global" 0 "$(state global)"
# sinal: o bun falso manda TERM para o verify (o pai dele) no meio do check
expect "sinal sai com 130" 130 "$(vrun_env env FAKE_FAIL=signal bash "$VERIFY")"
expect "sinal não conta no global" 0 "$(state global)"
expect "falha real de check ainda conta" 1 "$(vrun_env env FAKE_FAIL=1 bash "$VERIFY")"
expect "falha real incrementa o global" 1 "$(state global)"

if [ "$FAILS" -ne 0 ]; then echo "$FAILS falha(s)"; exit 1; fi
echo "state.test.sh: tudo verde"
