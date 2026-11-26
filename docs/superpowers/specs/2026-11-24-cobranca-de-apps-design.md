# Cobrança de apps pelo funil, fase 1: PeticionaAqui (design)

Data: 24/11/2026. Dono: Matheus. Integração do lado do app: o desenvolvedor do app (no repositório do PeticionaAqui).

## 1. Intenção

O PeticionaAqui é um SaaS para advogados. A pessoa cria a conta no app, usa 7 dias grátis sem cartão e depois paga.
O Matheus quer que **a cobrança do PeticionaAqui passe pelo funil** por dois motivos:

1. **Rastreamento e métricas num lugar só:** saber de qual anúncio do Meta veio cada cadastro e cada pagamento, mandar
   os eventos ao Meta e ver os números no painel do funil.
2. **Validar o funil como cobrança de apps:** o funil deixa de vender só PDF e passa a cobrar para um app que tem conta
   de usuário. O PeticionaAqui é o primeiro cliente desse formato. Outros apps do Matheus vêm depois.

O app continua sendo a **fonte da verdade do plano e do acesso**. O funil cobra, rastreia e avisa o app.

## 2. Escopo das fases (decidido)

- **Fase 1 (este documento):** várias lojas em produção, API de integração para apps, início do teste rastreado,
  pagamento único de **plano anual** (Start, Plus, Firma) e de **pacotes fixos de créditos**, aviso de pagamento ao app
  por webhook, métricas de cadastro → pagante.
- Fase 2: assinatura mensal recorrente pelo Asaas (renovação, atraso, cancelamento, troca de cartão).
- Fase 3: troca de plano com proporcional, anual parcelado, e-mails de cobrança.

## 3. Objetivos, não objetivos e antiobjetivos

**Objetivos**
- O app abre o pagamento do funil para uma conta logada, sem o comprador conseguir trocar a conta nem o produto.
- O funil sabe a origem (UTMs, `fbclid`/`fbc`, `fbp`) do cadastro, mesmo que o pagamento venha dias depois.
- O Meta recebe o **início do teste** (no cadastro) e a **compra** (no pagamento), com o mesmo identificador de pessoa
  quando possível.
- O painel do funil mostra, por campanha: testes iniciados, pagamentos, valor e conversão teste → pagante.
- O app recebe o aviso de pago (e de reembolso) de forma confiável: assinado, com novas tentativas e idempotente.
- Um contrato de integração escrito para o desenvolvedor do app implementar o lado do app sozinho.

**Não objetivos (fase 1)**
- Recorrência mensal, troca de plano, proporcional, boleto, nota fiscal.
- Cadastro de lojas pelo painel ou cobrança da plataforma (lojas continuam pela CLI `store-create`).
- Recuperação por e-mail e captura de contato na loja do PeticionaAqui (o app já fala com o cliente).
- Abrir o funil para vendedores de fora.

**Antiobjetivos (seria um fracasso mesmo funcionando)**
- O app liberar plano ou créditos com base no redirecionamento do navegador, e não no aviso assinado do funil.
- Um mesmo pagamento creditar duas vezes no app.
- Dado pessoal do comprador sair do funil por log, MCP ou Telegram (regra do repositório), ou ir na URL.
- Quebrar a loja Kids em produção na migração para várias lojas.
- O funil virar dono do estado do plano (vencimento, cota): isso é do app.

## 4. Restrições

- Regras do repositório (CLAUDE.md): dinheiro em centavos; rotas só chamam `runAction`; tabela nova com `store_id` e
  `enable_store_rls`; cartão nunca persistido nem logado; Node em produção; ação nova classificada no catálogo MCP;
  mudança de verificação (`e2e/`, `scripts/verify*`, `.github/`) em PR separado.
- **Mesma conta do Asaas** para as duas lojas (decisão do dono). O webhook do Asaas já é por loja
  (`/api/webhooks/asaas/[storeId]`) e ignora, com 200, pagamento cujo `externalReference` é pedido de outra loja
  (`pedido_de_outra_loja`, sem gravar a cobrança na auditoria da loja receptora; `src/lib/payments/asaas/webhook.ts`). Na conta do Asaas ficam dois webhooks, um
  por loja, cada um com o `webhookToken` da sua loja.
