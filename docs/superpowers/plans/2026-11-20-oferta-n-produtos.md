# Oferta e bump com N produtos: plano de implementação (PR 1 e PR 2)

> **Para agentes:** sub-skill obrigatória: superpowers:subagent-driven-development (recomendada) ou
> superpowers:executing-plans, tarefa por tarefa. Os passos usam checkbox (`- [ ]`).

**Objetivo:** uma oferta, e o bump dela, entrega N produtos (PDFs). Cada um gera um link próprio, e o preço é rateado em
centavos entre os itens. Com isso o Almanaque Kids (o Completo com 6 PDFs e o bump "5 Kits Extras" com 5 PDFs) roda no
funil.

**Arquitetura:**
- A tabela nova `offer_product` (oferta, produto, grupo `main`/`bump`, posição) passa a ser a fonte dos produtos da
  oferta. A migração copia os dados das colunas `offer.product_id` e `offer.bump_product_id`, e a última task remove
  essas colunas.
- O pedido grava um `order_item` por produto, com o preço rateado e a posição.
- A entrega, que já cria um link por item, passa a seguir a posição.
- O checkout mostra "Inclui:" quando a oferta tem mais de um produto.

**Stack:** Next 16, Drizzle e Postgres 17 (RLS), Zod 4, Bun para os testes, Playwright no PR 2.

**Spec:** `docs/superpowers/specs/2026-11-20-kids-migracao-design.md` (seção 1 e "O que o comprador vê").

## Restrições globais

- **Dinheiro:** sempre em centavos inteiros. A soma dos `order_item.price_cents` de um pedido é igual a
  `orders.total_cents`.
- **Rateio:** divisão igual dentro de cada grupo (principal e bump), com a sobra da divisão inteira no primeiro item do
  grupo. Exemplos: 2.700 em 6 itens dá 450 cada; 1.710 em 5 dá 342 cada; 1.000 em 3 dá 334, 333 e 333.
- **Validação da oferta:** pelo menos 1 produto principal e no máximo 20 por grupo. O mesmo produto não aparece duas vezes
  na oferta, nem somando principal e bump.
- **Bump:** com mais de 1 produto, o rótulo (`bumpLabel`) é obrigatório.
- **Comprador:**
  - o checkout mostra o nome da oferta e, com mais de 1 produto principal, a linha "Inclui:" com os nomes separados por
    " · ";
  - o cartão do bump mostra o rótulo, ou o nome do produto se o bump tiver um só;
  - o e-mail de entrega lista um link por PDF, sem preço por item, só com o total do pedido;
  - o comprador nunca vê preço rateado.
- **Assunto do e-mail de entrega:** "Seu acesso: <nome do produto>" quando a oferta tem 1 produto principal (como hoje). Com
  mais de 1, "Seu acesso: <nome da oferta>".
- **Ação sensível:** mudar os produtos de uma oferta (`offers.setProducts`, sensível como `offers.updatePrice`).
- **CSV:** sem coluna nova. A coluna `produto(s)` lista todos os itens, unidos por " + ".
- **Tabela nova:** tem `store_id` e chama `enable_store_rls`. O papel `card` ganha leitura de `offer_product` só se
  `payWithCard` precisar dela (ver Task 3).
- **E2E:** o E2E atual passa **sem mudança** no PR 1. Ele usa os rótulos "Produto entregue", "Oferecer order bump",
  "Produto do bump" e "Total com bump: R$ 27,00", o assunto "Seu acesso: Maná bíblico · versão básica" e 2 links no
  e-mail.
- **PR 1:** não edita `e2e/`, `scripts/verify*`, `.github/`, `.claude/`, `REVIEW.md` nem `playwright.config.ts`.
- **Processo:** `bun run check` antes de cada commit, e `bash scripts/verify.sh` antes do PR. Nunca pular, re-tentar nem
  pôr espera em teste.

## Foco de revisão

1. **Um produto da oferta é apagado (soft delete):**
   - se for um principal, a oferta deixa de vender, com 404 no checkout, como hoje quando o principal é apagado;
   - se for do bump, o bump some.

   Nunca se vende um combo incompleto. O teste fica na Task 2.
2. **Soma igual ao total em qualquer combinação:** principal com e sem bump, 1 a 20 itens por grupo, totais com sobra, e
   Pix manual com o valor único (o `manual_amount_cents` não entra no rateio; os itens somam `total_cents`). Teste de
   propriedade na Task 3.
3. **Ordem dos produtos:** reordenar na oferta muda a ordem do e-mail e dos links de pedidos novos e não altera pedidos já
   feitos. O teste fica na Task 3.
