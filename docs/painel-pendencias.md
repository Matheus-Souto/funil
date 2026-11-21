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
