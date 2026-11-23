# Funcionalidades de venda (cupom, upsell/downsell, sequência pós-compra): plano de implementação

> **Para agentes:** sub-skill obrigatória: superpowers:subagent-driven-development (recomendada) ou
> superpowers:executing-plans, tarefa por tarefa. Os passos usam checkbox (`- [ ]`).
> **Não comece sem o ok final do dono.** As perguntas foram respondidas em 23/11/2026 (seção 6 do spec: cupom só no
> principal, 1 por pessoa, `?cupom=` + KIDS10, ordem A → B1 → B2 → C, upsell R$ 17,10, downsell R$ 12,90, cartão
> fase 1, sequência D+1/D+3/D+5, descadastro único, Resend gratuito, jurídico junto com o PR #14). Cada parte (A, B1, B2, C) é **um PR
> separado**, em branch próprio a partir da `main` atualizada, e cada uma tem um PR de verificação (E2E) depois.

**Objetivo:** aumentar o ticket da loja com (A) cupom de desconto no checkout, (B) upsell e downsell na página de
obrigado e (C) sequência de e-mails pós-compra pelo e-mail da própria loja.

**Spec:** `docs/superpowers/specs/2026-11-23-funcionalidades-de-venda-design.md` (decisões D1–D31, ordem e riscos,
perguntas ao dono). Spec de origem: `docs/superpowers/specs/2026-11-18-plataforma-funil-mvp-design.md`. Lá, upsell e
sequências eram não-objetivos do MVP, e o dono puxou este bloco para o roadmap.

**Arquitetura em uma linha por parte:**
- **A. Cupom:** `coupon` + `coupon_offer`. `createOrder` aplica o desconto antes do Pix manual e do rateio dos itens,
  e grava `coupon_id`/`discount_cents`. `checkout.previewCoupon` mostra o desconto, e `checkout.start` só cria o pedido
  se o total bater com `expectedTotalCents`. O serviço `card` não muda: ele cobra `orders.total_cents`, que já vem com o
  desconto.
- **B1. Upsell/downsell (Pix):** oferta `post_purchase` + `post_purchase_offer`. O cookie assinado `funil_buyer`
  autoriza o navegador da compra. `checkout.acceptPostPurchase` cria o pedido-filho (`parent_order_id`,
  `funnel_step`) com os dados do pedido de origem, e a entrega, o Meta e o Telegram saem pelo caminho normal do
  `transitionOrder`.
- **B2. Upsell no cartão:** o mesmo pedido-filho, com o bilhete do cartão emitido na aceitação e o iframe do cartão
  na página de obrigado.
- **C. Sequência:** `email_sequence_step` + `sequence_email`. A varredura `sequence_scan` e o envio `sequence_send`
  seguem o desenho de `recovery_scan`/`recovery_send`, com `email_optout`, `/sair` e `List-Unsubscribe` compartilhados.

**Stack:** Next 16 (rotas em Node), Drizzle e Postgres 17 (RLS), Zod 4, nodemailer e a API do Resend, testes em Bun.

## O que encontrei no código e que muda o pedido

- `orders` já tem `subtotal_cents` e `total_cents` (hoje iguais): o desconto cabe sem mexer no resto do modelo (D2).
- O papel `card` lê `orders.total_cents` e o bilhete leva `totalCents`. Com o desconto gravado no pedido, **o serviço
  isolado não precisa de nenhuma mudança** para o cupom.
- O Pix manual soma `1..99` centavos ao **total final** (`allocateManualAmount`). O desconto entra antes da alocação,
  sem mudar o algoritmo.
- O `publicId` vai ao Meta (`event_source_url`, `order_id`): não serve sozinho como prova de que o visitante é o
  comprador. Daí o cookie do D15.
- O formulário do cartão pede CEP e número do endereço, que **não são guardados**. Sem token, o upsell no cartão
  precisa do formulário inteiro de novo (D17).
- `/o/` já está no `matcher` da CSP do comprador (com `frame-src` do cartão) e no `pci_page_monitor`.
- Item novo no menu do painel quebra o smoke `painel 390`. Nenhuma parte deste plano adiciona item ao menu.
- A página `/sair` e o `recovery.unsubscribe` falam em "lembretes". A parte C muda o texto para valer também para a
  sequência (D26).

## Restrições globais (todas as partes)

- **Dinheiro em centavos inteiros.** Reais só na borda com o Asaas (`centsToReais`) e com o Meta (`/100`). Nenhum
  `Number` com casas decimais em regra de preço; percentual em **pontos-base inteiros** (`percent_bp`, 1–9000) e
  arredondamento **para baixo** do desconto (`Math.floor(subtotal * bp / 10000)`).
- **Tabelas novas:** `store_id` + `select enable_store_rls('<tabela>');` à mão na migração, e FKs compostas
  `(store_id, id)` para oferta, produto e pedido (padrão de `offer_product`). Atualizar `tests/rls.test.ts`,
  `tests/migrate.test.ts` e `tests/card-role.test.ts` se eles listam tabelas.
- **Rotas e páginas só chamam `runAction`.** Server actions só montam a entrada (IP, cookies, host).
- **Catálogo MCP:** toda ação nova com decisão em `src/lib/mcp/tools.ts` (`MCP_EXCLUDED`, `sensitive` ou ferramenta
  comum com projeção). `tests/mcp-tools.test.ts` cobre.
- **Dados pessoais:** nada de e-mail, nome, telefone, CPF, token de descadastro ou cookie em `log`, `audit_log`
  (`auditInput` com hash), MCP ou Telegram. O código do cupom não é dado pessoal.
- **Testes:** relógio injetado e datas mudadas no banco. Nada de skip, only, retry, `setTimeout` nem espera fixa.
  Nenhum literal com formato de segredo (`whsec_…`, `re_…`, `fnl_…`, `upl_…`, token de bot): montar em tempo de
  execução. Higiene: a palavra "retry" não pode aparecer em `tests/`.
- **Escopo de cada PR:** produto. Não edita `e2e/`, `scripts/verify*`, `.github/`, `.claude/` nem `REVIEW.md`. E2E vai
  no PR de verificação seguinte.
- **Processo:** `bun run check` antes de cada commit. `bash scripts/verify.sh` (≈8–13 min, em segundo plano, sem
  interromper e sem encadear push) antes do PR. 1 implementador + 2 revisores por task, revisão final de código e
  segurança, uma onda de correção. Push e PR só com o ok do dono, com os rulings com custo no corpo do PR. Os
  implementadores não usam `git stash`. Após 3 rodadas de correção falhando, parar e perguntar.
- **Commits:** `git -c user.name="Matheus Souto" -c user.email=79191133+Matheus-Souto@users.noreply.github.com commit`,
  terminando com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Foco de revisão (todas as partes)

1. **Preço mostrado = preço cobrado:** cupom que vence entre a prévia e o envio; oferta de upsell com preço alterado
   com a página aberta; bump + cupom; Pix manual com desconto; cartão parcelado com desconto. Esperado: `conflict` e
   nenhum pedido, ou pedido com o total exato visto. Tasks A3, A4 e B1-4.
2. **Soma dos itens:** `sum(order_item.price_cents) = total_cents` em todo pedido novo (com e sem cupom, com e sem
   bump, 1 ou N produtos). Tasks A3 e B1-4.
3. **Abuso:** força bruta de cupom; "1 por pessoa" com `+sufixo`/pontos do Gmail; terceiro com o link `/o/<publicId>`
   gerando upsell; repetir "Sim, quero" 10 vezes; sequência em massa ao ligar. Tasks A3, B1-3, B1-4 e C4.
4. **Dado pessoal saindo:** MCP (`metrics.summary`, `coupons.*`, `postPurchase.*`, `sequences.*`), Telegram, log,
   auditoria e prévia de e-mail. Tasks A5, B1-6 e C6.
5. **Serviço de cartão:** nenhuma permissão nova para o papel `card` nas partes A, B1 e B2 (`tests/card-role.test.ts`).

---

## Parte A: cupom (PR A, migração 0037)

### Task A1: tabelas, colunas do pedido e regra pura do desconto

**Files:**
- Create: `src/lib/db/schema/coupons.ts` (exportado em `src/lib/db/schema/index.ts`), `drizzle/0037_coupon.sql` (via
  `bun run migration --name coupon`; acrescentar à mão `select enable_store_rls('coupon');` e
  `select enable_store_rls('coupon_offer');`), `src/lib/coupons/rules.ts`
- Modify: `src/lib/db/schema/orders.ts`
- Test: `tests/coupons.test.ts` (novo), `tests/card-role.test.ts`, `tests/rls.test.ts`, `tests/migrate.test.ts`

**Interfaces:**
- Produces:
  - `coupon`: `id uuid pk`, `store_id → store (cascade)`, `code text not null` (check `code ~ '^[A-Z0-9_-]{3,32}$'`),
    `kind text not null` (check `percent | fixed`), `percent_bp integer` (check 1–9000), `amount_cents integer` (check
    `> 0`), check `(kind = 'percent') = (percent_bp is not null) and (kind = 'fixed') = (amount_cents is not null)`,
    `applies_to text not null default 'main'` (check `main | all`), `starts_at timestamptz`, `ends_at timestamptz`
    (check `ends_at > starts_at`), `max_uses integer` (null = sem limite; check `> 0`), `max_per_email integer default 1`
    (null = sem limite), `active boolean not null default true`, `archived_at timestamptz`, `created_at`. Únicos
    `(store_id, code)` e `(store_id, id)` (alvo de FK composta).
  - `coupon_offer`: `store_id`, `coupon_id`, `offer_id`, pk `(coupon_id, offer_id)`, FKs compostas para `coupon` e
    `offer` (cascade).
  - `orders.coupon_id uuid` (FK composta `(store_id, coupon_id)` → `coupon`, sem cascade) e
    `orders.discount_cents integer not null default 0` (check `>= 0`), com check
    `orders_discount_check: total_cents = subtotal_cents - discount_cents` e
    `(coupon_id is null) = (discount_cents = 0)`.
  - `COUPON = { minTotalCents: 500, previewPerIpPerHour: 20, previewPerStorePerHour: 300, cardPendingCountsHours: 2 }`.
  - `normalizeCode(raw: string): string | null` (trim, maiúsculas, regex do check).
  - `computeDiscount(c: { kind; percentBp; amountCents; appliesTo }, parts: { mainCents: number; bumpCents: number }): { discountCents: number; mainDiscountCents: number; bumpDiscountCents: number }`:
    base = `mainCents` (+ `bumpCents` se `appliesTo = 'all'`); percentual com `Math.floor`; fixo limitado à base;
    o total final nunca fica abaixo de `minTotalCents` (corta o desconto); o desconto é dividido entre principal e bump
    na proporção da base, com a sobra no principal; nada fica negativo.

- [ ] **Step 1: testes que falham** (`tests/coupons.test.ts`):
  - `computeDiscount`: 10% de 990 só no principal → 99; 10% de 990 + 1710 com `all` → 270 (99 + 171); fixo de 2000 em
    990 → corta para 490 (total 500); percentual de 9000 bp em 600 → total 500; nunca negativo; soma
    `main + bump = discount`.
  - `normalizeCode(" kids10 ") = "KIDS10"`; `"a"`, `"KIDS 10"` e `"KIDS10<"` → `null`.
  - RLS: cupom de outra loja não aparece; `coupon_offer` com oferta de outra loja → violação da FK composta.
  - Check do pedido: `discount_cents` com `total ≠ subtotal − discount` → recusado; pedido antigo (`subtotal = total`,
    sem cupom) segue válido depois da migração.
  - `tests/card-role.test.ts`: o papel `card` não lê `coupon` nem `coupon_offer`.
- [ ] **Step 2:** `bun test tests/coupons.test.ts tests/card-role.test.ts` → FAIL.
- [ ] **Step 3: implementar.** No Sandbox do Asaas, conferir o valor mínimo de cobrança de Pix e de cartão. Se for
  diferente de R$ 5,00, ajustar `minTotalCents` e anotar no PR.
- [ ] **Step 4:** os do Step 2 + `tests/migrate.test.ts tests/rls.test.ts tests/orders.test.ts` → PASS.
- [ ] **Step 5:** `bun run check` e commit `feat(cupom): tabelas, colunas do pedido e cálculo do desconto`.

### Task A2: ações do painel (`coupons.*`) e catálogo MCP

**Files:**
- Create: `src/lib/coupons/actions.ts`
- Modify: `src/lib/actions/all.ts`, `src/lib/mcp/tools.ts`
- Test: `tests/coupons.test.ts`, `tests/mcp-tools.test.ts`, `tests/mcp-matrix.test.ts`

**Interfaces:**
- Produces:
  - `coupons.list` (`offers.read`): `{ includeArchived?: boolean }` → itens `{ id, code, kind, percentBp, amountCents, appliesTo, startsAt, endsAt, maxUses, maxPerEmail, active, archivedAt, offerIds, uses }`
    (`uses` = regra do D5).
  - `coupons.get` (`offers.read`).
  - `coupons.create` / `coupons.update` (`offers.write`, `sensitive: true`): `strictObject`. Código duplicado →
    `conflict` "Já existe um cupom com este código". Oferta de outra loja → `not_found`. Mudar `kind`/valor de um cupom
    já usado é permitido (só vale para pedidos novos).
  - `coupons.archive` (`offers.write`, `sensitive: true`): `archived_at = now()`, `active = false`. Nunca apaga (os
    pedidos referenciam).
  - MCP: as cinco viram ferramentas. As três de escrita com `APPROVAL_PREFIX`. A projeção é a lista branca dos campos
    acima.
- [ ] **Step 1: testes que falham:** criar, editar e arquivar pelo painel; código repetido (`kids10` × `KIDS10`) →
  `conflict`; papel `traffic` lê e não escreve (conforme `permissions.ts`); pelo MCP, `coupons_create` cria pedido de
  aprovação e não cria o cupom; `coupons_list` pelo MCP não tem nenhum campo além da lista branca.
- [ ] **Step 2:** `bun test tests/coupons.test.ts tests/mcp-tools.test.ts tests/mcp-matrix.test.ts` → FAIL.
- [ ] **Step 3: implementar.**
- [ ] **Step 4:** os mesmos → PASS.
- [ ] **Step 5:** `bun run check` e commit `feat(cupom): ações do painel e catálogo MCP`.

### Task A3: o cupom no pedido (`createOrder`, `checkout.previewCoupon`, `checkout.start`)

**Files:**
- Create: `src/lib/coupons/apply.ts`
- Modify: `src/lib/orders/create.ts`, `src/lib/checkout.ts`, `src/lib/actions/all.ts`, `src/lib/mcp/tools.ts`
  (decisão: `checkout.previewCoupon` é pública, fica fora como as outras `checkout.*`)
- Test: `tests/coupons.test.ts`, `tests/checkout.test.ts`, `tests/manual-pix.test.ts`, `tests/card.test.ts`

**Interfaces:**
- Consumes: A1 (`computeDiscount`, `COUPON`), `mailboxHash` (`src/lib/recovery/rules.ts`), `peekRateLimit`/`hitRateLimit`.
- Produces:
  - `resolveCoupon(tx, storeId, { code, offerId, email?, now }): Promise<{ coupon } | { invalid: true }>`: ativo, não
    arquivado, dentro da validade, vale para a oferta (lista vazia = todas), `uses < max_uses` e, com e-mail,
    `usesByMailbox < max_per_email`. Sob `pg_advisory_xact_lock(hashtextextended('coupon:' || id, 0))`. Uso (D5):
    pedido com o cupom em `paid|disputed`, ou `pending` Pix com `expires_at > now`, ou `pending` cartão com
    `created_at > now − 2 h`.
  - `CreateOrderInput.coupon?: { id: string }`. `createOrder` calcula `subtotal` (principal + bump), aplica
    `computeDiscount`, rateia `mainDiscount` nos itens do principal e `bumpDiscount` nos do bump (`splitCents` sobre o
    preço já descontado de cada grupo), grava `subtotal_cents`, `discount_cents`, `total_cents`, `coupon_id`. O Pix
    manual aloca o valor único sobre o `total` com desconto.
  - `checkout.previewCoupon` (público, `audit: false`): `{ slug, code, withBump, email?, clientIp }` →
    `{ ok: true, code, discountCents, totalCents } | { ok: false, message: "Cupom inválido ou vencido" }`. O limite
    (D8) fica no `prepare`, e o código inválido conta como tentativa.
  - `checkout.start` ganha `couponCode?: string` e `expectedTotalCents?: number` (obrigatório quando houver cupom). Com
    cupom inválido → `invalid_input` no caminho `["couponCode"]` com "Cupom inválido ou vencido". Total recalculado
    diferente de `expectedTotalCents` → `conflict` `PRICE_CHANGED` ("O valor mudou: confira o resumo") e nenhum
    pedido. `auditInput` ganha `coupon: code` (não é dado pessoal).
- [ ] **Step 1: testes que falham:**
  - `Almanaque + KIDS10 (10%, main) → subtotal 990, desconto 99, total 891, itens somam 891`.
  - `com bump e applies_to=main → total 891 + 1710 = 2601; com all → 2430; itens de cada grupo somam o grupo`.
  - `Completo (6 PDFs) com fixo de 500 → total 2200, 6 itens somam 2200`.
  - `Pix manual com cupom → manual_amount_cents entre 892 e 990 e único`.
  - `cartão com cupom → bilhete com totalCents 891; payWithCard cobra 8,91 no Asaas falso` (`tests/card.test.ts`).
  - `cupom vencido, inativo, arquivado, de outra oferta, ou max_uses atingido → invalid_input e nenhum pedido`.
  - `max_per_email 1: segundo pedido de a+x@gmail.com depois de a@gmail.com pago → invalid_input`; `pedido expirado
    não conta`; `cartão pendente há 3 h não conta`.
  - `expectedTotalCents diferente → conflict PRICE_CHANGED e nenhum pedido`.
  - `duas compras simultâneas no último uso → só uma cria o pedido` (lock).
  - `21ª prévia do mesmo IP na hora → rate_limited`.
  - `auditoria do checkout.start com cupom → tem o código, não tem e-mail em claro`.
- [ ] **Step 2:** `bun test tests/coupons.test.ts tests/checkout.test.ts tests/manual-pix.test.ts tests/card.test.ts` → FAIL.
- [ ] **Step 3: implementar.**
- [ ] **Step 4:** os mesmos + `tests/orders.test.ts tests/asaas.test.ts tests/refund.test.ts` → PASS.
- [ ] **Step 5:** `bun run check` e commit `feat(cupom): desconto aplicado no pedido com garantia do total`.

### Task A4: checkout (formulário e `?cupom=`)

**Files:**
- Modify: `src/app/c/[slug]/checkout-form.tsx`, `src/app/c/[slug]/actions.ts` (`previewCouponAction`, repassa
  `couponCode`/`expectedTotalCents`), `src/app/c/[slug]/page.tsx` (lê `?cupom=`), `src/lib/tracking/touch.ts` (`cupom`
  no toque, se o schema do toque tiver lista branca)
- Test: `tests/checkout.test.ts` e o teste do formulário existente (happy-dom, em processo próprio se depender do Radix)

**Interfaces:**
- Produces: link "Tenho um cupom" que abre o campo + "Aplicar". O resumo mostra a linha "Cupom KIDS10 −R$ 0,99" e o
  total novo. "Remover" volta ao preço cheio. Com `?cupom=`, a página já abre com o cupom aplicado (prévia no
  servidor). Marcar ou desmarcar o bump refaz a prévia. Na resposta `PRICE_CHANGED`, o formulário refaz a prévia e
  mostra a mensagem sem enviar de novo. Os textos seguem `docs/padrao-de-paginas.md` e o padrão visual do checkout.
- [ ] **Step 1: testes que falham:** prévia válida mostra o desconto; inválida mostra "Cupom inválido ou vencido";
  bump marcado refaz a prévia; `?cupom=KIDS10` abre aplicado; o envio leva `expectedTotalCents` igual ao total
  mostrado.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3: implementar.** Conferir o celular (390 px) no app local. Não muda o menu do painel.
- [ ] **Step 4:** → PASS e `bun run build` sem erro.
- [ ] **Step 5:** `bun run check` e commit `feat(cupom): campo de cupom no checkout`.

### Task A5: painel (aba Cupons, pedido, CSV), métricas e Telegram

**Files:**
- Create: `src/app/admin/(panel)/offers/coupons.tsx` (aba)
- Modify: `src/app/admin/(panel)/offers/page.tsx` (abas "Ofertas | Cupons", sem item de menu),
  `src/lib/orders/panel.ts` + `src/app/admin/(panel)/orders/[id]/page.tsx` (cupom e desconto), `orders.export` (colunas
  `cupom`, `desconto`), `src/lib/metrics.ts` + projeção em `src/lib/mcp/tools.ts` (`coupons`),
  `src/lib/notify/telegram-job.ts` (linha do cupom no aviso de venda), `src/lib/orders/report.ts` (`couponCode`,
  `discountCents` no `orders.paidReport`)
- Test: `tests/panel-actions.test.ts`, `tests/orders.test.ts`, `tests/metrics.test.ts`, `tests/mcp-tools.test.ts`,
  `tests/telegram.test.ts`, `tests/paid-report.test.ts`

**Interfaces:**
- Produces: `MetricsSummary.coupons: { code: string; orders: number; discountCents: number; revenueCents: number }[]`
  (pedidos pagos do período). O aviso do Telegram ganha `Cupom: KIDS10 (−R$ 0,99)`.
- [ ] **Step 1: testes que falham:** CSV com as colunas novas; detalhe do pedido com cupom; métricas por cupom;
  `metrics_summary` pelo MCP sem `@` em nenhuma string; aviso do Telegram com a linha do cupom e sem dado pessoal novo.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3: implementar.**
- [ ] **Step 4:** → PASS e `bun run build` sem erro.
- [ ] **Step 5:** `bun run check` e commit `feat(cupom): painel, relatório, métricas e aviso`.

### Task A6: documentação e conferência final

**Files:**
- Modify: `docs/instalacao.md` (seção "Cupons": criar, regras, piso, limite por pessoa, `?cupom=`), `docs/painel-pendencias.md`
  se aplicável
- [ ] **Step 1:** documentação.
- [ ] **Step 2:** `bash scripts/verify.sh` em segundo plano → PASS.
- [ ] **Step 3:** commit `docs(cupom): como criar e usar cupons`. Parar e pedir o ok do dono para push e PR.

**PR de verificação A (depois do merge de A):** E2E "checkout com cupom → Pix do Asaas falso com valor descontado →
pago → e-mail de entrega" e "cupom inválido mostra a mensagem neutra". Só `e2e/`.

---

## Parte B1: upsell e downsell com Pix (PR B1, migração 0038)

### Task B1-1: tabelas, colunas e visibilidade da oferta

**Files:**
- Create: `src/lib/db/schema/post-purchase.ts`, `drizzle/0038_post_purchase.sql` (+ `enable_store_rls` de
  `post_purchase_offer` e `post_purchase_decision`)
- Modify: `src/lib/db/schema/catalog.ts` (`offer.visibility`), `src/lib/db/schema/orders.ts`,
  `src/lib/catalog/offers.ts` (`offers.getPublic` e `checkout.start` recusam `post_purchase` com `not_found`)
- Test: `tests/post-purchase.test.ts` (novo), `tests/catalog.test.ts`, `tests/checkout.test.ts`, `tests/card-role.test.ts`

**Interfaces:**
- Produces:
  - `offer.visibility text not null default 'public'` (check `public | post_purchase`).
  - `post_purchase_offer`: `id`, `store_id`, `offer_id` (origem), `kind` (`upsell | downsell`), `target_offer_id`,
    `title text not null` (≤ 120), `body text` (≤ 600), `accept_label` (≤ 60), `decline_label` (≤ 60), `created_at`.
    FKs compostas para `offer` (ambas, cascade). Único `(offer_id, kind)`. Check `offer_id <> target_offer_id`.
  - `post_purchase_decision`: `store_id`, `order_id` (FK composta, cascade), `kind`, `decision` (`shown | accepted |
    declined`), `at`. Único `(order_id, kind, decision)`.
  - `orders.parent_order_id uuid` (FK composta `(store_id, parent_order_id)` → `orders`), `orders.funnel_step text`
    (check `upsell | downsell`), check `(parent_order_id is null) = (funnel_step is null)`, único parcial
    `(parent_order_id, funnel_step) where parent_order_id is not null`.
- [ ] **Step 1: testes que falham:** `/c/<slug>` de oferta `post_purchase` → `not_found` (página 404 e
  `checkout.start`); RLS das tabelas novas; segundo pedido-filho do mesmo passo → violação do único; o papel `card`
  não lê as tabelas novas.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3: implementar.**
- [ ] **Step 4:** + `tests/migrate.test.ts tests/rls.test.ts` → PASS.
- [ ] **Step 5:** `bun run check` e commit `feat(upsell): ofertas pós-compra e pedido-filho`.

### Task B1-2: configuração no editor da oferta e ações `postPurchase.*`

**Files:**
- Create: `src/lib/post-purchase/config.ts`
- Modify: `src/lib/catalog/offers.ts` (`offers.create`/`update` aceitam `visibility`), `src/app/admin/(panel)/offers/[id]/editor.tsx`
  (seção "Depois da compra": upsell e downsell, com oferta-alvo, título, texto e botões), `src/lib/actions/all.ts`,
  `src/lib/mcp/tools.ts`
- Test: `tests/post-purchase.test.ts`, `tests/mcp-tools.test.ts`

**Interfaces:**
- Produces:
  - `postPurchase.get` (`offers.read`): `{ offerId }` → `{ upsell, downsell }`.
  - `postPurchase.set` (`offers.write`, `sensitive: true`): `{ offerId, kind, targetOfferId, title, body, acceptLabel, declineLabel } | { offerId, kind, remove: true }`.
    A oferta-alvo precisa estar ativa e ser `post_purchase`. Downsell sem upsell → `invalid_input`. A oferta de origem
    não pode ser `post_purchase` (sem upsell de upsell).
  - Prévia no editor com o preço da oferta-alvo e o botão "Sim, quero por R$ X".
- [ ] **Step 1: testes que falham:** salvar e ler; alvo `public` → `invalid_input`; downsell sem upsell →
  `invalid_input`; pelo MCP vira pedido de aprovação.
- [ ] **Step 2:** → FAIL. **Step 3:** implementar. **Step 4:** → PASS e `bun run build`.
- [ ] **Step 5:** `bun run check` e commit `feat(upsell): configuração no editor da oferta`.

### Task B1-3: cookie do comprador

**Files:**
- Create: `src/lib/post-purchase/buyer-cookie.ts`
- Modify: `src/app/c/[slug]/actions.ts` (`startCheckoutAction` grava o cookie depois de criar o pedido)
- Test: `tests/post-purchase.test.ts`

**Interfaces:**
- Produces:
  - `BUYER_COOKIE = "funil_buyer"`, `BUYER_COOKIE_MAX_AGE_S = 7200`, até 5 `publicId` (o mais novo primeiro).
  - `sealBuyerCookie(publicIds: string[], storeId: string, secret: string, now): string` e
    `openBuyerCookie(value, storeId, secret, now): string[]` (HMAC-SHA256 com `SECRET`, `timingSafeEqual`, expiração
    no valor; cookie de outra loja ou adulterado → `[]`). Atributos: `HttpOnly; Secure; SameSite=Lax; Path=/o`.
- [ ] **Step 1: testes que falham:** ida e volta; adulterado → `[]`; outra loja → `[]`; vencido → `[]`; sexto pedido
  tira o mais antigo; o valor não contém e-mail nem nome.
- [ ] **Step 2:** → FAIL. **Step 3:** implementar. **Step 4:** → PASS.
- [ ] **Step 5:** `bun run check` e commit `feat(upsell): cookie assinado do navegador da compra`.

### Task B1-4: aceitar e recusar (`checkout.acceptPostPurchase`, `checkout.declinePostPurchase`)

**Files:**
- Create: `src/lib/post-purchase/accept.ts`
- Modify: `src/lib/orders/create.ts` (`createOrder` aceita `parent: { orderId, step }` e `buyerFrom: orderId`; sem
  bump e sem cupom nesse caminho), `src/lib/actions/all.ts`, `src/lib/mcp/tools.ts` (públicas: fora)
- Test: `tests/post-purchase.test.ts`, `tests/checkout.test.ts`

**Interfaces:**
- Consumes: B1-1, B1-3, `startAsaasPix`, `allocateManualAmount` (via `createOrder`), `enqueueInitiateCheckout`.
- Produces:
  - `postPurchaseFor(tx, parentOrder, now)`: devolve a oferta da vez (`upsell`, ou `downsell` se o upsell foi recusado)
    ou `null`. A regra: pai `paid`, sem `parent_order_id`, `paid_at > now − 60 min`, alvo ativo e com todos os
    produtos vivos, comprador (caixa) sem todos os produtos do alvo em pedidos `paid` dos últimos 365 dias (contando o
    pai), e sem decisão `accepted`/`declined` do passo.
  - `checkout.acceptPostPurchase` (público, `audit` com `parentOrderId` e `kind`, sem dado pessoal): entrada
    `{ parentPublicId, kind, expectedTotalCents, method: "pix" | "card", clientIp, userAgent, buyerPublicIds: string[] }`
    (`buyerPublicIds` vem do cookie aberto pela server action, nunca do navegador). O `parentPublicId` precisa estar
    em `buyerPublicIds` (senão `forbidden`). Cria o pedido-filho com nome, e-mail, celular e CPF do pai
    (`buyer_*`/`customer`), `first_touch`/`last_touch`/`fbc`/`fbp` do pai e o IP e user agent atuais. Método: Pix
    segue o `pix_mode` da oferta-alvo (Asaas exige o CPF do pai; sem CPF e sem Pix manual → `conflict`). Preço
    diferente de `expectedTotalCents` → `conflict` `PRICE_CHANGED`. Grava a decisão `accepted`. Limites: os mesmos do
    Asaas no `checkout.start` (por IP e por e-mail), mais o único `(parent_order_id, funnel_step)`. Repetir "Sim" no
    mesmo passo devolve o pedido-filho já criado (idempotente), em vez de erro.
  - `checkout.declinePostPurchase` (público, `audit: false`): mesma checagem do cookie; grava `declined`.
  - `checkout.viewPostPurchase` (público, `audit: false`): grava `shown` uma vez por passo (para as métricas).
- [ ] **Step 1: testes que falham:**
  - `pai pago há 10 min, cookie certo → aceita, cria filho pix_asaas com total do alvo, parent_order_id, funnel_step upsell,
    itens somam o total, InitiateCheckout enfileirado`.
  - `sem cookie / cookie de outro pedido → forbidden, nada criado`.
  - `pai pago há 61 min → conflict, nada criado`; `pai pendente → conflict`.
  - `comprador com o bump (já tem os 5 kits) → postPurchaseFor null`; `comprou o Completo antes → null`.
  - `"Sim" duas vezes → o mesmo pedido-filho`; `"Não" no upsell → downsell disponível; "Não" no downsell → null`.
  - `preço do alvo mudou → conflict PRICE_CHANGED`.
  - `filho pago → deliver_order, Purchase com purchase:<publicId do filho> e value do filho, Telegram sale` (pelo
    `transitionOrder` normal).
  - `filho não oferece upsell (sem upsell de upsell)`.
  - `auditoria e log sem e-mail, nome, CPF ou valor do cookie`.
- [ ] **Step 2:** → FAIL. **Step 3:** implementar. **Step 4:** + `tests/meta.test.ts tests/delivery.test.ts` → PASS.
- [ ] **Step 5:** `bun run check` e commit `feat(upsell): aceitar e recusar a oferta pós-compra`.

### Task B1-5: página de obrigado

**Files:**
- Create: `src/app/o/[publicId]/post-purchase.tsx` (cliente: caixa com título, texto, preço, "Sim, quero por R$ X" e
  "Não, obrigado")
- Modify: `src/app/o/[publicId]/page.tsx` (no `ThankYou`, lê o cookie, chama a ação de leitura e mostra a caixa),
  `src/app/o/[publicId]/actions.ts` (`acceptPostPurchaseAction`, `declinePostPurchaseAction`, que só montam a entrada
  e chamam `runAction`; ao aceitar com Pix, `startAsaasPix` fora da transação, como no `startCheckout`, e depois
  `redirect('/o/<filho>')`), `src/lib/checkout.ts` (`getOrderPublic` ganha `postPurchase` só quando autorizado, sem
  dado pessoal), `src/lib/post-purchase/buyer-cookie.ts` (o pedido-filho também entra no cookie)
- Test: `tests/post-purchase.test.ts`, `tests/delivery-page.test.ts` (ou o teste da página do pedido existente)

**Interfaces:**
- Produces: a caixa fica **abaixo** do "obrigado" (o que foi comprado continua em primeiro lugar). Um clique cria o
  pedido e leva ao Pix do filho. O pedido-filho pago mostra "Pronto! {produto} também chega no seu e-mail". O
  `PurchasePixel` do pai não muda, e o do filho dispara na página do filho. Os textos de botão vêm da configuração, e
  os padrões são "Sim, quero por R$ X" e "Não, obrigado".
- [ ] **Step 1: testes que falham:** obrigado com cookie mostra a caixa; sem cookie não mostra; recusar mostra o
  downsell; HTML do obrigado sem e-mail/CPF.
- [ ] **Step 2:** → FAIL. **Step 3:** implementar (celular 390 px, `docs/padrao-de-paginas.md` para o painel e o
  padrão do comprador para `/o`). **Step 4:** → PASS e `bun run build`.
- [ ] **Step 5:** `bun run check` e commit `feat(upsell): oferta na página de obrigado`.

### Task B1-6: métricas, relatório, painel do pedido e documentação

**Files:**
- Modify: `src/lib/metrics.ts` + projeção MCP (`postPurchase`), `src/lib/orders/report.ts` (`funnelStep`),
  `src/lib/orders/panel.ts` + página do pedido ("Upsell do pedido #X" com link, e no pai "Upsell: pedido #Y"),
  `src/lib/notify/telegram-job.ts` ("Venda (upsell)"), `docs/instalacao.md` (seção "Upsell e downsell")
- Test: `tests/metrics.test.ts`, `tests/paid-report.test.ts`, `tests/orders.test.ts`, `tests/telegram.test.ts`, `tests/mcp-tools.test.ts`
- [ ] **Step 1: testes que falham:** `postPurchase: { shown, accepted, paid, revenueCents, byKind }` no período; MCP
  só com números; aviso "Venda (upsell)".
- [ ] **Step 2:** → FAIL. **Step 3:** implementar. **Step 4:** → PASS.
- [ ] **Step 5:** `bash scripts/verify.sh` em segundo plano → PASS; commit `feat(upsell): métricas, painel e documentação`.
  Parar e pedir o ok do dono.

**PR de verificação B1:** E2E "compra Pix (Asaas falso) → pago → obrigado com a oferta → Sim → Pix do filho → pago →
dois e-mails de entrega" e "outro navegador com o link do obrigado não vê a oferta".

---

## Parte B2: upsell no cartão (PR B2, sem migração)

### Task B2-1: bilhete do pedido-filho

**Files:**
- Modify: `src/lib/post-purchase/accept.ts` (com `method: "card"`, o filho é `card_asaas` e a server action devolve
  `cardTicket`, emitido com `issueCardTicket` como no `startCheckout`), `src/app/o/[publicId]/actions.ts`
- Test: `tests/post-purchase.test.ts`, `tests/card-ticket.test.ts`
- [ ] **Step 1: testes que falham:** aceitar com cartão → filho `card_asaas` + bilhete com o total do alvo e
  `maxInstallments` do alvo; `checkout.renewCardTicket` funciona para o filho; sem `CARD_TICKET_KEY` → `conflict`
  `CARD_UNAVAILABLE_MESSAGE` antes de criar o filho.
- [ ] **Step 2:** → FAIL. **Step 3:** implementar. **Step 4:** → PASS.
- [ ] **Step 5:** `bun run check` e commit `feat(upsell): bilhete de cartão do pedido-filho`.

### Task B2-2: iframe do cartão no obrigado

**Files:**
- Modify: `src/app/o/[publicId]/post-purchase.tsx` (reaproveita `src/app/c/[slug]/card-frame.ts`; se precisar,
  extrair a parte comum para `src/app/(design)/` ou `src/lib/card-frame/`, sem mudar o protocolo), `docs/seguranca-pagamento.md`
  (o obrigado passa a ser página onde se digita cartão: inventário de scripts e CSP)
- Test: `tests/card-frame-parent.test.ts`, `tests/csp.test.ts`, `tests/page-monitor.test.ts`
- [ ] **Step 1: testes que falham:** a CSP do `/o/` tem o `frame-src` do cartão (já tem, então o teste só trava a
  regra); o pai do iframe no `/o/` só aceita mensagens da origem do cartão; aprovado → navega para `/o/<filho>`;
  recusado → a mensagem de recusa e o formulário para tentar de novo no mesmo pedido-filho. "Ou pague com Pix" só
  aparece **antes** da escolha do método: depois que o filho `card_asaas` existe, o único por passo
  (`parent_order_id, funnel_step`) impede um segundo filho, e trocar para Pix fica fora desta parte.
- [ ] **Step 2:** → FAIL. **Step 3:** implementar. **Step 4:** → PASS e `bun run build`.
- [ ] **Step 5:** `bun run check` e commit `feat(upsell): cartão na página de obrigado`.

### Task B2-3: conferência

- [ ] `bash scripts/verify.sh` → PASS; `tests/card-role.test.ts` e `tests/card-leaks.test.ts` sem mudança de permissão.
  Parar e pedir o ok do dono.

**PR de verificação B2:** E2E do upsell no cartão com o Asaas falso (aprovado e recusado).

---

## Parte C: sequência de e-mails pós-compra (PR C, migração 0039)

### Task C1: tabelas e o kind `sequence` no `email_log`

**Files:**
- Create: `src/lib/db/schema/sequence.ts`, `drizzle/0039_email_sequence.sql` (+ `enable_store_rls` de
  `email_sequence_step` e `sequence_email`)
- Modify: `src/lib/db/schema/delivery.ts` (check do `email_log.kind` com `sequence`), `src/lib/delivery/email-log.ts`
- Test: `tests/sequence.test.ts` (novo), `tests/card-role.test.ts`, `tests/rls.test.ts`, `tests/migrate.test.ts`

**Interfaces:**
- Produces:
  - `email_sequence_step`: `id`, `store_id`, `offer_id` (FK composta, cascade), `position` (1–5, único por oferta),
    `delay_hours` (1–720), `subject` (≤ 120), `body` (≤ 4000), `button_label` (≤ 60), `button_url` (≤ 500, `https://`),
    `skip_if_has_offer_id` (FK composta, set null: pula a caixa que já tem todos os produtos dessa oferta em pedidos pagos), `active boolean default false`, `activated_at timestamptz`
    (gravado toda vez que o passo é ligado), `updated_at`.
  - `sequence_email`: como `recovery_email` (`email_hash`, `mailbox_hash`, `status` `queued|sending|sent|failed|skipped`,
    `skip_reason`, `unsub_hash` único, `job_id`, `due_at`, `sent_at`, `created_at`, `expires_at` = criação + 90 d),
    mais `order_id` (FK composta, cascade) e `step_id` (FK composta, cascade). Único `(order_id, step_id)`. Índices
    `(store_id, mailbox_hash, created_at desc)`, `(store_id, created_at desc)`, `(expires_at)`.
  - `EmailKind` com `"sequence"`.
- [ ] Steps 1–5 como nas outras tabelas (RLS, `card` sem acesso, único por pedido e passo). Commit
  `feat(sequencia): tabelas dos passos e dos envios`.

### Task C2: modelo do e-mail e texto da loja

**Files:**
- Modify: `src/lib/delivery/templates.ts` (`sequenceEmail`), `src/lib/recovery/unsubscribe.ts` (texto da página D26)
- Test: `tests/sequence-templates.test.ts` (novo), `tests/recovery-unsubscribe.test.ts`

**Interfaces:**
- Produces: `sequenceEmail(d: { storeName; brandColor; subject; body; firstName; buttonLabel?; buttonUrl?; unsubscribeUrl })`
  → `{ subject, html, text, headers }`. O corpo vira parágrafos (linha em branco separa), cada um com `esc`. `{nome}` é
  trocado depois do escape, pelo primeiro nome escapado (vazio → "Olá"). O botão só sai com URL `https`. O rodapé é
  fixo: "Você recebeu este e-mail porque comprou na {loja}. **Não quero receber e-mails da {loja}** → `/sair/<token>`".
  `List-Unsubscribe` + `List-Unsubscribe-Post`. A página `/sair` diz "Não quer mais receber e-mails da {loja}
  (lembretes e novidades)?" e "Pronto: a {loja} não vai mais mandar lembretes nem novidades para este e-mail. Os
  e-mails da sua compra continuam chegando."
- [ ] **Step 1: testes que falham:** `<script>` no corpo sai escapado; `{nome}` com `<b>` sai escapado; URL `http:` ou
  `javascript:` não vira botão; quebra de linha no assunto vira uma linha; os cabeçalhos estão presentes; textos novos
  do `/sair`.
- [ ] Steps 2–5. Commit `feat(sequencia): modelo do e-mail e texto do descadastro`.

### Task C3: ações (`sequences.*`), editor da oferta e e-mail de teste

**Files:**
- Create: `src/lib/sequence/actions.ts`
- Modify: `src/app/admin/(panel)/offers/[id]/editor.tsx` (seção "E-mails depois da compra": até 5 passos, prévia com
  dados de exemplo e "Mandar teste para mim"), `src/lib/actions/all.ts`, `src/lib/mcp/tools.ts`
- Test: `tests/sequence.test.ts`, `tests/mcp-tools.test.ts`

**Interfaces:**
- Produces:
  - `sequences.get` (`offers.read`): passos da oferta.
  - `sequences.save` (`offers.write`, `sensitive: true`): substitui a lista de passos da oferta (`strictObject`, até 5).
    Ligar exige o e-mail da loja conectado (`emailProviderReady`, como na recuperação). Ligar um passo grava
    `activated_at = now()`.
  - `sequences.sendTest` (`offers.write`, em `MCP_EXCLUDED` com o motivo "manda e-mail para o usuário do painel"): manda
    o passo com dados de exemplo ("Maria") para o e-mail do usuário logado, com um limite de 10 por hora.
- [ ] **Step 1: testes que falham:** salvar/ler; 6 passos → `invalid_input`; ligar sem e-mail conectado →
  `invalid_input`; religar atualiza `activated_at`; pelo MCP `sequences_save` vira aprovação; `sendTest` nunca usa
  comprador real.
- [ ] Steps 2–5. Commit `feat(sequencia): configuração dos e-mails no editor da oferta`.

### Task C4: varredura (`sequence_scan`)

**Files:**
- Create: `src/lib/sequence/rules.ts` (`SEQUENCE = { lookbackHours: 24, mailboxGapHours: 20, sendGraceMin: 120, retentionDays: 90, defaultPerDay: 30, defaultPerHour: 10, storeMailReserve24h: 60 }`), `src/lib/sequence/scan.ts`
- Modify: `src/lib/db/schema/core.ts` + a migração da C1 (`store.sequence_per_day integer not null default 30`,
  `store.sequence_per_hour integer not null default 10`, editáveis em Configurações pelo `store.updateSettings`, que já é
  sensível no MCP)
- Modify: `src/lib/jobs.ts` (`"sequence_scan"`, `"sequence_send"`), `src/lib/jobs/handlers.ts`, `src/lib/jobs/worker.ts`
  (`scheduleOnce("sequence_scan")` junto da `recovery_scan`)
- Test: `tests/sequence.test.ts`

**Interfaces:**
- Produces: por loja, sob `pg_advisory_xact_lock(hashtext('sequence:' || storeId))`, para cada passo ativo:
  candidatos = pedidos `paid` da oferta com `paid_at >= activated_at`, `paid_at + delay <= now` e
  `paid_at + delay > now − 24 h`, sem linha `sequence_email` para `(order, step)`. Pula **com linha `skipped`**
  (motivo): `optout`, `endereco_invalido`, `ja_tem` (a caixa já tem todos os produtos da oferta de
  `skip_if_has_offer_id` em pedidos pagos: conta o bump), `repetido` (o mesmo passo já saiu para a caixa por outro
  pedido), `cota` (devido há mais de 24 h sem vaga). Pula **sem linha** (próxima varredura): a caixa recebeu e-mail de
  sequência nas últimas 20 h; o teto da loja por hora ou por dia (`store.sequence_per_hour`/`sequence_per_day`); ou a
  **reserva da entrega** (D27: mais de 60 linhas no `email_log` da loja nas últimas 24 h). Senão insere `queued` e enfileira
  `sequence_send { sequenceId, unsubToken }` na mesma transação (o token em claro só no payload do job, como na
  recuperação).
- [ ] **Step 1: testes que falham** (relógio injetado):
  - `pedido pago há 25 h, passo D+1 ativo desde antes → 1 linha queued + 1 job`.
  - `ligar a sequência com 500 compradores de ontem → nenhuma linha` (`paid_at < activated_at`).
  - `devido há 30 h (worker parado) → nada`.
  - `optout → skipped optout`; `comprou o Completo, ou o Almanaque com o bump → passo D+5 skipped ja_tem`.
  - `dois passos devidos para a mesma caixa → um agora, o outro na varredura depois de 20 h`.
  - `11º da loja na hora e 31º no dia → sem linha`; `61 e-mails no email_log em 24 h → nenhuma sequência enfileirada`;
    `devido há 25 h sem vaga → skipped cota`.
  - `duas varreduras simultâneas → uma linha por (pedido, passo)`.
  - `log sem e-mail nem token`.
- [ ] Steps 2–5. Commit `feat(sequencia): varredura dos passos devidos`.

### Task C5: envio (`sequence_send`) e descadastro compartilhado

**Files:**
- Create: `src/lib/sequence/send.ts`
- Modify: `src/lib/jobs/handlers.ts`, `src/lib/recovery/unsubscribe.ts` (procura o `unsub_hash` também em
  `sequence_email`, e grava o mesmo `email_optout`)
- Test: `tests/sequence.test.ts`, `tests/recovery-unsubscribe.test.ts`

**Interfaces:**
- Produces: como o `recovery_send`. Reivindica `queued → sending`, confere de novo (pedido ainda `paid`, passo ainda
  ativo, sem optout, `ja_comprou`), monta `sequenceEmail` com o primeiro nome do pedido, chama `sendMail` fora de
  transação com `idempotencyKey: sequenceId` e grava `email_log` `sequence` (destinatário só em hash). Falhas (D30):
  `provider_error` → `failed`; erro temporário até `due_at + 120 min` → `queued` e relança; depois → `failed`.
- [ ] **Step 1: testes que falham:** `envia com List-Unsubscribe e utm no botão do domínio da loja`; `reembolsado
  entre a varredura e o envio → skipped`; `passo desligado → skipped`; `descadastro pelo link da sequência grava
  email_optout e a recuperação também pula a caixa`; `segundo sequence_send da mesma linha não reenvia`; `log e
  audit_log sem e-mail/token`.
- [ ] Steps 2–5. Commit `feat(sequencia): envio pelo e-mail da loja e descadastro único`.

### Task C6: aviso no checkout, métricas, retenção e documentação

**Files:**
- Modify: `src/lib/catalog/offers.ts` (`offers.getPublic` devolve `postPurchaseEmails: boolean`),
  `src/app/c/[slug]/checkout-form.tsx` (linha abaixo do botão, D29), `src/lib/metrics.ts` + projeção MCP (`sequence`),
  `src/lib/leads/panel.ts` (`sweepLeadsJob` apaga `sequence_email` vencida), `src/lib/orders/panel.ts` (linha do tempo
  "E-mail da sequência {n} enviado"), `docs/instalacao.md` (seção "E-mails depois da compra": regras, limites, cota do
  Resend, descadastro, LGPD e jurídico)
- Test: `tests/metrics.test.ts`, `tests/leads.test.ts`, `tests/orders.test.ts`, `tests/mcp-tools.test.ts`, `tests/checkout.test.ts`
- [ ] **Step 1: testes que falham:** a linha do aviso só aparece com sequência ativa na oferta;
  `sequence: { sent, skipped, salesFromSequence, revenueCents }` (venda = pago com `utm_source=sequencia` no último
  toque); MCP só números; o sweep apaga as linhas vencidas e mantém `email_optout`.
- [ ] Steps 2–4. **Step 5:** `bash scripts/verify.sh` → PASS; commit `feat(sequencia): aviso no checkout, métricas e
  documentação`. Parar e pedir o ok do dono. **Não ligar em produção antes do jurídico** (D29).

**PR de verificação C:** E2E "passo D+1 ativo → pedido pago com data movida → e-mail no Resend falso com
`List-Unsubscribe` → `/sair` → próximo passo não sai".

---

## Depois de cada merge (produção)

- Backup (`~/backups/backup-offsite.sh`), `git pull --ff-only`, `docker compose build`, `up -d`, conferir
  `/api/health`. A migração roda no entrypoint. Isso é feito pelo dono ou com o ok dele. Este plano não roda nada
  contra a produção.
- A: criar o cupom de teste no painel, fazer uma compra real com cupom (Pix) e reembolsar.
- A: o dono cria o cupom KIDS10 (10%, Almanaque, Completo e a oferta pública dos kits, 30 dias, 1 por pessoa).
- B1/B2: ofertas `post_purchase` "5 Kits Extras" R$ 17,10 (upsell) e R$ 12,90 (downsell) ligadas ao `/c/almanaque`,
  com os textos aprovados; compra real só do Almanaque → upsell → reembolsar os dois.
- C: oferta pública `/c/kits` R$ 17,10; passos D+1, D+3 e D+5 (com `?cupom=KIDS10` e `skip_if_has_offer_id` = kits)
  na oferta Almanaque; mandar o teste para si mesmo e só ligar depois do jurídico. Com o Resend gratuito, acompanhar
  `skipped cota` e migrar para o plano pago quando as vendas passarem de ~25 por dia.

## Fora deste plano

- Cartão em um clique (token do Asaas na memória do `card`) — PR B3, só com ok do dono e confirmação do Asaas (D17).
- Cupom no upsell, cupom acumulado, cupom automático; mais de um upsell em sequência; A/B.
- Disparos avulsos para a base; importar compradores da Cakto; rastreio de abertura/clique.
- `email_hash` com HMAC e descadastro manual pelo painel (melhorias já anotadas no PR #15).
