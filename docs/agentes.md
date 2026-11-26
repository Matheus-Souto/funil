# Agentes no funil

Regras de produto e de teste continuam em `CLAUDE.md` e `REVIEW.md` e valem para todo agente, de qualquer fornecedor. Este documento define **como o trabalho anda**: um maestro divide, a frota executa, outra família revisa, o agente mergeia. O Matheus pede, direciona e fecha threads; ele não aprova cada passo.

## Maestro
Claude Opus 5.5, effort `high`, na thread aberta pelo Matheus. Planeja, divide em fatias, delega, confere e mergeia. Só escreve código quando a fatia é pequena demais para delegar. Não há etapa de aprovação de spec ou plano: o plano vai no relatório e a execução começa em seguida.

## Roteamento (`delegate_task`, assíncrono, alvo explícito)
| Trabalho | Modelo |
|---|---|
| Fatias paralelas da mesma feature | Opus 5.5 `high` (cópias) |
| Spec clara, migração, script, código repetitivo | GPT-6.2 Sol (Codex) |
| Problema longo e difícil (~20 min: cartão, RLS, máquina de estados) | Fable 5.2 `high`; devolve a execução ao maestro |
| Revisão do trabalho do Claude | GPT-6.2 Astra (`xhigh`) |
| Revisão do trabalho do Sol | Opus 5.5 (Claude); Astra só como revisão adicional, porque Sol e Astra são da mesma família |
| Consulta rápida, tarefa pequena | Haiku 5.5 ou GPT-6 Luna |

Toda fatia é revisada por um modelo de **outra família** antes do merge (Claude revisa Codex e vice-versa). Toque em pagamento, cartão ou dado pessoal: revisão de segurança com Astra `ultra`.

## Effort
`high` para todos (Fable fica em `high`, nunca `max`). `xhigh`/`max` só no bug difícil ou na checagem final. Astra pode usar `ultra` em revisão.

## Frota
- **VPS** (`vps.moradah.app`): todo o trabalho. Repo de dev em `~/projetos/funil`.
- **Windows:** só tarefas específicas de SO.
- Celular: o Matheus só acompanha e direciona.

## Isolamento (é ele que segura o risco do acesso total)
- Toda thread nova em **worktree própria** a partir de `origin/main`, com porta própria e banco próprio (`funil_<branch>` no Postgres :5433; o `/verify` já cria banco e portas descartáveis por rodada). Nunca o banco `funil` compartilhado.
- Uma tarefa delegada é dona dos seus arquivos; o maestro define isso antes de delegar.
- Nada chega na `main` sem PR vinculado à thread (`link_pull_request`).
- Commits com `git -c user.name="Matheus Souto" -c user.email=79191133+Matheus-Souto@users.noreply.github.com`. Sem `git stash`. Matar só o PID que você iniciou.

## Verificação e merge
- O agente abre o preview sozinho: navega, clica, snapshot, avalia.
- `/verify` passa na worktree da thread; saída colada, não resumida. Leva ~11–14 min: segundo plano, sem interromper. No máximo 2 ao mesmo tempo, com carga de 1 e 5 min da VPS < 4. O banco da rodada é `verify_<sha curto>` e é recriado a cada início: **nunca duas rodadas no mesmo commit ao mesmo tempo**, em worktrees diferentes ou não.
- Abra o PR, `watch_pull_request` até os checks ficarem verdes e a revisão da outra família sem pendência, e **mergeie**. Depois reporte.
- Merge na `main` **não é deploy**: produção (`~/funil`) só sobe com ok do Matheus.

## Caixa de entrada
Threads são caixa de entrada: feche o que terminou, adie o que espera, corrija o que desvia. Trabalho recorrente vira `schedule_task`, não memória.

## Falhas
- Ferramenta falhando (timeout do preview): tente de novo uma vez, depois testes + screenshot.
- Tarefa delegada passando de 25 min de trabalho (sem contar `/verify` rodando): interrompa, reescreva o briefing menor, relance.
- Duas threads no mesmo arquivo: a segunda espera o primeiro merge e rebaseia.
- Limite de uso: mova a fatia para o outro fornecedor (Claude ↔ Codex).
- `/verify` responde `PARE` quando há 3 rodadas de correção falhas na branch **ou no total** (`.verify/state.json`): pare e chame o Matheus (só ele roda `bun run verify:reset`). Não recomece a tarefa em outra worktree para escapar da trava.

## Entrega
Um PR por fatia com a saída do `/verify`, e um relatório curto: **feito / esperando / falhou**.

## Autonomia
Não pare para chamadas de rotina, commit, push, PR nem merge. **Pare e peça ok** para: deploy ou qualquer coisa em `~/funil` (produção); migração aplicada em banco real; gasto; exclusão de dados ou branches alheias; segredos (Infisical); mudança em verificação: qualquer arquivo da lista do `REVIEW.md` (`.claude/`, `scripts/`, `.verify/gate-mode`, script `check` do `package.json`, `tests/verify/`, `eslint.config.js`) e também `e2e/`, `.github/`, `REVIEW.md` e o `CODEOWNERS`. Essas mudanças vão sempre em PR separado de código de produto, mesmo com o ok do Matheus. O GitHub não barra isso (a proteção não exige revisão do code owner): a barreira é esta regra; ambiguidade que muda o objetivo. Nenhum dado pessoal de comprador vai para briefing, log ou relatório.
