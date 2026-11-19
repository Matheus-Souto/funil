# Migração da Cakto

Roteiro do dono para trocar a Cakto por este checkout (spec §7.11). Como a entrega é só por e-mail, não há alunos nem
área de membros para migrar: os compradores antigos continuam com os PDFs que já receberam.

Pré-requisito: instalação no ar (`docs/instalacao.md`), com `https://checkout.<seu-domínio>/api/health` respondendo.

## 1. Montar a loja

- [ ] Cadastrar os produtos (**Produtos**: nome + PDF de cada um).
- [ ] Criar as ofertas com os mesmos preços da Cakto (**Ofertas**), escolhendo Pix (manual ou Asaas) e cartão.
- [ ] Configurar o order bump nas ofertas que tinham bump na Cakto (produto, preço do acréscimo, título da caixa).
- [ ] Revisar a mensagem do obrigado e a cor da marca (**Configurações**).

## 2. Conectar

- [ ] **Asaas** em produção, com a URL e o token do webhook colados no Asaas e os eventos marcados
      (`docs/instalacao.md`, seção 6).
- [ ] **Pix manual** (sua chave Pix), se for usar.
- [ ] **E-mail (SMTP)** testado e salvo (seção 7).
- [ ] **Meta** com o **mesmo Pixel ID** usado na Cakto (não crie pixel novo: o aprendizado das campanhas fica no
      pixel), token da API de Conversões e, durante os testes, o código de teste (seção 8).
- [ ] **Desligar a "Correspondência avançada automática"** do pixel no Gerenciador de Eventos (seção 8, item 4).
- [ ] Colar o `t.js` na página de vendas da Cloudflare, ainda sem trocar os links (seção 9).

## 3. Compras de teste (com dinheiro de verdade, valores baixos)

Crie uma oferta de teste de valor baixo (ex.: R$ 5,00) apontando para um produto real e faça, num celular:

- [ ] **Pix manual real**: pague o valor único mostrado, confira no extrato do banco e libere pelo painel.
- [ ] **Pix pelo Asaas**: pague e confira que o pedido vira pago sozinho (sem você liberar).
- [ ] **Cartão pelo Asaas**: uma compra aprovada.

Em cada compra confira:

- [ ] o e-mail chegou (veja também a caixa de spam), com o link de download;
- [ ] o PDF baixado vem com o carimbo do comprador;
- [ ] no Gerenciador de Eventos do Meta, aba **Testar eventos**: InitiateCheckout e Purchase aparecem, com o evento
      do navegador e o do servidor deduplicados (mesmo `event_id`);
- [ ] o pedido aparece no painel com a origem (UTM) certa, se você entrou pela página de vendas com `?utm_source=`.

Depois: reembolse os testes pelo painel (Asaas devolve sozinho; no Pix manual, devolva pelo banco) e **apague o código
de teste do Meta** em Conexões.

## 4. Virar a chave

- [ ] Trocar os links dos botões da página de vendas para `https://checkout.<seu-domínio>/c/<endereço-da-oferta>` e
      publicar.
- [ ] Trocar os links dos anúncios que apontam direto para o checkout da Cakto.
- [ ] Fazer mais uma compra pela página de vendas publicada (pelo celular, entrando por um anúncio ou link com UTM).

## 5. Depois da troca

- [ ] **Manter a Cakto ligada por alguns dias**: Pix e boletos gerados antes da troca ainda podem ser pagos lá, e
      reembolsos de compras antigas são feitos pela Cakto.
- [ ] Acompanhar no painel os pedidos e os avisos (e-mail que falhou, webhook do Asaas pausado).
- [ ] Desligar a Cakto quando não houver mais pedidos em andamento.
- [ ] Opcional, pode ficar para depois: importar a lista de compradores antigos da Cakto (CSV).