4. **Oferta alterada entre o checkout e o pagamento:** o pedido guarda os itens no momento da criação. Mudar a oferta
   depois não altera a entrega de um pedido pendente. O teste fica na Task 3.
5. **Migração com dados reais:** uma oferta com bump e outra sem bump viram exatamente 1 e 2 linhas em `offer_product`.
   Pedidos antigos sem posição ficam ordenados como hoje (principal antes do bump). O teste fica na Task 1.

---

## PR 1 (produto), branch `kids-migracao`

### Task 1: tabela `offer_product`, posição no item do pedido e rateio

**Arquivos:**
- Criar: `drizzle/0022_offer_products.sql` (gerado pelo drizzle-kit, com o backfill escrito à mão) e
  `src/lib/money.ts` (ou acrescentar a ele, se já existir algo equivalente; procure antes)
- Modificar: `src/lib/db/schema/catalog.ts`, `src/lib/db/schema/orders.ts`
- Testes: `tests/money.test.ts`, `tests/migrate-offer-products.test.ts`

**Interfaces:**
- **Produz:**
  - a tabela `offerProduct` com `id`, `storeId`, `offerId` (FK com cascade), `productId` (FK), `kind: "main" | "bump"`
    e `position` (int ≥ 0), mais `unique(offer_id, product_id)`, `index(offer_id, kind, position)` e
    `enable_store_rls('offer_product')`;
  - a coluna nova `orderItem.position` (int not null, default 0);
  - `splitCents(totalCents: number, n: number): number[]`, que lança erro se `n < 1` ou se `totalCents` não for inteiro
    ≥ 0.
- **Backfill na migração:** cada oferta gera `(product_id, 'main', 0)` e, se tiver bump, `(bump_product_id, 'bump', 0)`.
  As colunas antigas **continuam existindo** nesta task e saem na Task 5.

- [ ] **Passo 1: testes que falham.**
  - `splitCents(2700, 6)` dá `[450, 450, 450, 450, 450, 450]`;
    `splitCents(1710, 5)` dá `[342, 342, 342, 342, 342]`;
    `splitCents(1000, 3)` dá `[334, 333, 333]`.
  - Propriedade (fast-check), para total de 0 a 10⁷ e n de 1 a 20:
    - a soma é igual ao total;
    - todos os valores são inteiros ≥ 0;
    - a diferença entre o maior e o menor é ≤ n − 1 e fica só no primeiro;
    - `n = 0` lança erro.
  - Migração (banco de teste): monte as ofertas com o schema anterior, ou crie direto em SQL antes da migração 0022 se
    `tests/db.ts` permitir; caso contrário, rode o SQL do backfill sobre dados inseridos. Confira que:
    - a oferta com bump vira 2 linhas `main`/`bump` com `position` 0;
    - a oferta sem bump vira 1 linha;
    - o RLS isola por loja, ou seja, a loja B não enxerga a linha da loja A.
- [ ] **Passos 2 a 5:** rodar (FAIL), implementar, `bun run check` (PASS), commit
  `feat(ofertas): tabela offer_product, posição do item e rateio em centavos`.

### Task 2: ações de oferta com N produtos

**Arquivos:**
- Modificar: `src/lib/catalog/offers.ts` e `src/lib/catalog/products.ts` (`products.delete`)
- Criar: `src/lib/catalog/offer-products.ts` (leitura e gravação da lista, com regras compartilhadas)
- Teste: `tests/catalog.test.ts` (ou o arquivo onde estão os testes de oferta hoje)

**Interfaces:**
- Consome: `offerProduct` (Task 1).
- **`offer-products.ts`:**
  - `loadOfferProducts(tx, offerIds: string[]): Promise<Map<string, { main: ProductRef[]; bump: ProductRef[] }>>`, com
    `ProductRef = { id, name, deletedAt }`, ordenado por `position`;
  - `writeOfferProducts(ctx, offerId, main: string[], bump: string[])`, que apaga e regrava na mesma transação, com as
    posições 0..n−1.
- **Ações:**
  - `offers.create`: o input passa a `{ ..., productIds: string[] (1..20), bump: { productIds: string[] (1..20),
    priceCents, label? } | null }`;
  - `offers.setProducts` **(novo, `sensitive: true`)**: `{ id, productIds, bump: { productIds, priceCents, label? } |
    null }`;
  - `offers.update`: sem `productId`;
  - `offers.updatePrice`: só `priceCents`, porque o bump sai daqui para o `setProducts`;
  - `offers.get` e `offers.list` devolvem `products` e `bump.products`;
  - `offers.getPublic` devolve `products: { name }[]` e `bump: { products: { name }[], priceCents, label } | null`.
