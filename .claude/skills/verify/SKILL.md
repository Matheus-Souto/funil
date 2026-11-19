---
name: verify
description: Roda a verificação ponta a ponta do projeto (lint, tipos, testes, build, app de produção e Playwright mobile) e grava o carimbo exigido antes de PR ou push. Use antes do commit final e antes de abrir PR.
---

# /verify

Roda `bash scripts/verify.sh` (ou `bun run verify`) na raiz do repositório.

1. Faça commit do trabalho antes: o carimbo vale para o commit HEAD e exige árvore limpa.
2. Rode `bash scripts/verify.sh` com timeout longo (no mínimo 10 minutos; o build e o Playwright demoram) e nunca interrompa: INT/TERM ou timeout deixam o carimbo incompleto (não contam como rodada de correção, mas desperdiçam a execução). Com `--deploy` roda também `tests/smoke.sh` (automático se o diff contra `main` toca `deploy/`, `compose.yaml` ou `Dockerfile`).
3. Em sucesso, existe `.verify/<sha>.json` com `ok: true` e `dirty: false`; só então abra PR ou dê push (o hook de `PreToolUse` bloqueia sem ele).
4. Em falha, o log da etapa está em `.verify/runs/<sha>/<etapa>.log` (screenshots e traces do Playwright em `.verify/runs/<sha>/playwright/`). Ache a causa e corrija; não pule, não re-tente, não ponha espera em teste.
5. Após 3 rodadas falhas no mesmo branch o verify sai com código 3 (`PARE: ...`). Pare e chame o dono do projeto. Só o dono zera com `bun run verify:reset`. Falhas de infraestrutura (sinal, timeout, Docker indisponível, porta ocupada, instalação) não contam como rodada: só falha de check, build, e2e ou deploy conta.

Pré-requisitos: Bun, Docker com Compose, `bunx playwright install chromium`.
