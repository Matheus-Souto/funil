# Regras do projeto

## Verificação
- Rode `/verify` (`bash scripts/verify.sh`) antes do commit final e antes de abrir PR. O hook bloqueia `git push` e `gh pr create` sem carimbo válido.
- Nunca pule, re-tente ou ponha espera em teste instável: ache a causa ou apague o teste e documente em `docs/testes-removidos.md`.
- O hook (`.claude/settings.json`) executa `scripts/verify-hook.sh`, o gate e o `gate-mode` a partir de `origin/main` (senão `main`), não do branch. O próprio `settings.json` porém é lido do branch: CODEOWNERS + proteção de branch do `main` (code owner obrigatório) é dependência dura desse lado.
- Limites conhecidos do hook: ele só cobre a ferramenta Bash e as sintaxes listadas. MCP do GitHub, execução indireta (script que chama `git push`) e push de outro ref escapam. A barreira real é a proteção do `main` (CI obrigatório + CODEOWNERS), a configurar quando o repositório for publicado.
- Após 3 rodadas de correção falhando, pare e pergunte ao dono do projeto.
- Não edite `.claude/`, `REVIEW.md`, `scripts/verify*`, `e2e/` ou `.github/` em PR que também muda código de produto. Mudanças de verificação vão em PR separado.

## Produto
- Página nova ou mudança de tela do painel segue `docs/padrao-de-paginas.md` (componentes do Arc, cores do tema, ícones, textos).
- Dinheiro sempre em centavos inteiros; nunca ponto flutuante.
- Toda rota e página nova chama só `runAction`; regra de negócio fica nas ações.
- Toda tabela nova tem `store_id` e chama `enable_store_rls` (isolamento por loja via RLS).
- Dados de cartão nunca são persistidos nem logados.
- O app roda em Node em produção (`next start`): não use APIs exclusivas do Bun em `src/`.

## Agentes
- Divisão de trabalho entre agentes e modelos: @docs/agentes.md
