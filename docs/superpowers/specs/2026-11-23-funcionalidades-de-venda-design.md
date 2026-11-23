# Funcionalidades de venda (cupom, upsell/downsell, sequência pós-compra): design

Data: 2026-11-23
Estado: **perguntas respondidas pelo dono em 23/11/2026 (seção 6); aguarda o ok final para implementar**. Nada implementado.
Contexto: loja Moradah Kids em produção (`checkout.moradah.com.br`), com `/c/almanaque` R$ 9,90 + bump "5 Kits
Extras" R$ 17,10 e `/c/completo` R$ 27. Asaas de produção (Pix e cartão), Resend, Meta e Telegram conectados. Sem Pix
manual na loja.

Spec de origem: `docs/superpowers/specs/2026-11-18-plataforma-funil-mvp-design.md`. Lá, "upsell e downsell
pós-compra" e "sequências de e-mail e disparos" eram **não-objetivos do MVP**. O MVP está no ar, e o dono pediu este
bloco como o próximo do roadmap. Cupom não aparecia no MVP. Os **anti-objetivos** continuam valendo e guiam este
design. Os que mais pesam aqui:
- o dinheiro nunca passa pela plataforma (cada venda nova continua indo para o Asaas da loja);
- a IA/MCP nunca faz o que o usuário dela não poderia, e nunca muda preço sem aprovação;
- **nenhum dado de cartão gravado** (nem token, salvo decisão explícita do dono, ver D17);
- checkout lento ou com muitos campos derruba a conversão de um produto de R$ 9,90.

## 1. Intenção

Aumentar o ticket médio e a recompra da loja sem aumentar o atrito da primeira compra:
1. **Cupom de desconto**, para campanhas (anúncio, orgânico, indicação) e para a oferta da sequência de e-mails.
2. **Upsell e downsell na página de obrigado**: quem acabou de comprar recebe uma oferta complementar com o mínimo de
   cliques (ex.: quem comprou só o Almanaque recebe os 5 kits).
3. **Sequência de e-mails pós-compra** (boas-vindas, conteúdo, oferta) pelo e-mail da própria loja, respeitando o
   descadastro.

## 2. O que o código atual faz (conferido na `main`, `db6158e`)

Pontos que o design usa ou que limitam o design:

- **Pedido.** `createOrder` (`src/lib/orders/create.ts`) recalcula o preço no banco, nunca no navegador. Ele grava
  `subtotal_cents` e `total_cents`, que hoje são iguais e têm check `> 0`, e um `order_item` por produto. O preço de
  cada grupo (principal e bump) é rateado com `splitCents`, e a soma dos itens dá o total. Bump indisponível vira
  `conflict` (`BUMP_UNAVAILABLE`, ruling R4: o comprador nunca paga outro valor nem leva outro combo).
- **Checkout.** `checkout.start` (`src/lib/checkout.ts`) escolhe o método e roda `createOrder` e
  `enqueueInitiateCheckout` na mesma transação. Os limites contam pedidos criados (Asaas: 10 por IP/h e 5 por
  e-mail/h). `startCheckout` cria a cobrança Pix do Asaas fora da transação. No cartão, ele emite o **bilhete**
  (`card-ticket.ts`), que leva `totalCents` e `maxInstallments`.
- **Cartão isolado.** O serviço `card` (`pagar.<domínio>`, papel de banco `card`) lê `orders.total_cents` e cobra
  esse valor (`card.ts:286`). O papel `card` lê só `orders, offer, customer, integration, card_attempt, payment`. Ele
  só pode marcar como pago um pedido `card_asaas` pendente (gatilho `orders_card_guard`) e só enfileira
  `deliver_order`, `meta_event`, `notify_seller` e `notify_telegram` (`sale`/`card_declined`) (`job_card_insert` em
  `rls.sql`). O formulário do iframe pede nome do titular, CPF, CEP, número e os dados do cartão. CEP e número **não
  são guardados** (vão direto ao Asaas).