- Sem boleto (decisão do dono). Pix e cartão, como hoje.
- O checkout de hoje exige CPF para o Asaas e só aceita CPF (`requireCpf` em `src/lib/checkout.ts`). **Decisão do
  dono (24/11/2026): a loja do PeticionaAqui aceita CPF ou CNPJ** (ver 7.4).
- O pagamento do plano anual chega a R$ 4.970,00 e é **à vista** na fase 1 (parcelado é fase 3; o PeticionaAqui
  também define "anual cobrado de uma vez"). Oferta `app` trava `maxInstallments = 1`: no parcelado o Asaas cria uma
  cobrança por parcela e estorno de uma parcela não muda o pedido.

## 5. Abordagens consideradas

| Abordagem | Como funciona | Troca | Escolha |
|---|---|---|---|
| **A. API servidor a servidor** (estilo Stripe Checkout) | O servidor do app chama a API do funil com uma chave da loja para registrar o início do teste e para criar um pagamento. O funil devolve uma URL curta de pagamento. Aviso de volta por webhook assinado | O app faz uma chamada antes de redirecionar. Em troca: conta não vai na URL nem pode ser forjada, origem vai de servidor para servidor, nome e e-mail chegam preenchidos, uma chave só | **Escolhida pelo dono** |
| B. Link assinado pelo app | O app monta o link do checkout com a conta e uma assinatura HMAC; o início do teste continua precisando da API | Um passo a menos no pagamento, mas dois mecanismos de segurança, origem na URL e link reaproveitável até vencer | Descartada |
| C. Cobrar direto no app (Asaas no PeticionaAqui) | O app liga o Asaas nas tabelas que já tem | Sem rastreamento nem métricas no funil, não valida o funil para apps | Descartada (contraria o porquê) |

Rastreamento: entre "só o pagamento" e "o caminho inteiro (teste + pagamento)", o dono escolheu **o caminho inteiro**:
o pagamento costuma chegar 7 dias ou mais depois do clique, no limite da janela de atribuição do Meta, então o início
do teste é o evento que as campanhas conseguem otimizar.

## 6. Decisões do dono (24/11/2026)

1. A compra acontece dentro do app, com a pessoa logada, depois (ou durante) o teste de 7 dias.
2. Créditos avulsos viram **pacotes fixos** (X créditos por um valor fixo). Quais pacotes e preços: definidos no
   painel do funil pelo dono (e no app pelo desenvolvedor do app), fora deste documento.
3. Mesma conta do Asaas do Kids. Sem boleto.
4. O app é a fonte da verdade do plano; o funil só cobra, rastreia e avisa.
5. Rastrear o caminho inteiro (abordagem B do rastreamento): início do teste + pagamento.
6. Integração pela API servidor a servidor (abordagem A).
7. O desenvolvedor do app implementa o lado do app; o funil entrega um contrato de integração escrito.
8. O checkout do PeticionaAqui aceita **CPF ou CNPJ** (escritórios pagam pela empresa).

## 7. Design

### 7.1 Várias lojas em produção

- Produção passa de `MODE=single` para `MODE=multi`. A loja Kids continua respondendo em `checkout.moradah.com.br`
  (via `store.domain`) e no `pagar.` atual. A loja PeticionaAqui é criada pela CLI com domínio próprio.
- **Falta no código:** uma forma de definir o domínio de uma loja que já existe (hoje o domínio só entra no
  `store-create`). Proposta: comando de CLI `store-domain --slug <slug> --domain <host>` (operador da plataforma,
  como o `store-create`), não ação do painel. Auditado.
- No `multi`, o `pagar.` é um só (`pagar.<PLATFORM_DOMAIN>`), e o Turnstile confere o host do checkout da loja do pedido
  (seção 12 do `docs/instalacao.md`). A migração precisa de um roteiro passo a passo, com janela combinada com o dono,
  `PLATFORM_DOMAIN`, `store.domain` da Kids (criada pelo setup, sem domínio: `src/lib/stores.ts:115`), DNS, Caddy e
  Turnstile, e um caminho de volta.
  **Proposta (call do assistente):** `PLATFORM_DOMAIN=checkout.moradah.com.br`; a Kids fica com `domain =
  checkout.moradah.com.br` e o `pagar.checkout.moradah.com.br` continua o mesmo, então a Kids não muda de endereço.
  O `pagar.` continua `pagar.checkout.moradah.com.br`, então o `CARD_ORIGIN` não muda. O PeticionaAqui entra com
  domínio próprio.