- **Regras das ações:**
  - produto inexistente ou apagado é recusado na gravação (`invalid_input`);
  - duplicado em qualquer grupo é recusado;
  - bump com mais de 1 produto sem rótulo é recusado;
  - no `getPublic`, qualquer principal apagado esconde a oferta (o mesmo que acontece hoje quando o principal é apagado),
    e qualquer produto do bump apagado esconde o bump;
  - por enquanto, as colunas antigas continuam sendo gravadas a partir dos primeiros itens, para não quebrar leitores
    ainda não migrados. Isso sai na Task 5.

- [ ] **Passo 1: testes que falham.**
  - Criar uma oferta com 6 principais.
  - Criar uma oferta com 1 principal e bump de 5 produtos com rótulo "5 Kits Extras".
  - Recusas:
    - duplicado entre principal e bump;
    - bump de 2 produtos sem rótulo;
    - 21 produtos;
    - produto apagado;
    - produto de outra loja (RLS dá `invalid_input`).
  - `offers.setProducts` com origem `mcp` dá `approval_required`, e o papel `support` recebe `forbidden`.
  - `getPublic`:
    - apagar 1 dos 6 principais faz a oferta deixar de ser pública;
    - apagar 1 produto do bump faz `bump` virar `null`;
    - a ordem segue a posição.
- [ ] **Passos 2 a 5:** rodar (FAIL), implementar, `bun run check` (PASS), commit
  `feat(ofertas): oferta e bump com N produtos (setProducts sensível)`.

### Task 3: pedido com N itens, rateio, entrega e painel

**Arquivos:**
- Modificar:
  - `src/lib/orders/create.ts`;
  - `src/lib/delivery/links.ts` e `src/lib/delivery/jobs.ts` (ordem por `kind` e `position`);
  - `src/lib/delivery/templates.ts` (sem preço por item, total no fim, assunto);
  - `src/lib/orders/panel.ts` (detalhe e CSV na ordem);
  - `src/lib/checkout.ts` (resumo do pedido);
  - `src/lib/tracking/meta.ts` (ordem; os `content_ids` já cobrem todos).
- Testes: `tests/checkout.test.ts`, `tests/delivery.test.ts`, `tests/panel-actions.test.ts`

**Interfaces:**
- Consome: `splitCents` (Task 1) e `loadOfferProducts` (Task 2).
- **Produz:** `createOrder` grava um `order_item` por produto:
  - principais com `splitCents(priceCents, nMain)`;
  - bump, se marcado, com `splitCents(bumpPriceCents, nBump)`;
  - `position` = posição na oferta.
- **Leituras:** toda leitura de itens ordena por `kind` (`main` antes de `bump`) e depois por `position`.
- **Papel `card`:** se `payWithCard` ou o `card-service` lerem a oferta ou os produtos para montar o pedido, ajuste o
  grant do papel `card` no `rls.sql` (leitura de `offer_product`), com teste em `tests/card-role.test.ts`. Se não lerem,
  registre isso no relatório.

- [ ] **Passo 1: testes que falham.**
  - **Completo (6 principais) por R$ 27,00:** gera 6 itens de 450 que somam 2.700, e a entrega (Task de links) cria 6
    `download_link`.
  - **Almanaque (990) + bump de 5 produtos (1.710):** gera 1 item de 990 e 5 de 342, com soma 2.700. Com o bump
    desmarcado, gera só 1 item.
  - **Propriedade:** para ofertas aleatórias com 1 a 20 itens por grupo, a soma dos itens é igual a `total_cents`, com e
    sem bump e no Pix manual.
  - **E-mail:**
    - lista os produtos na ordem da oferta;
    - o HTML e o texto **não** contêm o preço rateado (por exemplo "R$ 4,50" num Completo de 6) e contêm o total
      "R$ 27,00";
    - o assunto é "Seu acesso: <oferta>" com N principais e "Seu acesso: <produto>" com 1.
  - **Ordem:** reordenar a oferta depois do pedido não altera os itens desse pedido. Mudar os produtos da oferta com o
    pedido pendente não altera a entrega dele.
  - **Reembolso:** num pedido de 6 itens, os 6 links são revogados.
  - **CSV:** a coluna `produto(s)` traz os 6 nomes unidos por " + ".
- [ ] **Passos 2 a 5:** rodar (FAIL), implementar, `bun run check` (PASS), commit
  `feat(pedidos): N itens com rateio, entrega e painel na ordem da oferta`.

### Task 4: checkout e editor de oferta

**Arquivos:**
- Modificar:
  - `src/app/c/[slug]/page.tsx` e `checkout-form.tsx` (linha "Inclui:" e cartão do bump);
  - o editor de oferta do painel (procure por "Produto entregue" em `src/app/admin`);
  - o Pixel do navegador (`src/app/c/[slug]/tracking.ts`, `content_ids`).