- **Pix manual.** O valor único é `total + 1..99` centavos, único entre os pendentes da loja **e entre totais
  diferentes**, com quarentena de 48 h (`allocateManualAmount`). Ele é calculado sobre o `total` final, então um
  desconto entra antes da alocação sem mudar nada lá.
- **Pago.** `transitionOrder(...,"paid")` (`orders/state.ts`) enfileira `deliver_order`, `meta_event Purchase`,
  `notify_seller` e o Telegram `sale`. O webhook do Asaas só libera se o valor pago for maior ou igual a `total_cents`.
- **Meta.** O `Purchase` do servidor usa `value: total_cents/100` e `event_id = purchase:<publicId>`. O do navegador
  (`/o/[publicId]/pixel.tsx`) usa o mesmo id e `order.totalCents`. Um pedido novo tem `publicId` novo, então tem um
  `Purchase` próprio e deduplicado.
- **Página do pedido** `/o/<publicId>`: qualquer um com o link a vê. Ela nunca mostra e-mail, CPF nem telefone, só o
  primeiro nome. O `publicId` **não é segredo forte**: vai ao Meta em `event_source_url` e em `order_id`, e aparece em
  e-mails. A página pendente faz polling e vira "obrigado" (`ThankYou`) quando o pedido é pago.
- **E-mail.** `sendMail` usa SMTP ou Resend da loja (`store.email_provider`). `templates.ts` tem `layout`, `esc` e
  `oneLine`. A recuperação (PR #15) já tem `email_optout (store_id, email_hash)`, `mailbox_hash` (caixa canônica: sem
  `+sufixo` e com os pontos do Gmail tirados), `/sair/<token>` com POST de um clique e `List-Unsubscribe`, bounce e
  complaint do Resend virando optout, varredura a cada 5 min com janela de 6 h, limite por caixa (1 a cada 24 h e 3
  em 30 dias) e teto por loja (60 por hora). A página `/sair` fala em "**lembretes**".
- **MCP.** Toda ação registrada vira ferramenta, a menos que esteja em `MCP_EXCLUDED` ou seja pública ou de sistema.
  Uma ação sensível passa pela fila de aprovação. `tests/mcp-tools.test.ts` falha se uma ação nova não tiver decisão.
  Mudança de preço (`offers.updatePrice`) e de texto do checkout (`offers.update`) são sensíveis.
- **Painel.** Pela memória do projeto, um item novo no menu principal quebra o smoke `painel 390` do verify, que só
  muda em PR de verificação. Por isso **nenhum item novo no menu**: cupons ficam dentro de Ofertas e upsell e
  sequência ficam no editor da oferta.
- Próxima migração: **0037**.

## 3. Objetivos, não-objetivos, anti-objetivos deste bloco

**Objetivos**
- Cupom fixo ou percentual, por oferta (ou todas), com validade, limite de usos e limite por comprador, aplicado no
  checkout com Pix e cartão, e com o valor certo no Asaas, no Meta, no painel e no relatório.
- Upsell e downsell de um passo cada, na página de obrigado, que geram um **pedido novo ligado ao primeiro**, sem pedir
  de novo nome, e-mail, celular nem CPF.
- Sequência de até 5 e-mails por oferta, com texto da loja, rodapé e descadastro fixos, só para pedidos pagos depois de
  a sequência ser ligada.

**Não-objetivos (ficam para depois)**
- Cupom automático (sem código), cupom de frete, cupom acumulado (mais de um por pedido), cupom no upsell.
- Funil com mais de um upsell e um downsell em sequência, teste A/B de upsell, upsell antes do pagamento (já é o bump).
- **Cobrança de cartão em um clique** no upsell (exige guardar o token do cartão, ver D17).
- Disparos avulsos ("newsletter") para toda a base, editor visual de e-mail, rastreio de abertura e clique por pixel.
- Importar a base de compradores da Cakto para a sequência.

**Anti-objetivos (falha mesmo que "funcione")**
- O comprador paga um valor diferente do que viu na tela (cupom que muda entre a prévia e o pagamento, upsell com
  preço diferente do botão).
