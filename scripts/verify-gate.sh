#!/usr/bin/env bash
# Gate de PR/push: só passa se existe carimbo .verify/<HEAD>.json com ok:true e dirty:false
# e a árvore está limpa. Modo em .verify/gate-mode: off | observe | enforce.
# Não lê stdin e só usa git/grep/bash (roda dentro de hook, via `git show main:... | bash`).
set -u

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$ROOT" || exit 0

# O modo vem do branch padrão (origin/main, senão main), nunca do branch em revisão.
# Só cai para o arquivo local se nenhum dos dois refs tem o arquivo (bootstrap).
MODE="enforce"
MODE_REF=""
for r in origin/main main; do
  if git cat-file -e "$r:.verify/gate-mode" 2>/dev/null; then MODE_REF="$r"; break; fi
done
if [ -n "$MODE_REF" ]; then
  MODE="$(git show "$MODE_REF:.verify/gate-mode" | tr -d '[:space:]')"
elif [ -f .verify/gate-mode ]; then
  MODE="$(tr -d '[:space:]' < .verify/gate-mode)"
fi
[ "$MODE" = "off" ] && exit 0

SHA="$(git rev-parse HEAD 2>/dev/null)" || exit 0
STAMP=".verify/$SHA.json"

reason=""
if [ ! -f "$STAMP" ]; then
  reason="sem carimbo $STAMP"
elif ! grep -Eq '^  "ok": true' "$STAMP"; then
  reason="carimbo com ok diferente de true"
elif ! grep -Eq '^  "dirty": false' "$STAMP"; then
  reason="carimbo gravado com árvore suja"
elif [ -n "$(git status --porcelain)" ]; then
  reason="árvore de trabalho com alterações"
fi

[ -z "$reason" ] && exit 0

if [ "$MODE" = "observe" ]; then
  mkdir -p .verify
  echo "$(date -u +%FT%TZ) $SHA $reason" >> .verify/gate.log
  exit 0
fi

echo "Bloqueado: rode /verify no commit ${SHA:0:8} antes de abrir PR ou dar push. ($reason)" >&2
exit 2
