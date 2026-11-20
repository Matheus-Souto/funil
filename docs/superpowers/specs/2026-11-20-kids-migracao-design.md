# Migração do Almanaque Kids: oferta com N produtos, Resend, Telegram e MCP

Data: 20/11/2026. Escopo e ordem dos PRs aprovados pelo dono.

## Por que

O Almanaque Bíblico Kids vende hoje pela Cakto e precisa sair dela. O catálogo que precisa rodar no funil é este:

- **Almanaque Bíblico Kids:** R$ 9,90, um PDF.
- **Order bump no checkout do Almanaque, "5 Kits Extras":** R$ 17,10. São 5 PDFs separados: pack de jogos, datas especiais (com o kit de Natal), cartões de versículos, diário de oração e escola dominical.
- **Completo:** R$ 27, com o Almanaque e os 5 kits, ou seja, 6 PDFs. Tem checkout próprio.
- Os kits não são vendidos avulsos.
- Entrega por e-mail, com um link para cada PDF.

### O que bloqueia ou falta hoje

1. **Oferta e bump com um único produto (bloqueia a migração).** Hoje uma oferta aponta para um único produto, e o bump também. O Completo não cabe nesse modelo, e juntar PDFs num arquivo só não serve: o teto é de 50 MB por PDF e o carimbo roda num container de 768 MB.
2. **E-mail pelo Resend.** O Kids já usa o Resend e quer continuar com ele, no modelo "traga o seu".
3. **Pedidos acessíveis a agentes.** O bot de dados do Kids precisa ler pedidos sem dado pessoal. O dono quer também **configurar tudo** pelo MCP, porque este é o começo da camada AI-native da spec do MVP.
4. **Aviso de venda no Telegram.** A equipe recebe cada venda num grupo do Telegram.

## O que já existe e muda pouco

- O pedido já guarda vários itens (`order_item`, um por produto, `kind` = `main` ou `bump`, preço em centavos).
- A entrega já cria um `download_link` por item, com validade, limite de downloads e carimbo próprios. O e-mail de entrega já lista os itens.
- O reembolso revoga os links do pedido inteiro.
- O painel e o CSV leem os itens.

Na prática, o item 1 muda:
- o modelo da oferta;
- a criação do pedido (rateio);
- o editor de oferta;
- a exibição do painel e do CSV;
- os `content_ids` do Pixel e da CAPI.

## Objetivos

### 1. Oferta e bump com N produtos

- A oferta tem uma lista ordenada de **produtos principais**, com pelo menos 1. O bump tem uma lista ordenada própria, com 0 ou mais produtos e o preço do bump.
- O mesmo produto não aparece duas vezes na oferta, nem somando principal e bump.
- **Rateio em centavos:** o preço da oferta é dividido igualmente entre os itens principais, e o preço do bump entre os itens do bump. A sobra da divisão inteira vai para o primeiro item do grupo.
  - Exemplos: 2.700 em 6 itens dá 450 cada; 1.710 em 5 dá 342 cada; 1.000 em 3 dá 334, 333 e 333.
  - A soma dos itens é sempre igual ao total do pedido. Um teste de propriedade garante isso.
- **Entrega:** um `download_link` por produto, com validade, limite e carimbo próprios. O e-mail lista um link por produto, na ordem da oferta.
- **Reembolso:** revoga todos os links. Hoje isso já acontece; um teste garante com N itens.
- **O que o comprador vê (decidido pelo dono):**
  - o checkout mostra o nome da oferta e, embaixo, "Inclui:" com a lista dos PDFs;
  - o cartão do bump mostra o rótulo escrito pelo vendedor (ex.: "5 Kits Extras");
  - o e-mail de entrega lista um link por PDF, **sem preço por item**, só com o total do pedido.

  O rateio é interno: serve aos relatórios e a fazer a soma bater. O comprador nunca vê preço rateado.

  ```
  Completo — R$ 27,00
  Inclui: Almanaque Bíblico Kids · Pack de jogos · Datas especiais ·
          Cartões de versículos · Diário de oração · Escola dominical
  ```