- Um terceiro que tem o link `/o/<publicId>` consegue gerar cobranças no nome do comprador.
- A sequência manda e-mail para quem descadastrou, para quem foi reembolsado ou em massa para compradores antigos ao
  ser ligada.
- O cupom vira ferramenta de fraude: força bruta de códigos, uso ilimitado de um cupom "1 por pessoa", desconto que
  zera o pedido.
- Dado pessoal do comprador sai pelo MCP, pelo Telegram ou por log.

## 4. Decisões

Formato: recomendação (**R**), alternativa e custo da recomendação. Marcadas com ✅ as que o dono confirmou ou ajustou
(seção 6). As demais são decisões do assistente que o dono pode corrigir.

### 4.1 Cupom

| # | Assunto | Recomendação | Alternativa | Custo |
|---|---------|--------------|-------------|-------|
| D1 | Modelo | **R:** tabela `coupon` (código, tipo `percent` ou `fixed`, valor, validade `starts_at`/`ends_at`, `max_uses`, `max_per_email`, `active`, `archived_at`) e `coupon_offer` (lista de ofertas; vazia = todas as ofertas da loja). O código é guardado em maiúsculas, é único por loja e usa `A–Z 0–9 - _` com 3 a 32 caracteres | Cupom como coluna da oferta | Duas tabelas novas. Em troca, um cupom vale para várias ofertas e tem histórico próprio |
| D2 | Pedido | **R:** `orders.coupon_id` e `orders.discount_cents` (padrão 0), com check `total_cents = subtotal_cents - discount_cents`. Os pedidos antigos já cumprem a regra, porque `subtotal = total`. O desconto é rateado nos itens do grupo a que se aplica (`splitCents`), e a soma dos itens continua igual a `total_cents` | Guardar só o total | Uma coluna e um check. Relatório e reembolso continuam lendo `total_cents` |
| D3 ✅ | Cupom e bump | **R:** por padrão o cupom vale **só para o produto principal**. Uma opção do cupom estende o desconto ao bump | Valer sempre para tudo | Na Kids, um "10%" no Almanaque com bump dá R$ 0,99 de desconto, não R$ 2,70 |
| D4 | Piso | **R:** o total com desconto nunca fica abaixo de **R$ 5,00** (`COUPON.minTotalCents`, fixo no código). Um cupom que passaria disso fica limitado ao piso, e o checkout mostra o desconto real. Confirmar no sandbox o mínimo de cobrança do Asaas para Pix e cartão (Task A1) | Sem piso, só `> 0` | Um cupom de 100% não existe (pedido grátis fica fora do escopo) |
| D5 | Contagem de usos | **R:** um uso é um pedido `paid` ou `disputed` com o cupom, mais os pendentes que ainda podem ser pagos: Pix pendente não vencido e cartão pendente criado há menos de 2 h. A conferência roda sob `pg_advisory_xact_lock('coupon:'+id)` dentro do `checkout.start`. `refunded`, `expired` e `declined` não contam | Contador incrementado na criação e devolvido ao expirar | O limite pode ser ultrapassado por poucos usos quando um cartão pendente há mais de 2 h é aprovado. Em troca, não há contador para dessincronizar, e o papel `card` não precisa tocar no cupom |
| D6 ✅ | Limite por comprador | **R:** `max_per_email` padrão 1, contado por **caixa** (`mailboxHash`, como na recuperação), com a mesma regra de "uso" do D5 | Sem limite por pessoa | `a+1@gmail.com` e `a.1@gmail.com` contam como a mesma pessoa. Duas pessoas de verdade não são afetadas |
| D7 | Prévia e garantia de preço | **R:** "Tenho um cupom" fica recolhido no checkout. "Aplicar" chama `checkout.previewCoupon` (público), que devolve o desconto e o total, ou uma mensagem neutra ("Cupom inválido ou vencido") sem dizer qual regra falhou. `checkout.start` recebe `couponCode` e `expectedTotalCents`. Se o total recalculado for diferente, devolve `conflict` com a mensagem "O valor mudou: confira o resumo" e o checkout atualiza o resumo. **Nunca** cria um pedido com um valor que o comprador não viu | Aplicar o cupom só no envio | Uma chamada a mais. Cumpre o anti-objetivo de preço |
| D8 | Força bruta | **R:** `previewCoupon` aceita 20 por IP por hora e 300 por loja por hora (`rate_limit`, chaves `coupon:`). O `checkout.start` com cupom inválido conta no mesmo limite por IP | Sem limite | Quem testa muitos códigos fica sem cupom por 1 h |
| D9 ✅ | Cupom pela URL | **R:** `/c/<slug>?cupom=CODIGO` preenche e aplica o cupom ao abrir a página (para anúncio e e-mail). O código também entra no toque (`touch`) como `cupom` | Só digitado | O código fica visível no link (é o esperado em campanha) |
| D10 | Meta e Telegram | **R:** Meta: `value` continua `total_cents/100` (o valor pago), no `Purchase` e no `InitiateCheckout`. Nenhum parâmetro novo. Telegram: o aviso de venda ganha "Cupom: CODIGO (−R$ X)". O código não é dado pessoal | Mandar o código ao Meta | Nenhum |
| D11 | Painel e MCP | **R:** a página Ofertas ganha uma aba "Cupons" (lista, criar, editar, arquivar), sem item novo no menu. O pedido mostra o cupom e o desconto, e o CSV ganha colunas `cupom` e `desconto`. As ações `coupons.list`/`get` (`offers.read`) e `coupons.create`/`update`/`archive` (`offers.write`, **sensíveis**: mudam preço, então pelo MCP passam pela fila de aprovação). `metrics.summary` ganha `coupons: [{ code, orders, discountCents, revenueCents }]`, só números e códigos | Cupons fora do MCP | Nenhum dado pessoal novo sai |
| D12 | Recuperação | **R:** o lembrete de Pix e de cartão já usa `total_cents` (o valor com desconto). O lembrete de contato continua mostrando o preço da oferta e não leva o cupom | Repassar o cupom no link do lembrete | Quem saiu antes do pedido não ganha o desconto de volta pelo lembrete |