- **Domínio do checkout do PeticionaAqui (call do assistente):** `checkout.peticionaaqui.com.br` como `store.domain`.
  O cartão continua no `pagar.` único da plataforma (`pagar.checkout.moradah.com.br`), dentro do iframe: não é da
  marca, mas o comprador não vê esse endereço. (Na conversa o assistente citou `pagar.peticionaaqui.com.br`; no `multi`
  o `pagar.` é um só para todas as lojas, então o nome da marca vai no domínio do checkout.) A lista de hostnames do
  Turnstile ganha esse domínio, e o Caddy ganha o bloco do domínio (lista fixa, sem curinga).
- **Teste:** um E2E com duas lojas lado a lado (isolamento de pedidos, webhook do Asaas da outra loja ignorado, painel de
  uma loja sem dados da outra). Vai no PR de verificação.

### 7.2 Chave de integração da loja

- Reaproveita o modelo do token MCP (`fnl_<storeId>_<segredo>`, só o sha256 no banco, RLS, criado e revogado no painel,
  mostrado uma vez). Novo **papel `integration`** com permissão só para as ações da API de integração (7.3, 7.4). Uma
  chave `integration` não serve para o MCP e um token MCP não serve para a API de integração.
- No painel: em **Conexões**, um cartão "App (integração)" com: criar/revogar chave, URL do webhook do app, segredo do
  webhook (gerado pelo funil, mostrado uma vez, com rotação) e botão "Enviar teste".
- A URL do webhook só aceita `https` e host público (mesma regra de saída do SMTP em `multi`: sem IP privado, sem
  loopback, exceto nos testes por variável de ambiente só em loopback, como o Resend falso).

### 7.3 Início do teste: `POST /api/integracao/v1/testes`

Chamado pelo servidor do app logo depois do cadastro.

- Entrada: `conta` (id da conta no app, texto opaco até 64 caracteres), `email`, `nome` (opcional), `telefone`
  (opcional), `origem` (`utm_*`, `fbclid`, `fbc`, `fbp`, `ref`, mesmos limites do `touch.ts`), `ip` e `user_agent` do
  navegador no cadastro (para o Meta), `iniciado_em` (opcional, padrão agora), `event_id` (opcional, para deduplicar
  com o Pixel do navegador se o app disparar o evento lá também).
- Efeito: grava um **registro de teste** (`app_trial`: loja, conta, hash do e-mail e da caixa, origem, fbc/fbp, data;
  ip e user agent só até o `StartTrial` sair, e apagados em no máximo 7 dias — call do assistente: só o evento do Meta
  precisa deles) e enfileira o evento do Meta `StartTrial` (com
  `value: 0`, `currency: BRL`). Idempotente por (loja, conta): a segunda chamada devolve o mesmo registro e não manda
  outro evento.
- O e-mail não é guardado em claro no registro de teste (só hashes, como na recuperação): o funil não vira base de
  contatos do app. O Meta recebe o e-mail em sha256, como já faz no Purchase.
- Resposta: `201` com `{ id }` ou `200` se já existia.

### 7.4 Criar pagamento: `POST /api/integracao/v1/pagamentos`

Chamado pelo servidor do app quando a pessoa clica em pagar.

- Entrada: `conta`, `oferta` (slug da oferta no funil, por exemplo `start-anual`, `creditos-50`), `email`, `nome`,
  `telefone` (opcional), `origem` (opcional: se vier, vale para este pagamento; se não, o funil usa a origem do teste
  da conta), `retorno` (URL do app para onde a página de obrigado leva; só no domínio configurado da loja ou do app).
- Efeito: cria uma **sessão de pagamento** (`app_checkout_session`: loja, conta, oferta, nome, e-mail, origem, expira em
  60 min, uso único por pedido pago) e devolve `{ url, expira_em }`. A URL é `https://<domínio da loja>/c/<oferta>?s=<id
  aleatório>`, sem dado pessoal.
