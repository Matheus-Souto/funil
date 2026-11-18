# Plataforma de funil de vendas: design do MVP

Data: 2026-11-18
Nome do produto: a definir (usado aqui como "a plataforma")
Referência: [LibreFunnel](https://github.com/ToledoSDL/librefunnel) (MIT). Usado só como inspiração e fonte de peças
pontuais; não é fork.

## 1. Intenção e porquê

O dono vende hoje um PDF infantil ("Maná bíblico para crianças") pela Cakto e está insatisfeito: taxas altas, muitas
dificuldades na experiência. Quer a própria plataforma de vendas, que vai servir:

1. **A ele mesmo**, primeiro: migrar esse produto da Cakto o quanto antes.
2. **A outras pessoas**, de dois jeitos:
   - **Self-hosted (open source)**: qualquer um instala e usa sozinho, uma loja por instalação.
   - **Nuvem (SaaS)**: quem não quer cuidar de servidor assina e usa a infraestrutura dele, com várias lojas no mesmo
     sistema.

O diferencial de longo prazo é ser **AI native**: tudo que se faz no painel também pode ser feito por IA (chat no
painel e MCP), sempre respeitando as permissões de cada usuário. Haverá um plano com a IA da plataforma e outro em que o
cliente usa a própria chave (BYOK).

Concorrência na versão nuvem: Cakto, Kiwify, Hotmart, Eduzz. O atrativo é sem taxa por venda da plataforma (o dinheiro
vai direto para o gateway ou a chave Pix do vendedor) e IA de verdade.

## 2. O produto que precisa rodar no MVP

- PDF, compra única, entrega por e-mail. Sem área de membros, sem assinatura.
- Low ticket: **versão básica R$ 9,90** e **versão completa R$ 27**.
- Página de vendas única mostra as duas ofertas; **cada oferta tem o seu checkout**.
- No checkout da básica aparece um **order bump "adicionar o completo"**.
- Tráfego: anúncios (pago), orgânico e indicação (indicação **sem** afiliado).
- O dono recebe no **Nubank pessoa física** (Pix manual) e quer também **Asaas** (Pix automático e cartão).

## 3. Objetivos, não-objetivos, anti-objetivos

### Objetivos do MVP

- O dono consegue cadastrar o produto, as duas ofertas e o order bump, e vender de ponta a ponta.
- Checkout próprio, rápido no celular, com **Pix manual (Nubank)**, **Pix via Asaas** e **cartão via Asaas digitado no
  próprio checkout**.
- Entrega automática do PDF por e-mail assim que o pagamento é confirmado (automático no Asaas, ou ao clicar "Liberar"
  no Pix manual).
- Pixel do Meta + API de Conversões funcionando desde o primeiro dia, com deduplicação.
- UTM e código de indicação registrados em cada pedido.
- Painel com vendas, pedidos (liberar, reenviar entrega, reembolsar), produtos, ofertas e conexões.
- **Base preparada para o futuro**: multi-loja, usuários com papéis e permissões, camada de ações única, servidor MCP.

### Não-objetivos do MVP (vêm depois, na ordem que o dono escolher)

Área de membros, assinaturas e recorrência, afiliados e coprodução, editor visual de páginas, comunidade, upsell e
downsell pós-compra, drip e certificados, sequências de e-mail e disparos, teste A/B, webhooks de saída, outros tipos de
produto (mentoria, evento), app/PWA do aluno, TikTok e Google Ads, confirmação automática do Pix manual, boleto, nota
fiscal, cadastro self-service e cobrança de assinatura da versão nuvem, chat de IA dentro do painel e planos de IA.

### Anti-objetivos (falha mesmo que "funcione")

- **O dinheiro do vendedor passar pela conta da plataforma.** A plataforma nunca intermedia vendas; cada loja usa a
  própria chave Pix e a própria conta Asaas.
- **Uma loja enxergar ou alterar dados de outra.**
- **A IA (ou o MCP) fazer algo que o usuário dela não poderia fazer**, ou executar ação financeira/destrutiva sem
  confirmação humana.
- **Dados de cartão gravados** em banco, log, fila, cache ou mensagem de erro.
- Checkout lento ou cheio de campos que derrube a conversão de um produto de R$ 9,90.
- Duas versões do código (uma self-hosted e outra nuvem) que divergem.

## 4. Restrições

- Mesmo código para self-hosted (1 loja) e nuvem (N lojas).
- Self-hosted precisa rodar em servidor pequeno (referência: 1 vCPU / 1 GB, como o LibreFunnel) via Docker Compose.
- Projeto open source. Ao copiar trechos do LibreFunnel, manter o aviso de copyright MIT dele nesses arquivos.
- Asaas exige **CPF/CNPJ** do cliente em qualquer cobrança. Para cartão, exige ainda do titular: nome, e-mail, CPF,
  **CEP, número do endereço, telefone** e o IP do comprador (`remoteIp`). Recomenda timeout mínimo de 60 s na criação
  da cobrança com cartão.
- Nubank PF não tem API: Pix manual não tem confirmação automática no MVP.
- LGPD: CPF, telefone e e-mail são dados pessoais; coletar só o necessário e ter política de privacidade.

## 5. Abordagens consideradas

| Abordagem | Troca | Decisão |
|---|---|---|
| **1. Projeto novo, multi-loja desde o início, um só código**, reaproveitando peças do LibreFunnel | Começa mais devagar que copiar tudo, mas a base já nasce no formato certo (lojas, permissões, ações, MCP) | **Escolhida pelo dono** |
| 2. Copiar o LibreFunnel inteiro e adaptar para multi-loja | Começa com muito pronto, mas ele é mono-vendedor de ponta a ponta (senha única, `.env`, 23 tabelas sem dono); adaptar mexe em quase tudo e traz área de membros/VSL/WhatsApp que o MVP não usa | Descartada |
| 3. Uma instalação separada por cliente da nuvem | Código simples, mas cada assinante vira um servidor e banco a manter; não fecha conta para vendedor low ticket e dificulta a IA da plataforma | Descartada |

Cartão:

| Opção | Troca | Decisão |
|---|---|---|
| **A. Cartão digitado no próprio checkout (transparente)** | Comprador não sai da página; em troca, mais campos (CPF, CEP, nº, telefone) e o número do cartão passa pelo servidor (responsabilidade PCI) | **Escolhida pelo dono** |
| B. Redirecionar para a página de cartão do Asaas | Cartão nunca toca o sistema; em troca, troca de tela no meio da compra | Descartada |

## 6. Decisões do dono

- Abordagem 1 (multi-loja, um código).
- MVP = migrar o produto da Cakto o mais rápido possível; o resto do roadmap entra com o produto rodando.
- Pagamentos no MVP: **Pix manual** (chave própria, liberação manual no painel) + **Asaas** (Pix e cartão).
- Cartão **no próprio checkout** (opção A).
- Pix manual sem automação por enquanto.
- Duas ofertas na mesma página de vendas, cada uma com seu checkout; bump "adicionar o completo" no checkout da básica.
- Order bump faz parte do MVP.
- Indicação é rastreio, não afiliado.
- IA nativa, com permissões por usuário, via MCP e (depois) chat; plano com IA da plataforma e plano BYOK.

## 7. Design

### 7.1 Stack (decisão do assistente)

TypeScript, Next.js (App Router), PostgreSQL com Drizzle ORM, Zod para validação. Docker Compose (app + Postgres +
Caddy) para self-hosted. Mesma linha do LibreFunnel, que já mostrou rodar bem em servidor pequeno. Gerenciador de
pacotes e runtime ficam a critério do construtor (Bun ou Node).

### 7.2 Multi-loja

- Tabelas `store` e `user`; `membership(user, store, role)`. Um usuário pode pertencer a várias lojas.
- **Toda tabela de negócio tem `store_id`**. Isolamento garantido em duas camadas: a camada de ações sempre filtra por
  loja, e o Postgres tem **Row Level Security** por `store_id` como rede de segurança (decisão do assistente).
- Self-hosted: na primeira execução, um assistente de configuração cria o usuário dono e a loja única. Não há tela de
  cadastro público.
- Nuvem: no MVP, lojas são criadas por um administrador da plataforma (o dono). Cadastro self-service e cobrança da
  assinatura ficam fora do MVP. O modelo de dados não muda quando entrarem.
- Domínio: cada loja tem um subdomínio da plataforma e, opcionalmente, domínio próprio (o dono usará o dele).
  Emissão automática de certificado para domínio próprio de clientes da nuvem pode ficar para depois; no MVP basta o
  domínio do dono configurado no Caddy.

### 7.3 Camada de ações, permissões e MCP (o coração "AI native")

- Cada operação de negócio é uma **ação** definida uma única vez: nome, descrição (para humanos e IA), schema de entrada
  e saída (Zod), permissão exigida, e uma marca de **sensível** (mexe com dinheiro ou apaga dados).
- O painel (server actions), a API e o servidor MCP chamam **as mesmas ações**. Nenhuma regra de negócio fora delas.
- Contexto de execução: usuário, loja, papel, origem (painel, API, MCP, IA). Toda ação valida permissão antes de
  executar e grava em um **log de auditoria** (quem, o quê, origem, quando).
- Papéis iniciais (decisão do assistente): **dono** (tudo), **admin** (tudo menos gerir membros e conexões de
  pagamento), **suporte** (ver pedidos, reenviar entrega), **tráfego** (ver métricas e configurar pixel). Permissões
  são granulares por ação; papéis são conjuntos delas.
- **Ações sensíveis** (reembolsar, alterar preço, apagar produto, alterar conexão de pagamento) chamadas por MCP/IA
  **não executam direto**: criam uma solicitação pendente que o usuário aprova no painel. No painel, pedem confirmação
  explícita.
- **MCP no MVP** (decisão do assistente): servidor MCP via HTTP, autenticado por token pessoal criado no painel,
  vinculado a um usuário e uma loja, com as permissões desse usuário. Ações expostas no MVP: listar/criar/editar
  produtos e ofertas, listar pedidos, resumo de vendas, reenviar entrega, e as sensíveis como solicitação.
- **Texto vindo de compradores** (nome, campos livres) é dado, nunca instrução: as ações devolvem esses campos marcados
  como conteúdo não confiável, e nenhuma ação é disparada a partir do conteúdo deles.
- Chat de IA no painel, planos de IA e BYOK: **fora do MVP**, mas a camada de ações já é o que eles vão usar.

### 7.4 Catálogo

- **Produto**: nome, arquivo (PDF), loja. Arquivo guardado em armazenamento local (self-hosted) ou compatível com S3
  (nuvem); o construtor escolhe a abstração.
- **Oferta**: produto(s) que entrega, preço, nome exibido, slug do checkout, métodos de pagamento habilitados, parcelas
  máximas no cartão (padrão 1x; configurável), página de obrigado, e no máximo um **order bump** no MVP.
- **Order bump**: aponta para outro produto, com preço do acréscimo definido pelo vendedor e texto da caixa. No caso do
  dono: no checkout da básica (R$ 9,90), bump "Quero a versão completa" por um acréscimo que ele define. Quem marca o
  bump recebe **os dois PDFs** (decisão do assistente; o construtor deve tornar configurável se o bump substitui ou
  soma, caso fique simples).
- **Página de vendas**: no MVP a página de vendas do dono **continua onde está hoje** (fora da plataforma) e os botões
  apontam para os checkouts da plataforma (decisão do assistente; editor de páginas está fora do MVP). Depende da
  pergunta 1 da seção 10. Se a página for externa, um pequeno script da plataforma nela repassa UTMs, `fbclid` e `ref`
  para o link do checkout.

### 7.5 Checkout

Uma página por oferta, otimizada para celular, sem login.

1. Resumo da oferta e caixa do order bump.
2. Campos: **nome, e-mail, WhatsApp**.
3. Escolha do método, conforme a oferta:
   - **Pix (manual)**: não pede CPF. Gera QR/"copia e cola" estático (BR Code) para a chave da loja com o **valor
     único** do pedido (centavos variados, ex. R$ 9,93) e o identificador do pedido, para o vendedor achar no extrato.
     Tela mostra o QR, instruções e aviso de que o envio acontece após a confirmação.
   - **Pix (Asaas)**: pede CPF. Cria cliente e cobrança Pix no Asaas, mostra QR dinâmico e espera a confirmação
     (atualização da tela por polling curto ou SSE), redirecionando para a página de obrigado quando pago.
   - **Cartão (Asaas, transparente)**: pede CPF, CEP, número do endereço, dados do cartão e parcelas (se > 1). Envia
     ao Asaas com o IP do comprador. Aprovado: página de obrigado. Recusado: mensagem clara e opção de tentar Pix.
   - Se a loja tiver Pix manual e Pix Asaas ligados ao mesmo tempo, o checkout mostra só um Pix: a oferta define qual
     (decisão do assistente).
4. Captura de UTMs, `fbclid`/`fbc`/`fbp` e código de indicação (`?ref=`) na entrada e gravação no pedido.

**Segurança do cartão (obrigatório, consequência da opção A):**

- Dados do cartão só existem em memória durante a requisição; nunca em banco, log, fila, cache, APM ou mensagem de
  erro. Logs e rastreamento de erros com filtro explícito desses campos.
- HTTPS obrigatório; o checkout recusa enviar cartão sem HTTPS.
- **Proteção contra teste de cartão** (checkouts de valor baixo são alvo clássico): limite de tentativas por IP, por
  e-mail e por cartão (hash efêmero em memória/Redis-like, sem guardar o número), desafio anti-robô (ex. Cloudflare
  Turnstile) a partir de tentativas suspeitas, e bloqueio temporário.
- Timeout de 60 s e chave de idempotência por tentativa, para não cobrar duas vezes.

### 7.6 Pedidos e pagamentos

- Estados do pedido: `pendente` → `pago` → (`reembolsado` | `contestado`) ou `expirado`/`recusado`.
- Pix manual: pedido fica `pendente` até o vendedor clicar **Liberar** no painel; validade configurável (padrão 24 h).
  O painel mostra o valor único e o identificador para conferir com o extrato do Nubank. Aviso no painel: nunca liberar
  com base em comprovante enviado pelo comprador.
- Asaas: webhook recebido em endpoint por loja, autenticado pelo token de webhook configurado no Asaas. O webhook
  **não é confiado**: o sistema consulta a cobrança na API do Asaas e só então muda o estado. Processamento idempotente
  (o mesmo evento duas vezes não entrega duas vezes). Eventos tratados: confirmado/recebido, reembolsado, estorno
  (chargeback) e vencido.
- Reembolso pelo painel (ação sensível) chama a API do Asaas; no Pix manual, apenas marca como reembolsado (o
  vendedor devolve pelo banco).

### 7.7 Entrega

- Ao virar `pago`: e-mail ao comprador com **link pessoal de download** (token aleatório; validade e limite de
  downloads configuráveis; padrão sugerido: 30 dias, 5 downloads).
- **PDF com nome e e-mail do comprador no rodapé das páginas**, gerado no primeiro download e guardado em cache
  (proposta do assistente para desestimular pirataria; o dono não se opôs). O construtor deve medir o custo em servidor
  pequeno.
- Painel: reenviar e-mail e renovar link.
- Envio de e-mail por **SMTP genérico** configurado por loja (Gmail, Brevo, Resend via SMTP etc.), com botão Testar.
  Fila com novas tentativas; falhas visíveis no painel.
- Aviso de venda ao vendedor por e-mail (decisão do assistente; simples e útil).

### 7.8 Rastreamento

- **Meta Pixel** no checkout e na página de obrigado (`InitiateCheckout`, `AddPaymentInfo`, `Purchase`).
- **API de Conversões do Meta** enviando `Purchase` (e `InitiateCheckout`) pelo servidor com o **mesmo `event_id`**
  do navegador, com dados do comprador em hash, `fbc`/`fbp`, IP e user agent. Reembolso não é enviado ao Meta.
- Pixel configurável por loja e, opcionalmente, por oferta.
- UTMs com primeiro e último toque, e código de indicação, gravados no pedido; painel agrupa vendas por origem e por
  código de indicação.
- Para o pixel continuar otimizando na migração, usar o **mesmo Pixel ID** já usado com a Cakto.

### 7.9 Painel (MVP)

- Visão geral: vendas e receita por período, conversão do checkout (visitas → pedidos → pagos), por método e por
  origem/indicação.
- Pedidos: lista com filtros, detalhe, Liberar (Pix manual), Reenviar entrega, Reembolsar, exportar CSV.
- Produtos e ofertas (com order bump e link do checkout para copiar).
- Conexões: Pix manual (chave, nome e cidade do recebedor), Asaas (chave de API, ambiente sandbox/produção, URL e token
  do webhook), e-mail SMTP, Meta (Pixel ID e token da API de Conversões). Segredos **criptografados** no banco, nunca
  exibidos de novo; botão Testar em cada um.
- Equipe: convidar usuário por e-mail com papel.
- Tokens de MCP: criar, listar, revogar.
- Solicitações pendentes da IA/MCP para aprovar ou recusar.
- Login no painel: e-mail + senha com sessão segura, ou link mágico (decisão do construtor); 2FA fica para depois.

### 7.10 Self-hosted e nuvem

- Self-hosted: `docker compose up` com app, Postgres e Caddy (HTTPS automático). Configuração mínima em `.env`
  (URL pública, segredo de criptografia, senha do Postgres); o resto no painel.
- Nuvem: a mesma imagem, com várias lojas. Onde hospedar fica a critério do construtor e do dono.
- Diferenças de comportamento entre os dois modos ficam em uma única configuração (`MODE=single|multi`), não em
  bifurcações espalhadas pelo código.

### 7.11 Migração da Cakto

Como a entrega é só por e-mail, não há alunos para migrar. Passos: cadastrar o produto, as ofertas e o bump; conectar
Asaas, Pix manual, e-mail e Meta (mesmo Pixel ID); fazer compras de teste (sandbox do Asaas e Pix manual de valor
baixo); trocar os links dos botões da página de vendas e dos anúncios; manter a Cakto ligada alguns dias para pedidos
em andamento. Importar a lista de compradores antigos da Cakto (CSV) é opcional e pode ficar para depois.

## 8. Peças do LibreFunnel que valem estudar

Gerador de BR Code do Pix (`src/lib/orders/pix.ts`), envio ao Meta (`src/lib/tracking/meta.ts`), captura de UTM e
toques (`src/lib/tracking/visitors.ts`, tabela `touch`), criptografia de credenciais (`src/lib/settings.ts`), webhooks
de pagamento com reconsulta ao provedor (`src/lib/orders/webhooks.ts`). Copiar com o aviso MIT, adaptando para
`store_id`.

## 9. O que fica para o construtor

Estrutura de pastas, bibliotecas auxiliares, fila de tarefas (tabela no Postgres é suficiente), armazenamento de
arquivos, estratégia de testes (o sandbox do Asaas deve ser usado nos testes de integração), layout visual do checkout
e do painel, detalhes da autenticação do painel, limites exatos do antiteste de cartão.

## 10. Decisões tomadas na revisão e perguntas em aberto

### Decisões do assistente após a revisão (o dono pode corrigir)

- **Quem usa a nuvem no MVP:** só a loja do dono. O suporte a várias lojas é construído e testado, mas **não se abre
  para vendedores de fora no MVP**. Antes de abrir, é obrigatório revisar o cartão transparente (opção A): com cartões
  de muitos lojistas passando pelos servidores, as obrigações PCI e de LGPD (como operador de dados) crescem bastante.
  Isso pode levar a revisitar a opção B só na nuvem.
- **Onde a loja do dono roda:** na instância da nuvem (`MODE=multi`), como primeira loja. Assim o modo de várias lojas
  é o caminho testado em produção desde o início. O modo `single` é testado em CI e numa instalação de teste com Docker
  Compose.
- **Ordem de entrega dentro do MVP:**
  - Fase 1: camada de ações com permissões, multi-loja com RLS, catálogo, checkout, pagamentos, entrega, rastreamento e
    painel do dono.
  - Fase 2: MCP, fila de aprovações, equipe e convites.
  - O dono pode trocar a Cakto pela plataforma ao fim da fase 1, porque a base que importa (ações e multi-loja) já
    estará lá.
- **Página de obrigado:** sempre hospedada pela plataforma, por oferta, com texto configurável. O evento `Purchase` do
  navegador sai de lá com o mesmo `event_id` do servidor.
- **Pix com Asaas e Pix manual:** quando a loja tiver Asaas conectado, o padrão das ofertas é o Pix do Asaas, e o manual
  fica como alternativa.
  - O Pix manual trata colisão de valores únicos: faixa de centavos mais ampla, validade menor quando há muitos pedidos
    abertos, e bloqueio do Pix manual quando não houver valor livre. Nesse caso, o checkout oferece o Asaas ou mostra
    um aviso.
  - O painel considera que o extrato do Nubank pode não mostrar o identificador. A conferência pode ser só por valor e
    horário.
- **Reembolso ou estorno revoga o link de download.**

### Respostas do dono

1. **Página de vendas:** é própria, feita pelo dono, hospedada fora da Cakto (entendido como Cloudflare), e aceita
   scripts. Consequências (decisões do assistente):
   - Ela continua onde está e recebe o script da plataforma, que repassa UTMs, `fbclid` e `ref` para o link do
     checkout.
   - O checkout da loja do dono fica num **subdomínio do mesmo domínio raiz** da página de vendas (ex.
     `checkout.dominio.com.br`). Assim os cookies `_fbp`/`_fbc` do Meta valem nas duas páginas.
2. **Volume:** ainda baixo, porque as vendas começaram agora. O esquema de valor único do Pix manual é suficiente, e o
   tratamento de colisão descrito acima cobre o crescimento.
3. **Asaas:** a conta já está aprovada. O cartão pela API deve ser validado no sandbox e numa primeira compra real
   durante a fase 1. Se o Asaas pedir alguma liberação extra para o cartão transparente, o Pix sai primeiro e o cartão
   entra assim que for liberado.