### 4.2 Upsell e downsell pós-compra

| # | Assunto | Recomendação | Alternativa | Custo |
|---|---------|--------------|-------------|-------|
| D13 | O que é vendido | **R:** a oferta de upsell é uma **oferta normal com `visibility = 'post_purchase'`**: tem os próprios produtos e preço, mas `/c/<slug>` devolve 404 para ela (só é vendida depois de uma compra). A oferta de origem ganha até um upsell e um downsell (tabela `post_purchase_offer`: `offer_id`, `kind` `upsell`/`downsell`, `target_offer_id`, título, texto, botões) | Upsell como colunas da oferta; ou vender a oferta pública | Mais uma tabela e um campo. O preço especial do upsell não fica aberto ao público |
| D14 | Pedido do upsell | **R:** um **pedido novo** (`orders.parent_order_id`, `orders.funnel_step` `upsell`/`downsell`, com índice único `(parent_order_id, funnel_step)`). Ele tem entrega, `Purchase` do Meta (com `publicId` próprio e `value` do upsell), aviso de venda e reembolso próprios. Nome, e-mail, celular e CPF vêm do pedido de origem, e nada é pedido de novo. Sem bump e sem cupom | Somar itens ao pedido já pago | Um e-mail de entrega a mais. Em troca, nada muda no pedido pago, no reembolso nem no Asaas |
| D15 | Quem vê a oferta | **R:** só o **navegador que fez a compra**. `startCheckoutAction` grava o cookie `funil_buyer` (httpOnly, `SameSite=Lax`, `Secure`, 2 h) com um HMAC (`SECRET`) dos `publicId` dos pedidos daquele navegador (no máximo 5). A página de obrigado só mostra a oferta e a ação só cria o pedido com esse cookie, e só até **60 min depois do `paid_at`** do pedido de origem | Qualquer um com o link `/o/<publicId>` | Quem abre o obrigado em outro aparelho (ex.: o link do e-mail) não vê o upsell. Cumpre o anti-objetivo de cobrança por terceiros, já que o `publicId` vai ao Meta |
| D16 | Pix | **R:** "Sim, quero" cria o pedido-filho com o mesmo tipo de Pix da oferta de upsell (Asaas: o CPF vem do pedido de origem). A página `/o/<filho>` abre com o QR, e quem pagou o primeiro por Pix paga o segundo do mesmo jeito. No Pix manual (sem CPF), o filho ganha o próprio valor único | Juntar os dois Pix | O comprador abre o app do banco duas vezes |
| D17 ✅ | Cartão | **R (fase 1):** sem guardar nada do cartão, o upsell no cartão **exige digitar o cartão de novo**, porque CEP e número do endereço também não são guardados. A caixa do upsell oferece "Pagar com cartão" e "Pagar com Pix". Com o cartão, o formulário do iframe abre **na própria página de obrigado** (bilhete do pedido-filho). **Fase 2 (só com ok do dono):** cartão em um clique com o token do Asaas (`creditCardToken`), guardado **só na memória do serviço `card`**, por 30 min e por pedido, sem banco, log nem fila. Antes, confirmar com o Asaas que a tokenização está liberada na conta e como ela funciona | Guardar o token no banco, cifrado | Na fase 1, o upsell no cartão converte menos (formulário inteiro de novo). A fase 2 mexe no serviço isolado (escopo PCI) e no CLAUDE.md ("dados de cartão nunca são persistidos"): o token não é PAN, mas a regra do repo precisa de leitura do dono |
| D18 | Downsell | **R:** "Não, obrigado" no upsell registra a recusa e mostra o downsell (se houver), na mesma página e com a mesma regra. "Não, obrigado" no downsell fecha a caixa. As decisões ficam em `post_purchase_decision (order_id, kind, decision, at)` e servem para as métricas e para não mostrar de novo | Downsell em outra página | Nenhum |
| D19 | Quando não oferecer | **R:** não mostra a oferta se o comprador já tem **todos** os produtos dela, contando os pedidos `paid` da mesma caixa nos últimos 365 dias e o próprio pedido (ex.: quem levou o bump não vê "5 kits"). Também não mostra no pedido-filho (sem upsell de upsell), nem com a oferta-alvo inativa ou com produto apagado | Mostrar sempre | Uma consulta a mais no obrigado |
| D20 | Métricas e MCP | **R:** `metrics.summary` ganha `postPurchase: { shown, accepted, paid, revenueCents, byKind }`. `orders.paidReport` ganha `funnelStep`. As ações novas: `postPurchase.get` (`offers.read`) e `postPurchase.set` (`offers.write`, **sensível**: texto e preço aparecem ao comprador). As ações públicas (`checkout.acceptPostPurchase`, `checkout.declinePostPurchase`) ficam fora do MCP, como `checkout.start` | Nada no MCP | Nenhum dado pessoal novo sai |