- **Painel:**
  - o detalhe do pedido lista os itens;
  - o CSV não ganha coluna nova: a coluna `produto(s)`, com os nomes unidos por " + ", passa a listar todos os PDFs;
  - o editor de oferta permite escolher N produtos principais e N do bump, mantendo o caso de 1 produto simples, como hoje.
- **Mudar os produtos de uma oferta é ação sensível**, porque muda o que é entregue, como mudar o preço.
- **Pixel e CAPI:** `content_ids` com todos os produtos do pedido. A CAPI já faz isso; falta conferir o Pixel do navegador. `value` continua sendo o total.
- **Migração:** as ofertas existentes viram o formato novo sem mudar o que vendem, ou seja, 1 principal e 0 ou 1 no bump. Pedidos antigos não mudam.
- **Compatibilidade:** o editor e o fluxo atual com 1 produto continuam funcionando, e o E2E atual passa sem mudança.

### 2. Resend

- Novo tipo de conexão de e-mail `resend`: chave de API e remetente (`Nome <email@dominio-verificado>`). A loja escolhe entre SMTP e Resend como provedor ativo.
- O envio é pela **API** do Resend (`POST https://api.resend.com/emails`), não pelo SMTP dele. O id da mensagem fica gravado no `email_log`.
- **Webhook de status:**
  - rota pública por loja;
  - assinatura conferida no padrão do Resend (Svix: `svix-id`, `svix-timestamp`, `svix-signature`, com o segredo `whsec_…` da loja);
  - os eventos entregue, devolvido (`bounced`) e marcado como spam (`complained`) são gravados no `email_log`;
  - devolvido ou spam entram no aviso "e-mail que falhou" que já existe.
  - **Desistência:** se o webhook complicar, entra só o envio. O dono aceitou o webhook "se der sem complicar".
- **Botão Testar:** como no SMTP, envia um e-mail de teste ao próprio vendedor.
- **Segredos:** a chave e o segredo do webhook ficam cifrados, como as outras conexões, e não podem ser abertos pelo papel `card`. Nunca aparecem em log. O navegador recebe só os últimos 4 caracteres, como no Asaas.
- **A plataforma não fornece Resend.** Cada loja traz a sua conta.

### 3. Telegram

- Conexão por loja: token do bot (secreto) e chat id. Tem botão Testar.
- A cada pedido pago, um job envia ao chat uma mensagem com **só** oferta, valor e forma de pagamento. Não vão nome, e-mail, CPF nem telefone do comprador.
  - Exemplo: "Venda: Almanaque + 5 Kits — R$ 27,00 — Pix".
- **Falha:** o job tenta de novo, como os outros. Uma falha definitiva, como token inválido ou chat inexistente, vira aviso no painel uma vez.
- **Outros eventos (pedido do dono, 20/11):** além da venda aprovada, a loja pode receber "Pix gerado", "Cartão recusado" e "Carrinho abandonado".
  - Uma caixa por evento no cartão do Telegram; só "Venda aprovada" vem ligada.
  - **Abandono, nesta etapa:** pedido que continua sem pagamento depois de um prazo configurável (padrão 30 minutos), seja Pix gerado e não pago, seja cartão recusado sem nova tentativa aprovada. Não conta se o mesmo comprador já pagou outro pedido da mesma oferta depois.
  - **Abandono antes de comprar** (capturar o contato quando a pessoa preenche o checkout, antes de clicar) fica para um PR seguinte, com aviso de privacidade.
  - Nenhuma mensagem leva dado do comprador. As mensagens dos eventos novos levam o código do pedido, para a equipe abrir o pedido no painel.
- **Rede:** o destino é fixo (`api.telegram.org`), então não há risco de SSRF por configuração.

### 4. MCP: ler e configurar tudo

- **Token por loja:**
  - criado no painel por quem tem `team.manage`;
  - tem nome e está ligado a um papel: dono, admin, suporte, tráfego ou o novo **leitor**;
  - é mostrado uma vez só, guardado como hash, com data de último uso, e pode ser revogado.
