# Painel: pendências no servidor

O redesenho do painel (tema claro/escuro, Arc UI, gráficos em ECharts) foi feito só na interface. Alguns pontos
funcionam hoje com o que o servidor já entrega, mas ficariam melhores com um ajuste nas ações. Ficam anotados aqui.

## 1. Vendas por oferta, dia a dia (mini gráfico da página Ofertas)

**Hoje:** `src/app/admin/(panel)/offers/page.tsx` chama `metricsBreakdown` uma vez por dia dos últimos 7 dias
(7 chamadas, cada uma com as consultas de `byOffer`) só para montar o mini gráfico de cada oferta.

**Sugestão:** `metricsBreakdown` devolver também a série diária por oferta, numa consulta só, por exemplo:

```ts
byOfferDay: Array<{ offerId: string; day: string /* YYYY-MM-DD, São Paulo */; paid: number; revenueCents: number }>
```

agrupando `orders` pagos por `offer_id` e `to_char(paid_at at time zone 'America/Sao_Paulo', 'YYYY-MM-DD')`, no
mesmo estilo de `byDay`. Depois é só trocar o `Promise.all` da página por essa lista.

## 2. Foto/ícone da loja (sidebar)

**Hoje:** a caixa da loja na sidebar mostra a inicial do nome (`src/app/admin/(panel)/sidebar.tsx`, `storeMark`),
com espaço reservado para uma imagem.

**Sugestão:** um campo de logo na loja (coluna em `store`, com migração), envio da imagem em Configurações
(validar tipo e tamanho, guardar no storage como os PDFs) e `getPanelIdentity` devolver a URL. A sidebar já tem o
estilo para `<img>` dentro de `.storeMark`.

## 3. Conversão do checkout por dia (opcional)

**Hoje:** o cartão "Conversão do checkout" mostra o funil do período (visitas → pedidos → pagos).

**Sugestão (se quiserem ver a tendência):** `metricsBreakdown` devolver visitas, pedidos e pagos por dia
(`checkout_view.at`, `orders.created_at`, `orders.paid_at`), para um gráfico de linha da taxa de conversão diária.

## 4. Ordenar a tabela de pedidos pelas colunas (opcional)

**Hoje:** os cabeçalhos de Status e Método filtram (vários valores, `statuses`/`methods` em `listOrders`); a ordem é
sempre a mais recente primeiro.

**Sugestão:** um parâmetro `sort` em `listOrders` (ex.: `createdAt`, `total`, com `asc`/`desc`) para os cabeçalhos
ganharem a seta de ordenar.

## 5. Observado no E2E: conexão reaproveitada no teste do reembolso

Numa rodada do `verify` (21/11/2026), o teste "entrega por e-mail … reembolso revoga" (e2e/smoke.spec.ts, linha do
`expect.poll` que espera o 410) falhou com `read ECONNRESET` no `request.get` do link de download. O app tinha
revogado os links certo (log "links de download revogados"); a rodada seguinte, sem mudança, passou.

Causa provável: o `request` do Playwright reaproveita uma conexão keep-alive que o servidor (`next start`) fechou por
inatividade (~5 s parado durante o diálogo de reembolso). Uma correção possível é fazer essa checagem num contexto de
requisição novo (`playwright.request.newContext()`) ou com `Connection: close`, em vez de repetir o teste.

## 6. Número de páginas dos PDFs (página Produtos)

**Hoje:** para mostrar "N páginas" embaixo do nome, a tabela de produtos baixa o PDF inteiro de cada linha visível
(rota `GET /admin/api/products/<id>/file`, ação `products.file`) e conta as páginas no navegador com pdf.js. Para PDFs
grandes isso pesa.

**Sugestão:** guardar o número de páginas na tabela `product` no upload (o servidor já abre o PDF com pdf-lib para
validar) e devolver em `listProducts`; a tabela deixa de baixar o arquivo e só o visualizador "Ver PDF" lê o PDF.