- O checkout com `?s=` abre com nome e e-mail travados (vindos da sessão), sem order bump nem cupom na fase 1 (call do
  assistente: preço do app é o da oferta), e pede só o que falta (CPF ou CNPJ para o Asaas, telefone se não veio, cartão).
- O pedido guarda `app_account` (a `conta`) e o vínculo com a sessão. A origem do pedido vem da sessão (ou do teste da
  conta, se a sessão não trouxe), não da URL do checkout.
- A oferta precisa estar marcada como **oferta de app** (7.5). Uma oferta de app não abre sem `?s=` válido.
- Oferta `app` só usa Pix do Asaas e cartão (call do assistente): o Pix manual muda o valor (centavos únicos) e é
  liberado por uma pessoa no painel, o que faria o app liberar plano por ação humana.

- **CPF ou CNPJ:** configuração por loja (`store.accept_cnpj`, desligada por padrão; ligada na loja do PeticionaAqui).
  Com ela, o campo vira "CPF ou CNPJ", a validação aceita os dois (já existe `validCnpj` em
  `src/lib/payments/manual.ts`, a reaproveitar), e o cliente do Asaas é criado com o documento informado. Vale para Pix
  do Asaas e para o titular do cartão no serviço `card` (conferir se o Asaas aceita CNPJ no titular). A loja Kids não
  muda.

### 7.5 Oferta e produto de app (sem PDF)

- Oferta ganha `delivery` = `download` (hoje) ou `app`. Oferta `app` não tem produtos PDF, não manda e-mail de acesso e
  tem `app_code` (o código que vai no webhook, por exemplo `start_anual` ou `creditos_50`). O app traduz `app_code` em
  plano ou créditos; o funil não sabe o que é "crédito".
- Pós-pagamento de um pedido `app`: em vez de `deliver_order`, enfileira `notify_app` (7.6). `meta_event Purchase`,
  `notify_seller` e o Telegram continuam iguais.
- Reembolso total de um pedido `app` (painel ou Asaas): enfileira `notify_app` com `pagamento.reembolsado`.
  Contestação: `pagamento.contestado`. Contestação revertida a favor da loja (`disputed` → `paid`, que o código já
  trata em `src/lib/orders/state.ts`): `pagamento.restabelecido`. Cabe ao app decidir o que fazer em cada um (tirar
  créditos, encerrar ou devolver o plano).
- Reembolso parcial (call do assistente): o painel não oferece parcial em pedido `app`. Se um parcial vier do Asaas (feito
  direto lá), o pedido continua pago, como hoje, e sai `pagamento.reembolso_parcial` com `valor_estornado_centavos`; o
  app decide.

### 7.6 Aviso ao app: webhook de saída

- Eventos: `pagamento.confirmado`, `pagamento.reembolsado`, `pagamento.reembolso_parcial`, `pagamento.contestado`,
  `pagamento.restabelecido` e `ping` (botão "Enviar teste").
  Não há evento de teste iniciado: quem avisa o funil do teste é o próprio app.
- Corpo JSON: `id` do evento (único, para o app deduplicar), `tipo`, `criado_em`, e `dados` com `conta`, `pedido`
  (publicId), `app_code`, `valor_centavos`, `metodo`, `pago_em`. Sem CPF, sem telefone, sem e-mail (o app já tem a
  conta).
- Assinatura: cabeçalhos `Funil-Assinatura: t=<unix>,v1=<hex HMAC-SHA256(segredo, t + "." + corpo)>` e `Funil-Evento:
  <id>`. O app confere a assinatura com tempo constante e recusa `t` com mais de 5 minutos de diferença.
- Entrega: job `notify_app` at-least-once, com novas tentativas por backoff (1 min, 5 min, 30 min, 2 h, 6 h, 24 h) até
  48 h; considera entregue com resposta 2xx em até 10 s. Depois da última falha: alerta no painel (como `telegram_falhou`)
  e no Telegram do vendedor, e botão "Reenviar" no pedido.
