# Padrão das páginas do painel

Guia para criar ou mudar uma página do painel (`/admin`) já no padrão do redesenho: os mesmos componentes, cores,
ícones e textos das telas que existem hoje. Na dúvida, copie a página mais parecida (indicadas em cada seção).

## 1. Estrutura de uma página

- **Onde:** `src/app/admin/(panel)/<rota>/page.tsx`. O layout do grupo `(panel)` já põe a sidebar, a barra do celular
  e o tema.
- **No servidor (`page.tsx`):**
  - Comece com `requirePanelActor()` e confira a permissão com `hasPermission`; sem permissão, `notFound()` (o mesmo
    das outras telas protegidas).
  - Busque os dados só com `runAction(...)`: a regra de negócio fica nas ações (`src/lib/...`), nunca na página.
  - Título com `<PageHead title="…" />` (de `../../blocks`). Ações da página (ex.: "Novo token") vão em `actions`.
  - `export const dynamic = "force-dynamic"` e `export const metadata = { title: "…" }`.
- **No navegador:** o que tem estado ou clique fica num arquivo à parte com `"use client"` (ex.: `orders-table.tsx`,
  `approvals-panel.tsx`). Não importe constantes de um arquivo `"use client"` na página do servidor: no servidor elas
  viram referência, não valor. Constantes compartilhadas vão num `.ts` comum (ex.: `settings/tabs.ts`).
- **Mudanças:** chame a action do painel (`../actions`) com `useActionRunner()` e mostre o resultado com `<Live msg />`
  (de `../../ui`), que já anuncia para o leitor de tela.
- **Na sidebar:** acrescente o item em `src/app/admin/(panel)/layout.tsx` (com a mesma permissão da página) e, se for
  um ícone novo, em `ICONS` de `nav.tsx`.
- **Carregando:** `loading.tsx` do grupo já mostra o esqueleto (`Skeleton` do Arc). Página com formato bem diferente
  pode ter o seu.

## 2. Cores e tema

- Use só os tokens `--color-*` de `src/app/admin/panel.module.css` (eles apontam para `theme.css`, que tem o tema
  claro e o escuro). Nada de cor fixa em hex no painel; a única exceção é a prévia do checkout, que é sempre clara.
- Principais:
  - fundo `--color-bg`, cartão `--color-surface`, cartão secundário `--color-surface-2`;
  - borda `--color-border` (e `--color-border-strong` em campos);
  - texto `--color-text`, texto de apoio `--color-text-muted`;
  - destaque (verde-limão `#9BE86A`): `--color-primary` no fundo de botão, `--color-primary-ink` em texto e links (o
    limão puro não tem contraste como texto), `--color-primary-soft` em fundos leves;
  - estados: `--color-success|warning|danger|info` e as versões `-soft` para fundo.
- Status sempre com `<Badge tone="success|warning|danger|info|neutral">` (ou `<StatusBadge>` para pedidos), que já
  traz o ícone certo. Não invente pílulas coloridas.
- Confira toda tela nova nos dois temas (o botão de tema fica no rodapé da sidebar).

## 3. Componentes (Arc UI)

Os componentes ficam em `src/components/arc/` (Arc UI, parte grátis, MIT). Use estes antes de criar um novo:

| Precisa de | Use | Exemplo no código |
| --- | --- | --- |
| Tabela | `SortableDataTable` dentro de `<div className={s.arcTable}>`, com `TableShell` (busca e contagem) e `TablePager` (páginas) | `orders/orders-table.tsx`, `orders/page.tsx` |
| Filtro de tabela | `<ColumnFilter compact … />` na prop `filter` da coluna (o filtro fica no título da coluna; não há botão "Filtrar") | `orders/page.tsx` |
| Abas | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`; se a aba precisa de link direto, guarde em `?aba=` | `settings/form.tsx`, `aprovacoes/approvals-panel.tsx` |
| Ajustes (liga/desliga, campos) | cartão `s.setCard` com linhas `s.setRow` (texto à esquerda, campo à direita) e `s.setRowSwitch` + `Switch` | `settings/form.tsx` |
| Confirmação | `Dialog` de `../../ui` (com `tone="danger"` para ações destrutivas) | `tokens/tokens-panel.tsx` |
| Formulário em modal | `Dialog` + `DialogContent` do Arc | `connections/cards.tsx` |
| Copiar | `CopyButton` do Arc com `iconOnly variant="plain"` (só o ícone) | `offers/page.tsx`, `settings/page.tsx` |
| Pessoa ou agente | `Avatar` do Arc | `settings/team.tsx`, `aprovacoes/approvals-panel.tsx` |
| Escolher cor | `ColorPicker` do Arc (`alpha={false}` para cor sólida) | `settings/form.tsx` |
| Período | `RangePicker` (calendário do Arc com atalhos em português) | `(panel)/range-picker.tsx` |
| Gráficos e números | `RevenueChart`, `DonutChart`, `FunnelChart`, `RankChart`, `Sparkline`, `KpiNumber` de `../charts` e `Kpi` de `../blocks` | `(panel)/page.tsx` (Dashboard) |
| Passo a passo que abre e fecha | `Accordion` do Arc | `settings/page.tsx` |
| Seleção, menu | `Select`, `DropdownMenu` do Arc | `offers/[id]/editor.tsx`, `table-pager.tsx` |
| Aviso na página | `<Notice tone="info|warning|danger">` de `../blocks` | `contatos/page.tsx` |

**Componente novo do Arc:**
1. Confira em `https://uiarc.dev/r/registry.json` que o item é `"tier": "free"`. Nada do Arc Pro.
2. Baixe de `https://uiarc.dev/r/<item>.json` para `src/components/arc/<item>/`.
3. Traduza os textos (inclusive `aria-label`) para português e remova o que não for usar.
4. Acrescente o item em `src/components/arc/LICENSE` e, se trouxer dependência nova, em `THIRD_PARTY_NOTICES.md`.

## 4. Ícones

- **Interface:** `lucide-react`, `strokeWidth={1.75}`, 16 px em botões e 18 px na navegação, com `aria-hidden="true"`.
  Botão só com ícone precisa de `aria-label`.
- **Ilustrações 3D:** `<Art name="…" size={…} />` (de `../blocks`), usadas em estados vazios, login e números em
  destaque. Ficam em `public/admin/art/<nome>.webp` e o nome entra no tipo `ArtName`.
  - Ilustração nova: mesmo estilo das que existem (objeto 3D, verde-limão com branco, luz suave), fundo transparente,
    `.webp` quadrado de 256 px.
- **Marca:** `<BrandLogo />` (de `../brand`) já troca o logo do tema claro e do escuro e mostra só o ícone com a
  sidebar recolhida.

## 5. Estados da tela

- **Vazio:** `<div className={s.empty}>` com `Art`, um `h2` curto e uma frase do que fazer (e o botão, se houver).
  Com filtro aplicado, diga isso e ofereça "Limpar filtros".
- **Erro de ação:** `<Live msg>` com `tone: "error"` perto do botão. Falha que muda os dados (ex.: outra pessoa já
  decidiu) recarrega a lista (`router.refresh()`).
- **Sem permissão:** `notFound()` na página; botões que a pessoa não pode usar ficam desabilitados, com uma linha
  explicando quem pode.

## 6. Textos

- Português do Brasil, frases curtas e diretas, sem jargão técnico na tela (o código da ação pode aparecer em
  `code` pequeno, como em Aprovações).
- Botões com verbo ("Salvar alterações", "Aprovar e executar", "Encerrar sessões").
- Não repita o título em subtítulos nem explique o que já está visível.
- Dinheiro sempre em centavos inteiros e exibido com `brl()` (`src/lib/format`). Datas no horário de São Paulo
  (`dateTimeSP`, `shortWhenSP`).

## 7. Layout

- Confira em 1280 px e em 390 px (celular). Sem rolagem horizontal da página; a tabela do Arc vira lista no celular.
- Espaços do próprio CSS do painel (cartões com `padding` 18–20 px, `gap` 12–16 px, cantos de 16 px). Prefira as
  classes que existem (`s.card`, `s.setCard`, `s.stack`, `s.grid2`) a estilos soltos no `style={}`.
- Barra de salvar: quando o formulário tem alteração, `s.saveBar s.saveBarSimple` com "Descartar" e "Salvar
  alterações" (ver `settings/form.tsx`).

## 8. Antes do PR

1. Tela nos dois temas e no celular.
2. Teclado: Tab chega em tudo, Esc fecha diálogos, foco volta ao botão que abriu.
3. `bun run lint` e `bun run typecheck`.
4. E2E da tela atualizado (em PR separado, como manda o `CLAUDE.md`) e `/verify`.