- **Endpoint MCP:** HTTP no app, com `Authorization: Bearer <token>`. As ferramentas são as ações da camada `runAction` que o papel do token pode usar. Origem `mcp` na auditoria, sempre com o token que agiu.
- **Nenhum dado pessoal do comprador sai pelo MCP, em nenhum papel (decidido pelo dono).** Tudo o que uma ferramenta devolve vai para o provedor do modelo do agente (LGPD).
  - Pelo MCP, as ações de pedido devolvem nome, e-mail, telefone e CPF mascarados (ex.: `m***@gmail.com`).
  - A busca por e-mail não é exposta.
  - `orders.export` (CSV) fica fora do MCP.
  - Consultas sobre um comprador específico continuam no painel.
- **Papel "leitor":** só leitura de produtos, ofertas, métricas e da ferramenta nova de pedidos.
- **Ferramenta nova `orders.paidReport`:** pedidos pagos num período, por dia, com:
  - oferta, itens, valor, forma de pagamento;
  - UTM de primeiro e último toque;
  - ref de indicação.

  Não traz nome, e-mail, CPF nem telefone. Usa paginação. Pode ser chamada por qualquer papel com `metrics.read` ou `orders.read`.
- **Cobertura:** todas as ações do painel ficam disponíveis pelo MCP, cada uma com descrição em português e schema de entrada.
- **Ações sensíveis:** não executam direto, conforme a spec do MVP. Viram uma **solicitação pendente**:
  - o painel mostra quem pediu (token), a ação, os dados resumidos (segredos mascarados) e a data;
  - quem tem a permissão da ação aprova ou recusa;
  - aprovada, a ação roda com a auditoria marcando origem `mcp` e quem aprovou;
  - a solicitação expira em 7 dias;
  - o agente consulta o estado pela ferramenta `approvals.status`.
- **Matriz de ações sensíveis:** revisada antes de ligar o MCP (pendência M6 da fase 1). Vale a marcação do código:
  - `orders.refund`, `orders.release`;
  - `connections.saveAsaas`, `connections.saveSmtp`, `connections.saveMeta`, `connections.savePixManual`;
  - `products.delete`;
  - `offers.setPixel`, `offers.updatePrice`;
  - `store.updateSettings`;
  - `account.changePassword`, `team.revokeSessions`.

  Entram também as conexões novas (Resend e Telegram), a edição dos produtos de uma oferta (`offers.setProducts`), a
  troca do endereço de uma oferta (`offers.setSlug`: trocar slugs entre ofertas mudaria o que o link dos anúncios vende)
  e a gestão de tokens. O PR 5 expõe só as ações não sensíveis por essa marcação.
- **Upload de PDF pelo MCP:**
  - a ferramenta `products.createUploadLink` recebe o nome do produto e do arquivo e devolve uma URL de upload de **uso único**, válida por 15 minutos e presa à loja;
  - o agente faz `PUT` do PDF nela;
  - o produto **só passa a existir quando o arquivo chega**, depois das mesmas validações do painel (PDF, teto de 50 MB);
  - o arquivo nunca passa pela conversa;
  - trocar o PDF de um produto que já existe fica fora, porque o painel também não faz isso.
- **Segredos pelo MCP:** salvar uma conexão aceita a chave pelo MCP. Como é ação sensível, sempre passa pela aprovação. A chave nunca volta em resposta e aparece mascarada na fila.

## Fora do escopo (próximos passos, só com o ok do dono)

- Cupom de desconto.
- Upsell ou downsell depois da compra.
- Sequência de e-mails para quem comprou.
- Kits avulsos. Hoje não são vendidos, e nada aqui impede vender depois como oferta de 1 produto.
- Deploy de produção e troca dos links da landing. É outra etapa, que depende do dono: servidor, DNS e chave de produção do Asaas.

## O que seria fracasso mesmo funcionando

- Um pedido pago com um produto faltando na entrega, ou a soma dos itens diferente do total. O Moradah já teve um bug de combo que gravou só o Almanaque.
- Dado pessoal do comprador saindo pelo Telegram, pelo MCP do papel leitor ou por log.
- Uma chave (Resend, Telegram, token MCP) que volta inteira ao navegador, aparece em log ou vai para a auditoria.
- Uma ação sensível executada pelo MCP sem aprovação.
- Quebrar ofertas e pedidos existentes ao migrar.