- Registro de entrega (`app_webhook_delivery`): evento, status, tentativas, último código HTTP. Sem corpo da resposta.

### 7.7 Meta

- `StartTrial` (servidor, API de Conversões) no `POST /testes`, com `event_id = trial:<id do registro>` ou o `event_id`
  enviado pelo app; dados de pessoa: e-mail em sha256, `fbc`, `fbp`, ip, user agent, `external_id` = sha256(conta).
- `Purchase` do pedido `app`: muda em relação a hoje (`external_id` = sha256 do `customerId` e `content_ids` = ids de
  produto, `src/lib/tracking/meta.ts:385-388`). Para pedido `app`: `external_id` = sha256(conta), `fbc`/`fbp` herdados
  do teste quando o pagamento não trouxe, e `content_ids` = `app_code`. Pedido `download` não muda.
- `InitiateCheckout` continua saindo do checkout.
- A tabela `conversion` hoje marca por pedido; o `StartTrial` precisa de marca por registro de teste.

### 7.8 Métricas no painel

- No Dashboard da loja: "Testes iniciados", "Pagantes" (contas distintas com pedido `app` pago no período), "Conversão
  teste → pagante" (pagantes cujo teste caiu no período / testes do período) e a tabela por campanha (`utm_campaign` do
  primeiro toque do teste) com testes, pagantes, conversão e valor.
- Só aparece em loja que tem oferta `app` (a Kids não muda).

### 7.9 MCP e privacidade

- Novas ações classificadas no catálogo MCP. As ações da API de integração são **só da chave `integration`** (fora do
  MCP). Leituras de métricas de teste entram no MCP como leitura sem dado pessoal. Configurar a URL e o segredo do
  webhook é ação sensível (fila de aprovação), como as conexões.
- Registro de teste (call do assistente): 180 dias para testes que não viraram pagamento (o suficiente para medir
  conversão), depois apagados por job. Teste que virou pagamento fica enquanto o pedido existir.

### 7.10 Contrato de integração para o app

Documento `docs/integracao-apps.md` (no funil), em português, para quem implementa o app:
1. Visão geral e diagrama do fluxo (cadastro → teste → pagar → aviso → liberar).
2. Como criar a chave e configurar o webhook no painel.
3. Os dois endpoints com exemplos `curl` e respostas, erros (`401`, `404` oferta, `409`, `422`, `429`) e limites.
4. Como guardar a origem no cadastro (cookies `_fbc`, `_fbp`, UTMs da URL de entrada) e o snippet de exemplo.
5. Webhook: eventos, corpo, verificação da assinatura com exemplo em TypeScript (Web Crypto) e idempotência pelo `id`.
6. O que o app faz em cada evento (no PeticionaAqui: `creditar_recarga_peticao` com o `pedido` como chave; ativar o
   plano anual sem recriar o teste).
7. Ambiente de teste: loja de teste, Asaas sandbox, "Enviar teste".
8. Lista de conferência antes de ir para produção.

## 8. Entrega em PRs (proposta)

1. **Várias lojas:** CLI `store-domain` + ajustes que a migração exigir + roteiro da migração da produção em
   `docs/instalacao.md`. PR de verificação: E2E com duas lojas.
2. **API de integração e entrega para app:** papel `integration`, chave, oferta `app`, `POST /testes`, `POST
   /pagamentos`, checkout com `?s=`, `notify_app`, webhook assinado, painel (Conexões e oferta), Meta `StartTrial`.
3. **Métricas** de teste → pagante.
4. **Contrato** `docs/integracao-apps.md` (pode ir junto do PR 2).
5. PR de verificação: E2E com um app falso (recebe o webhook, confere assinatura) cobrindo teste → pagamento Pix →
   aviso.
6. Migração da produção para `MODE=multi` e criação da loja PeticionaAqui: operação com o dono, fora de PR.

## 9. Deixado para quem constrói

- Nomes de tabelas, colunas e arquivos; números das migrações.
- Formato exato dos erros da API (seguir o `runAction` e o `ActionError`).
- Limites de taxa por chave (proposta: 60 requisições por minuto por chave) e tamanho máximo do corpo.
- Layout das telas novas seguindo `docs/padrao-de-paginas.md`.