- Testes: `tests/checkout.test.ts` (dados do `getPublic` para a página) e testes de unidade das funções puras do editor,
  se houver lógica fora do JSX.

**Interfaces:**
- Consome: `offers.create`, `offers.setProducts`, `offers.updatePrice` e `offers.getPublic` (Task 2).
- **Editor:**
  - o primeiro produto principal continua no select **"Produto entregue"**, e o botão "Adicionar produto" acrescenta
    outros selects, removíveis e reordenáveis por botões ↑/↓;
  - o bump continua com o checkbox **"Oferecer order bump"** e o primeiro produto no select **"Produto do bump"**, mais
    o mesmo "Adicionar produto";
  - o rótulo do bump é obrigatório com mais de 1 produto;
  - o texto **"Total com bump: R$ …"** continua igual;
  - salvar uma oferta existente com mudança de produtos chama `offers.setProducts` (sensível). Pelo painel, para o dono,
    a ação executa direto, como as outras sensíveis hoje.
- **Checkout:**
  - com mais de 1 principal, embaixo do nome aparece "Inclui: A · B · C";
  - o cartão do bump mostra o rótulo, ou o nome do produto se houver um só;
  - com 1 principal, nada muda.
- **Pixel:** os `content_ids` levam todos os produtos do pedido, o mesmo que a CAPI.

- [ ] **Passo 1: testes que falham.**
  - Os dados da página para o Completo trazem a linha "Inclui:" com os 6 nomes na ordem. Para uma oferta de 1 produto,
    não há linha "Inclui".
  - O Pixel montado no checkout para Almanaque + bump marcado tem 6 `content_ids`.
- [ ] **Passo 2:** rodar (FAIL), implementar e conferir no navegador:
  - criar o Completo pelo painel;
  - abrir o checkout;
  - fazer uma compra com Pix manual e liberar;
  - ver o e-mail com 6 links no Mailpit;
  - abrir um dos links.

  Use portas livres e encerre os processos pelo PID. Registre as capturas no relatório.
- [ ] **Passo 3:** `bun run check` (PASS) e commit `feat(ofertas): checkout com "Inclui" e editor com N produtos`.

### Task 5: remover as colunas antigas e fechar o PR 1

**Arquivos:**
- Criar: `drizzle/0023_drop_offer_product_columns.sql`
- Modificar: tudo que ainda lê ou grava `offer.productId` ou `offer.bumpProductId` (use `grep`), o schema e o
  `offer_bump_check`, que passa a valer só para `bump_price_cents` (nulo ou > 0).

- [ ] **Passo 1: teste que falha.** Um teste em `tests/catalog.test.ts` lê `information_schema.columns` e afirma que
  `offer.product_id` e `offer.bump_product_id` não existem. A busca no código por `bumpProductId|offer.productId` não
  encontra nada em `src/`, salvo comentários.
- [ ] **Passo 2:** remover as colunas, ajustar os leitores restantes e rodar `bun run check` (PASS).
- [ ] **Passo 3:** `bash scripts/verify.sh` precisa dar `VERIFY OK`, com o E2E atual **sem mudança**. Depois, abrir o
  PR 1.

## PR 2 (verificação), branch `kids-migracao-e2e` a partir do PR 1

### Task 6: E2E do Completo e do bump com 5 kits

**Arquivos:**
- Modificar: `e2e/smoke.spec.ts`. Só verificação, sem código de produto.

- [ ] **Passo 1:** pelo painel:
  - crie 6 produtos com PDFs gerados no teste (pdf-lib, uma página cada, nomes distintos);
  - crie a oferta **Completo**: R$ 27,00 e os 6 produtos na ordem do Kids;
  - crie a oferta **Almanaque**: R$ 9,90, com bump de 5 produtos, R$ 17,10 e rótulo "5 Kits Extras".
- [ ] **Passo 2:** compra do Completo por Pix manual, com o dono liberando o pagamento:
  - o checkout mostra "Inclui:" com os 6 nomes na ordem;
  - o e-mail no Mailpit tem 6 links distintos;
  - cada link baixa um PDF com o nome de arquivo do produto certo;
  - o e-mail não contém "R$ 4,50" e contém "R$ 27,00".
- [ ] **Passo 3:** compra do Almanaque com o bump marcado, pelo iframe do cartão:
  - total de R$ 27,00 e 6 links;
  - depois, reembolso pelo painel, e os 6 links ficam revogados.
- [ ] **Passo 4:** `bash scripts/verify.sh` precisa dar `VERIFY OK`. Depois, abrir o PR 2, base `main` após o merge do
  PR 1.
