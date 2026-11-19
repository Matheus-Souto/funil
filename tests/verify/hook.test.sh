#!/usr/bin/env bash
# Alimenta o comando real do hook (.claude/settings.json) com payloads JSON de exemplo.
# Repositório temporário sem carimbo: comando que deve ser barrado sai com 2; os demais com 0.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK_CMD="$(jq -r '.hooks.PreToolUse[0].hooks[0].command' "$HERE/.claude/settings.json")"
FAILS=0

D="$(mktemp -d)"
trap 'rm -rf "$D"' EXIT
(
  cd "$D" || exit 1
  git init -q -b work
  git config user.email t@t.t
  git config user.name t
  mkdir -p scripts .verify
  cp "$HERE/scripts/verify-gate.sh" "$HERE/scripts/verify-hook.sh" scripts/
  printf '.verify/*\n!.verify/gate-mode\n' > .gitignore
  echo enforce > .verify/gate-mode
  git add -A
  git commit -q -m init
)

hook() { # comando -> código de saída do hook
  jq -n --arg c "$1" '{tool_name: "Bash", tool_input: {command: $c}}' | (cd "$D" && bash -c "$HOOK_CMD" >/dev/null 2>&1)
  echo $?
}

check() { # esperado comando
  local got; got="$(hook "$2")"
  if [ "$got" = "$1" ]; then echo "ok   - [$1] $2"; else echo "FALHOU - [esperado $1, obtido $got] $2"; FAILS=$((FAILS + 1)); fi
}

# Devem ser barrados (2)
check 2 'git push'
check 2 'git push origin fase-1'
check 2 'git  push   origin x'
check 2 'git -C /tmp/repo push'
check 2 'git -c user.name=x push --force'
check 2 'git --no-pager push'
check 2 'gh pr create --fill'
check 2 'gh  pr  create'
check 2 'gh pr --repo dono/repo create'
check 2 'gh -R dono/repo pr create'
check 2 'bun run check && git push origin x'
check 2 'echo oi; git push'
check 2 'true | git push'
check 2 'FOO=1 git push'
check 2 'bash -c "git push origin x"'
check 2 'cd sub && gh pr create --title "x"'

# Não devem ser barrados (0)
check 0 'git commit -m "fix git push hook"'
check 0 'echo "gh pr create"'
check 0 'git status'
check 0 'git log --oneline'
check 0 'git pull'
check 0 'gh pr view 3'
check 0 'gh pr list'
check 0 'grep -r "git push" docs'
check 0 'ls'

# Payload que não é JSON válido: falha fechada (barra)
got="$(printf 'isto não é json' | (cd "$D" && bash -c "$HOOK_CMD" >/dev/null 2>&1); echo $?)"
if [ "$got" = 2 ]; then echo "ok   - payload inválido barra"; else echo "FALHOU - payload inválido (obtido $got)"; FAILS=$((FAILS + 1)); fi

if [ "$FAILS" -ne 0 ]; then echo "$FAILS falha(s)"; exit 1; fi
echo "hook.test.sh: tudo verde"