## Abordagens consideradas

- **Leitura de pedidos para agentes:**
  - (a) MCP com token por papel. **Escolhida**, e ampliada pelo dono para configurar tudo.
  - (b) Endpoint REST com token. Seria mantido em paralelo ao MCP depois.
- **Vários produtos por oferta:**
  - **Escolhida:** tabela de itens da oferta, com produto, grupo (principal ou bump) e posição.
  - Descartada: um array de ids na própria oferta. Perde a integridade referencial e o RLS por linha.
  - Descartada: juntar PDFs num arquivo só. O teto de 50 MB e a memória do carimbo inviabilizam.
- **Rateio:**
  - **Escolhido:** divisão igual com a sobra no primeiro item.
  - Descartado: preço por produto definido pelo vendedor. Mais flexível, mas complica o editor sem necessidade hoje.

## Ordem de entrega (PRs)

1. **Produto: oferta e bump com N produtos.** Inclui migração, rateio, editor, painel, CSV e Pixel/CAPI, com testes unitários e de integração. O E2E atual passa sem mudança.
2. **Verificação:**
   - E2E da compra do Completo (6 links no e-mail, cada um baixável) e do Almanaque com o bump dos 5 kits;
   - reembolso revoga os links;
   - fica num PR separado, pela regra do repo.
3. **Produto: Resend.** Envio pela API, Testar, webhook com assinatura, painel e escolha do provedor.
4. **Produto: Telegram.** Venda aprovada, Pix gerado, cartão recusado e abandono (pedido não pago no prazo), cada um ligável.
   - **4b. Produto: abandono antes de comprar** (captura do contato no checkout, com aviso de privacidade), num PR seguinte.
5. **Produto: MCP, primeira parte.**
   - tokens e papel leitor;
   - endpoint MCP;
   - todas as ações não sensíveis como ferramentas;
   - `orders.paidReport`;
   - painel de tokens.
6. **Produto: MCP, segunda parte.**
   - fila de aprovação (tabela com RLS, painel e ferramenta `approvals.status`);
   - ações sensíveis pelo MCP;
   - revisão da matriz de sensíveis;
   - upload por link.

Cada PR segue o processo do repo: spec e plano, implementação com code review e security review por task, `/verify` antes do PR, e verificação em PR separado.

## Decisões minhas (o dono pode corrigir)

- **Rateio:** divisão igual com sobra no primeiro item; o bump é rateado separadamente; uso só interno.
- **CSV:** sem coluna nova; a `produto(s)` existente lista todos os PDFs.
- **Edição dos produtos de uma oferta:** ação sensível.
- **Upload por link:** cria um produto novo. Trocar o PDF de um produto existente fica fora.
- **Provedor de e-mail:** SMTP ou Resend, um ativo por vez.
- **Webhook do Resend:** só entregue, devolvido e spam, gravados no `email_log`.
- **Telegram:** mensagem no formato do exemplo acima; eventos novos com o código do pedido e sem dado do comprador; abandono com prazo padrão de 30 minutos.
- **Tokens MCP:**
  - criados por quem tem `team.manage`;
  - gestão de tokens é ação sensível pelo MCP;
  - papel leitor sem CSV e sem dado pessoal.
- **Fila de aprovação:** solicitações expiram em 7 dias.
- **Upload por link:** uso único, 15 minutos.

## O que fica para o construtor

- Biblioteca e transporte do MCP. O SDK oficial com Streamable HTTP é o caminho esperado. O endpoint roda no app Next, em Node.
- Desenho exato das tabelas: itens da oferta, tokens, solicitações e status do e-mail. Toda tabela nova tem `store_id` e RLS.
- Como o editor de oferta mostra N produtos, seguindo o design atual do painel.
- Como gerar o schema de entrada das ferramentas a partir dos schemas Zod das ações.
- Limites e paginação de `orders.paidReport`.
