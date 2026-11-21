# Painel: pendências no servidor

O redesenho do painel (tema claro/escuro, Arc UI, gráficos em ECharts) foi feito quase todo na interface. Alguns pontos
funcionam hoje com o que o servidor já entrega, mas ficariam melhores com um ajuste nas ações. Ficam anotados aqui.

Já resolvidos no PR do redesenho: vendas por oferta e dia numa consulta só (`metricsBreakdown.byOfferDay`, mini gráfico
de Ofertas) e o número de páginas dos produtos (`product.page_count`, gravado no envio; os antigos são preenchidos
pelo job `backfill_page_count`, uma vez a cada subida do app).

## 1. Foto/ícone da loja (sidebar)

**Hoje:** a caixa da loja na sidebar mostra a inicial do nome (`src/app/admin/(panel)/sidebar.tsx`, `storeMark`),
com espaço reservado para uma imagem.

**Sugestão:** um campo de logo na loja (coluna em `store`, com migração), envio da imagem em Configurações
(validar tipo e tamanho, guardar no storage como os PDFs) e `getPanelIdentity` devolver a URL. A sidebar já tem o
estilo para `<img>` dentro de `.storeMark`.

## 2. Conversão do checkout por dia (opcional)

**Hoje:** o cartão "Conversão do checkout" mostra o funil do período (visitas → pedidos → pagos).

**Sugestão (se quiserem ver a tendência):** `metricsBreakdown` devolver visitas, pedidos e pagos por dia
(`checkout_view.at`, `orders.created_at`, `orders.paid_at`), para um gráfico de linha da taxa de conversão diária.

## 3. Ordenar a tabela de pedidos pelas colunas (opcional)

**Hoje:** os cabeçalhos de Status e Método filtram (vários valores, `statuses`/`methods` em `listOrders`); a ordem é
sempre a mais recente primeiro.

**Sugestão:** um parâmetro `sort` em `listOrders` (ex.: `createdAt`, `total`, com `asc`/`desc`) para os cabeçalhos
ganharem a seta de ordenar.

## 4. Observado no E2E: conexão reaproveitada no teste do reembolso

Numa rodada do `verify` (21/11/2026), o teste "entrega por e-mail … reembolso revoga" (e2e/smoke.spec.ts, linha do
`expect.poll` que espera o 410) falhou com `read ECONNRESET` no `request.get` do link de download. O app tinha
revogado os links certo (log "links de download revogados"); a rodada seguinte, sem mudança, passou.

Causa provável: o `request` do Playwright reaproveita uma conexão keep-alive que o servidor (`next start`) fechou por
inatividade (~5 s parado durante o diálogo de reembolso). Uma correção possível é fazer essa checagem num contexto de
requisição novo (`playwright.request.newContext()`) ou com `Connection: close`, em vez de repetir o teste.