### 4.3 Sequência de e-mails pós-compra

| # | Assunto | Recomendação | Alternativa | Custo |
|---|---------|--------------|-------------|-------|
| D21 | Modelo | **R:** por oferta, até **5 passos** (`email_sequence_step`: posição, atraso em horas desde o `paid_at`, assunto, corpo em texto simples, botão opcional (rótulo + URL `https`), "não mandar a quem já tem os produtos da oferta X" (`skip_if_has_offer_id`: conta os **produtos** dos pedidos pagos da caixa, como no D19; assim quem levou o bump também não recebe a oferta dos kits), `active`, `activated_at`). Cada envio é uma linha `sequence_email` (como `recovery_email`: só hashes, status, `unsub_hash`, retenção de 90 dias), única por `(order_id, step_id)` | Sequência por loja, igual para todas as ofertas | Configurar oferta a oferta. A Kids tem duas ofertas e um upsell |
| D22 ✅ | Boas-vindas | **R:** o e-mail de entrega (que já sai quando o pedido é pago) **é** a boas-vindas. A sequência começa no **1º dia**. **Dono (23/11):** na oferta Almanaque, D+1 "como usar o Almanaque com as crianças", D+3 "uma atividade pronta" e D+5 "os 5 kits com o KIDS10", este só para quem ainda não tem os kits. O assistente redige e o dono aprova. O botão do D+5 precisa de uma oferta **pública** só dos kits (ex.: `/c/kits`, R$ 17,10, que o dono cadastra no painel; a oferta `post_purchase` do upsell não abre em `/c/`) | Um passo "boas-vindas" separado, 1 h depois | Uma oferta pública a mais na loja |
| D23 | Texto | **R:** editável pela loja. O texto é simples: parágrafos, sem HTML, e `{nome}` vira o primeiro nome do pedido. O valor passa por `esc` e `oneLine`. Rodapé, descadastro, `List-Unsubscribe` e layout são fixos. Uma prévia no painel usa dados de exemplo (nunca um comprador real) e um botão manda o teste para o e-mail do usuário logado | Texto fixo, como na recuperação | Precisa de escape e prévia. Em troca, a loja escreve o próprio conteúdo |
| D24 | Disparo | **R:** a varredura `sequence_scan` (a cada 5 min, junto com a `recovery_scan`) escolhe pedidos `paid` com `paid_at + atraso <= agora`, **`paid_at >= activated_at` do passo** e devidos há no máximo 24 h. O `sequence_send` confere tudo de novo antes de mandar (como o `recovery_send`) | Agendar os jobs no pagamento | Ligar a sequência **nunca** manda e-mail para compradores antigos. Com o worker parado mais de 24 h, os passos atrasados viram `skipped atrasado` |
| D25 | Quando não mandar | **R:** pula (linha `skipped` com o motivo) se: o pedido não está mais `paid` (reembolso ou contestação **encerra** a sequência); a caixa está em `email_optout`; o endereço não é simples; o comprador já tem todos os produtos da oferta de `skip_if_has_offer_id`; ou o mesmo passo já saiu para a mesma caixa por outro pedido | — | Nenhum |
| D26 ✅ | Descadastro | **R:** **um descadastro por loja**, que vale para os lembretes e para a sequência (`email_optout` como já existe). A página `/sair` passa a dizer "Não quer mais receber e-mails da {loja} (lembretes e novidades)?". O e-mail de entrega (transacional) **sempre** sai | Descadastro separado por tipo | Quem descadastra da sequência também deixa de receber lembretes de recuperação (é o esperado) |
| D27 ✅ | Limites | **Dono (23/11): o Resend da Moradah está no plano gratuito.** Essa cota (100 e-mails por dia e 3.000 por mês, a conferir no painel do Resend) é dividida com os e-mails de **entrega**, que não podem faltar. **R:** (1) por caixa, no máximo **1 e-mail de sequência a cada 20 h**, contado à parte da recuperação; (2) **teto diário da sequência por loja**, configurável, com padrão de **30 por dia** e **10 por hora**; (3) **reserva da entrega**: a varredura não enfileira sequência quando o `email_log` da loja nas últimas 24 h passar de **60** (sobram 40 para entrega, recuperação e avisos). O excedente fica para as próximas varreduras, dentro da janela de 24 h do D24, e depois disso vira `skipped cota`. O painel mostra "Plano gratuito do Resend: a sequência pode atrasar ou pular e-mails acima de ~25 vendas por dia" | Sem teto próprio (100 por hora) | Com mais de ~25 vendas por dia (cada venda gera 1 entrega + 3 da sequência), parte da sequência é pulada. **Quando as vendas passarem disso, o plano pago do Resend vira pré-requisito**, e os tetos sobem no painel |
| D28 | Link e atribuição | **R:** um botão com URL do domínio da loja recebe `utm_source=sequencia&utm_medium=email&utm_campaign=<oferta>-<passo>`. Uma URL externa sai como está. "Venda da sequência" = um pedido pago com `utm_source=sequencia` no último toque | Rastrear clique com redirecionador | Sem contagem de clique. Em troca, nenhum redirecionador aberto |
| D29 ✅ | LGPD | **R:** com alguma sequência ativa na oferta, o checkout mostra uma linha curta abaixo do botão de pagar: "Depois da compra você pode receber e-mails da {loja} sobre o produto; para sair, é só clicar no link do e-mail." O aviso de captura de contato do PR #14 só aparece com a captura ligada, e na Kids ela está desligada, por isso a linha fica separada dele. Base: legítimo interesse (cliente existente, assunto relacionado, saída de um clique). **Passar pelo jurídico antes de ligar em produção**, junto com o aviso do PR #14 | Caixa de consentimento no checkout | Mais um texto para o jurídico. A caixa de consentimento custa conversão |
| D30 | Falha no envio | **R:** igual à recuperação (D14 do PR #15): provedor ausente ou recusado → `failed` sem nova tentativa; erro temporário → a fila tenta de novo até 2 h depois do `due_at` | — | — |
| D31 | Painel e MCP | **R:** o editor da oferta ganha a seção "E-mails depois da compra". `metrics.summary` ganha `sequence: { sent, skipped, salesFromSequence, revenueCents }`. As ações `sequences.get` (`offers.read`), `sequences.save` (`offers.write`, **sensível**: manda e-mail aos compradores) e `sequences.sendTest` (`offers.write`, fora do MCP, porque manda e-mail para o usuário do painel). Nada sobre quem recebeu | Lista de envios por comprador | Nenhum dado pessoal sai |

### 4.4 Decidido sem escolha (regra do dono, do spec ou do repo)

- Dinheiro em centavos inteiros e reais só na borda (Asaas, Meta).
- Tabelas novas com `store_id` + `select enable_store_rls('<tabela>')`, e FKs compostas `(store_id, id)` quando
  apontam para oferta ou produto (padrão de `offer_product`). O papel `card` **não ganha permissão nova** na fase 1
  (lê `orders`, que ganha colunas: `coupon_id`, `discount_cents`, `parent_order_id`, `funnel_step`).
  `tests/card-role.test.ts` confere que ele não lê `coupon`, `post_purchase_*` nem `sequence_*`.
- Rotas e páginas só chamam `runAction`. Toda ação nova tem decisão no catálogo MCP (`tests/mcp-tools.test.ts`).
- Nenhum dado pessoal no MCP, no Telegram nem em log. Os logs levam ids, o código do cupom e o motivo.
- Não usar API exclusiva do Bun em `src/`. Telas seguem `docs/padrao-de-paginas.md`.
- E2E de cada parte vai em **PR de verificação separado** (regra do repo).

## 5. Ordem de entrega, custo e risco

| Ordem | PR | Depende de | Tamanho (estimativa) | Risco | Por quê nesta ordem |
|-------|----|-----------|----------------------|-------|----------------------|
| 1 | **A. Cupom** (migração 0037) | — | 6 tasks, ~1 dia de agente + revisão | **Médio**: mexe no cálculo do preço (`createOrder`, `checkout.start`, formulário). Mitigado por `expectedTotalCents` e pelos testes de soma dos itens | É o mais contido, serve sozinho para campanhas e é usado pela oferta da sequência (C) |
| 1v | Verificação A (E2E) | A | 1 task | Baixo | Regra do repo |
| 2 | **B1. Upsell/downsell com Pix** (migração 0038) | — (independente de A) | 7 tasks, ~1,5 dia | **Alto**: caminho novo de criação de pedido fora do checkout, cookie de comprador, página de obrigado que vende. Mitigado pelo D15, pela janela de 60 min e pelo único por passo | É a maior alavanca de ticket. O Pix cobre a loja inteira (todo comprador tem CPF no pedido) |
| 3 | **B2. Upsell no cartão (iframe no obrigado)** | B1 | 3 tasks, ~1 dia | **Médio-alto**: reaproveita `card-frame.ts` numa segunda página. O `/o/` já tem a CSP do comprador com `frame-src` do cartão (`src/proxy.ts`) e já é conferido pelo `pci_page_monitor`. Mesmo assim, a página do obrigado passa a ser uma página onde se digita cartão: o inventário de `docs/seguranca-pagamento.md` precisa ser atualizado | Separado para B1 entrar antes e para isolar a revisão do cartão |
| 2v/3v | Verificação B (E2E) | B1, B2 | 1–2 tasks | Baixo | — |
| 4 | **C. Sequência pós-compra** (migração 0039) | A (para a oferta com cupom; funciona sem) | 7 tasks, ~1,5 dia | **Médio**: spam e LGPD (D24–D29), cota do Resend. **Só liga em produção depois do jurídico** | Rende ao longo do tempo. O texto depende do dono e do jurídico |
| 4v | Verificação C (E2E) | C | 1 task | Baixo | — |
| (5) | B3. Cartão em um clique (token na memória do `card`) | B2 + ok do dono + confirmação do Asaas | a estimar | **Alto** (escopo PCI) | Só se a conversão do B2 justificar |

Os PRs saem um por vez, cada um com `/verify`. Push e PR só com o ok do dono. Os rulings com custo vão no corpo do PR.

## 6. Respostas do dono (23/11/2026)

| # | Pergunta | Resposta |
|---|----------|----------|
| 1 | Cupom e bump (D3) | **Só no principal.** O bump fica com preço fixo. A opção `applies_to = 'all'` continua existindo no cupom |
| 2 | Limite por pessoa (D6) | **1 por pessoa** como padrão de todo cupom, contado por caixa e ajustável por cupom |
| 3 | Cupom na URL e cupom inicial (D9) | **Sim**, `?cupom=`. Cupom inicial **KIDS10**: 10% no Almanaque, no Completo e na oferta pública dos kits, por 30 dias, 1 por pessoa. O dono cria no painel depois do PR A (é dado, não código) |
| 4 | Ordem | **A → B1 → B2 → C** |
| 5 | Preço do upsell (D13) | **5 Kits Extras por R$ 17,10** (igual ao bump), para quem comprou só o Almanaque |
| 6 | Downsell | **5 kits por R$ 12,90** (uma segunda oferta `post_purchase`) |
| 7 | Cartão (D17) | **Fase 1** (formulário de novo no obrigado, com a opção de pagar por Pix). Em paralelo, o assistente levanta com o Asaas a tokenização para o dono decidir o B3 com dados de conversão |
| 8 | Textos do upsell | **O assistente redige e o dono aprova.** Os textos vão no corpo do PR B1 como proposta e são editáveis no painel |
| 9 | Sequência (D22) | **D+1, D+3 e D+5 com oferta**, textos redigidos pelo assistente e aprovados pelo dono |
| 10 | Descadastro (D26) | **Único para a loja** |
| 11 | Resend (D27) | **Plano gratuito**: o D27 ganhou teto diário e reserva para a entrega |
| 12 | Jurídico (D29) | **Junto com o pacote do PR #14.** A sequência fica pronta no código e desligada até o ok |

**Configuração na loja depois dos merges** (dados, feitos pelo dono no painel ou pelo MCP com aprovação; nada disso é código):
- PR A: cupom KIDS10.
- PR B1: oferta `post_purchase` "5 Kits Extras" R$ 17,10 (upsell) e outra a R$ 12,90 (downsell), ligadas à oferta `/c/almanaque`. O Completo não ganha upsell, porque quem o compra já tem tudo.
- PR C: oferta pública `/c/kits` R$ 17,10 (para o botão do D+5) e os 3 passos na oferta Almanaque, desligados até o jurídico.

### Pendências ainda abertas
- Conferir no sandbox o valor mínimo de cobrança do Asaas (piso do cupom, D4).
- Conferir no painel do Resend a cota real do plano gratuito (D27).
- Tokenização do cartão no Asaas (insumo para o B3).
