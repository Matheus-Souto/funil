# Revisão

## Regras gerais
- Revise o diff, não a intenção. Cada afirmação ("testado", "idempotente") precisa de evidência no diff ou em `.verify/`.
- Teste novo não pode conter skip, only, todo, retries, esperas fixas (o `check` já barra; confira se não foi contornado).
- Mudança em verificação (`.claude/`, `scripts/verify*`, `e2e/`, `.github/`) não vem junto com código de produto.

- `.claude/settings.json` é lido do branch em revisão: só o CODEOWNERS com revisão obrigatória e a proteção do `main` impedem que um PR desligue o hook. Qualquer diff em `.claude/`, `scripts/`, `.verify/gate-mode`, `package.json` (script `check`), `tests/verify/` ou `eslint.config.js` exige o dono.
- O hook de `PreToolUse` só cobre Bash; MCP do GitHub, execução indireta e push de outro ref escapam dele. A barreira real é a proteção do `main` (CI obrigatório + CODEOWNERS), a configurar quando o repositório for publicado: até lá, trate o carimbo como conferência, não como garantia.
- O contador de 3 falhas do verify é por branch e global; não apague `.verify/state.json` (só o dono usa `bun run verify:reset`).

## Checklist de confiabilidade
Cada item tem gatilho legível no diff, a verificação e a origem.

| # | Gatilho no diff | Verificação | Origem |
|---|-----------------|-------------|--------|
| 1 | Toca `payments/` | Cobrança e webhook são idempotentes (repetir a mesma chamada não duplica cobrança nem efeito) | Spec: pagamentos |
| 2 | Cria tabela | Tem `store_id` e chama `enable_store_rls` | Spec: multi-loja e RLS |
| 3 | Toca `card.ts` ou rota de cartão | Nenhum dado de cartão persistido nem logado | Spec: cartão transparente |
| 4 | Rota ou página nova | Chama só `runAction` | Spec: arquitetura de ações |
| 5 | Toca `orders/state.ts` | Efeitos colaterais só quando `changed: true` | Spec: máquina de estados |
| 6 | Toca `delivery/` | Link de entrega revogado em reembolso | Spec: entrega |
| 7 | Toca `tracking/meta.ts` | `event_id` igual no navegador e no servidor | Spec: Meta CAPI |
| 8 | Mexe em valores | Centavos inteiros, sem float | Spec: dinheiro |

## Como acrescentar regras
- Falha que passou na revisão vira item novo: gatilho no diff, verificação e origem (link do PR ou do incidente).
- Pode itens que não disparam há muito tempo; regra que nunca dispara é ruído.
