#!/usr/bin/env bash
# Testa scripts/verify-gate.sh e a trava de 3 rodadas de scripts/verify.sh em repositórios temporários.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$HERE/scripts/verify-gate.sh"
VERIFY="$HERE/scripts/verify.sh"
FAILS=0
TMPS=()

cleanup() { for d in "${TMPS[@]}"; do rm -rf "$d" "$d.gate-err"; done; }
trap cleanup EXIT

new_repo() {
  local d
  d="$(mktemp -d)"
  TMPS+=("$d")
  (
    cd "$d" || exit 1
    git init -q -b work
    git config user.email t@t.t
    git config user.name t
    mkdir -p .verify
    printf '.verify/*\n!.verify/gate-mode\n' > .gitignore
    echo enforce > .verify/gate-mode
    echo a > a.txt
    git add -A
    git commit -q -m init
  )
  echo "$d"
}

stamp() { # dir sha ok dirty
  printf '{\n  "sha": "%s",\n  "branch": "work",\n  "dirty": %s,\n  "steps": [\n    { "name": "x", "ok": true }\n  ],\n  "ok": %s\n}\n' \
    "$2" "$4" "$3" > "$1/.verify/$2.json"
}

expect_code() { # nome esperado real
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FALHOU - $1 (esperado $2, obtido $3)"; FAILS=$((FAILS + 1)); fi
}

run_gate() { (cd "$1" && bash "$GATE" >/dev/null 2>"$1.gate-err"; echo $?); }

# 1. sem carimbo -> 2, com a mensagem de bloqueio
d="$(new_repo)"
expect_code "sem carimbo bloqueia" 2 "$(run_gate "$d")"
if grep -q "Bloqueado: rode /verify no commit" "$d.gate-err"; then echo "ok   - mensagem de bloqueio"; else echo "FALHOU - mensagem de bloqueio"; FAILS=$((FAILS + 1)); fi

# 2. carimbo ok do HEAD e árvore limpa -> 0
d="$(new_repo)"; sha="$(git -C "$d" rev-parse HEAD)"; stamp "$d" "$sha" true false
expect_code "carimbo ok e árvore limpa passa" 0 "$(run_gate "$d")"

# 3. carimbo de outro sha -> 2
d="$(new_repo)"; sha="$(git -C "$d" rev-parse HEAD)"; stamp "$d" "0000000000000000000000000000000000000000" true false
expect_code "carimbo de outro sha bloqueia" 2 "$(run_gate "$d")"

# 4. árvore suja -> 2
d="$(new_repo)"; sha="$(git -C "$d" rev-parse HEAD)"; stamp "$d" "$sha" true false; echo b > "$d/b.txt"
expect_code "árvore suja bloqueia" 2 "$(run_gate "$d")"

# 5. carimbo com ok false ou dirty true -> 2
d="$(new_repo)"; sha="$(git -C "$d" rev-parse HEAD)"; stamp "$d" "$sha" false false
expect_code "carimbo ok:false bloqueia" 2 "$(run_gate "$d")"
d="$(new_repo)"; sha="$(git -C "$d" rev-parse HEAD)"; stamp "$d" "$sha" true true
expect_code "carimbo dirty:true bloqueia" 2 "$(run_gate "$d")"

# 6. observe sem carimbo -> 0 e registra em gate.log
d="$(new_repo)"; echo observe > "$d/.verify/gate-mode"
expect_code "observe passa" 0 "$(run_gate "$d")"
if [ -s "$d/.verify/gate.log" ]; then echo "ok   - observe registra em gate.log"; else echo "FALHOU - gate.log vazio"; FAILS=$((FAILS + 1)); fi

# 7. off -> 0
d="$(new_repo)"; echo off > "$d/.verify/gate-mode"
expect_code "off passa" 0 "$(run_gate "$d")"

# 8. state.json com failures: 3 -> verify.sh sai com 3 sem rodar etapas
d="$(new_repo)"
printf '{\n  "global": 0,\n  "branches": {\n    "work": 3\n  }\n}\n' > "$d/.verify/state.json"
out="$(cd "$d" && bash "$VERIFY" 2>&1)"; code=$?
expect_code "3 falhas trava o verify" 3 "$code"
if echo "$out" | grep -q "PARE: 3 rodadas de correção falharam. Chame o dono do projeto."; then echo "ok   - mensagem de PARE"; else echo "FALHOU - mensagem de PARE"; FAILS=$((FAILS + 1)); fi
if [ ! -d "$d/.verify/runs" ]; then echo "ok   - nenhuma etapa rodou"; else echo "FALHOU - etapas rodaram"; FAILS=$((FAILS + 1)); fi

# 9. gate-mode vem do main, não do branch em revisão
d="$(new_repo)"
git -C "$d" branch -m main
git -C "$d" checkout -q -b work
echo off > "$d/.verify/gate-mode"
git -C "$d" add -A; git -C "$d" commit -q -m "branch tenta desligar o gate"
expect_code "gate-mode 'off' no branch é ignorado (main manda)" 2 "$(run_gate "$d")"
git -C "$d" checkout -q main
echo observe > "$d/.verify/gate-mode"; git -C "$d" commit -q -am "main muda o modo"
git -C "$d" checkout -q work
expect_code "modo observe no main vale no branch" 0 "$(run_gate "$d")"

if [ "$FAILS" -ne 0 ]; then echo "$FAILS falha(s)"; exit 1; fi
echo "gate.test.sh: tudo verde"
