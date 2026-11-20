# Isolamento do cartão: serviço próprio com o formulário em iframe

Data: 19/11/2026. Decisão do dono: isolar o cartão em vez de usar a página de cartão hospedada do Asaas, no formato
"formulário dentro do serviço isolado" (abordagem A abaixo).

## Por que

Hoje o mesmo processo Node recebe número e CVV do cartão (`POST /api/checkout/card`) e também:
- serve o painel;
- valida e carimba PDFs enviados pelo vendedor;
- fala SMTP;
- roda a fila de jobs;
- carrega todas as dependências do front.

Uma falha em qualquer um desses pedaços expõe os cartões em trânsito de todas as lojas
(`docs/seguranca-pagamento.md`). O objetivo é tirar o cartão desse processo: só um serviço pequeno, sem painel, PDF,
SMTP ou fila, recebe e transmite os dados do cartão.

O formulário onde o comprador digita o cartão também sai do app principal. Se ficasse na página `/c/<oferta>`, um app
comprometido poderia trocar o JavaScript e desviar o cartão antes do envio, e o app continuaria no escopo como sistema
que afeta a segurança do cartão.

**O que isto não muda:** o questionário PCI continua sendo o **SAQ D**, porque o cartão passa por um servidor controlado
pela loja/operador. O ganho é escopo menor (menos sistemas no ambiente do cartão), risco menor e menos requisitos
pesados no app principal. Só a página hospedada do Asaas levaria ao SAQ A; ela foi descartada pelo dono.

## Objetivos

- Nenhum byte de número, validade, CVV ou nome impresso do cartão chega ao app principal (Next), nem pela rede, nem
  pelo navegador (o app principal não roda JavaScript na página que tem os campos do cartão).
- O serviço de cartão é um processo e um container separados, com:
  - Node puro (sem Next, sem React no servidor);
  - um conjunto mínimo de dependências;
  - acesso restrito ao banco;
  - nada de painel, PDF, SMTP ou fila.
- A cobrança continua com a lógica atual de `src/lib/payments/asaas/card.ts`, que já passou por várias revisões:
  - tentativa idempotente com chave por tentativa;
  - consulta ao Asaas antes de tentar de novo;
  - limites por IP (/64 no IPv6), e-mail e impressão digital do cartão;
  - disjuntor por loja e Turnstile;
  - separação entre recusa e erro de integração;
  - resultado desconhecido liquidado pelo webhook.
- A experiência do comprador no celular continua a mesma: os mesmos campos, mensagens e passos, com o bloco do cartão
  dentro de um iframe que parece parte da página.
- Funciona nos dois modos: `MODE=single` (uma loja) e `MODE=multi` (várias lojas, domínios próprios ou subdomínios da
  plataforma).

## Fora do escopo

- Página de cartão hospedada do Asaas e tokenização do Asaas. A tokenização exige liberação conta a conta em produção,
  e cada loja usa o próprio Asaas.
- Mudar o tipo de questionário PCI (continua SAQ D).
- Pix (manual e Asaas), entrega, painel e webhook: não mudam, exceto o necessário para abrir o iframe e reagir ao
  resultado.
- Guardar cartão, compra com um clique, assinatura.
- Separar o serviço de cartão num host (máquina) diferente. Os dois containers continuam no mesmo servidor, então o
  sistema operacional do host segue no escopo; isso fica documentado como próximo passo possível.

## O que seria fracasso mesmo funcionando

- Qualquer caminho em que o cartão ainda passe pelo app principal: um campo esquecido, um fallback sem JS, um log ou
  uma rota antiga ativa.
- Cobrança em dobro ou pedido pago sem liberar (regressão da lógica atual).
- Exigir de cada loja uma configuração extra no Asaas.
- Queda de conversão no checkout por um iframe lento, com altura errada, com rolagem dupla ou que quebra no celular.

## Abordagens consideradas

1. **Separar só a rota que recebe o cartão** (mesmo código, outro container; o formulário continua no app). Simples,
   mas o app principal segue no escopo porque serve o JavaScript que coleta o cartão. Descartada pelo dono.
2. **Serviço isolado que serve o formulário em iframe e faz a cobrança inteira, com acesso restrito ao banco.**
   Reaproveita a lógica testada. O Postgres fica conectado ao serviço de cartão (no escopo como sistema conectado, sem
   guardar cartão). **Escolhida.**
3. **Serviço isolado sem banco, recebendo um "bilhete" assinado do app.** Escopo menor, mas obriga a reescrever
   idempotência, limites e resultado desconhecido em outro lugar, com risco de cobrança em dobro enquanto amadurece.
   Descartada.

Também descartada: tokenização do Asaas (liberação por conta, ver acima).

## Como funciona

### Componentes

- **Serviço de cartão** (`card`): processo Node HTTP próprio, num container próprio da mesma imagem-base (Node 22
  slim, tini, usuário não-root, sistema de arquivos só leitura, sem core dump, sem swap além da RAM). O código fica no
  mesmo repositório e reaproveita os módulos de `src/lib` necessários para a cobrança. É empacotado num artefato
  próprio que inclui só o que o serviço importa, nunca o build do Next. Ele serve:
  - `GET /pagar/<orderPublicId>`: a página do iframe com o formulário do cartão. HTML e JS próprios, pequenos, sem
    framework de front, com CSP estrita (nonce, `default-src 'none'`), `frame-ancestors` restrito à origem do checkout
    daquela loja e Turnstile quando a loja usa.
  - `POST /api/card`: recebe o JSON do cartão vindo do próprio iframe (mesma origem do serviço) e chama a lógica de
    `payWithCard`.
  - `GET /healthz`.
  - Nada mais. Qualquer outra rota responde 404.
- **App principal** (Next): continua dono do checkout (`/c/<oferta>`), do pedido (`/o/<id>`), do painel, do webhook e
  da fila. No método cartão, a página do checkout embute o iframe e conversa com ele por `postMessage`. A rota
  `POST /api/checkout/card` e o código de cartão dentro do Next são removidos ao fim da migração.
- **Caddy**: um site novo para o domínio do serviço de cartão, apontando só para `card`. Mantém HSTS e não roteia
  nenhuma outra coisa para lá. O domínio do app nunca é roteado para `card`, e o do cartão nunca para `app`.

### Domínios

- `MODE=single`: domínio do serviço de cartão em `CARD_DOMAIN`, por padrão `pagar.<DOMAIN>`. Exige um registro DNS a
  mais; o certificado é automático pelo Caddy.
- `MODE=multi`: um único domínio de cartão para a plataforma toda (`pagar.<PLATFORM_DOMAIN>`), atendendo lojas com
  domínio próprio e lojas em subdomínio. O vendedor não configura nada. O `frame-ancestors` e o destino do
  `postMessage` são calculados por pedido, a partir das origens cadastradas da loja dona do pedido.

### Fluxo do comprador

1. O comprador escolhe "Cartão" no checkout. O app mostra o iframe do serviço de cartão. Até o pedido existir, o
   iframe só mostra os campos (ainda não há `orderPublicId`); ver "O que fica para o construtor" sobre como carregar o
   iframe antes do pedido.
2. O comprador preenche os dados pessoais (nome, e-mail, WhatsApp, CPF) no formulário do app e os dados do cartão no
   iframe. **Vão para o iframe:**
   - número, nome impresso, validade e CVV;
   - parcelas;
   - "o titular é outra pessoa" e o CPF do titular;
   - CEP e número do endereço do titular.

   Assim o app principal não tem nenhum campo de pagamento.
3. Ao tocar em "Pagar":
   1. O app valida os dados pessoais e cria o pedido (`startCheckoutAction`, como hoje), recebendo o `orderPublicId`.
   2. O app manda ao iframe, por `postMessage` (origem conferida), a ordem de pagar com o `orderPublicId`.
   3. O iframe valida os campos do cartão e envia `POST /api/card` ao próprio serviço com a chave de idempotência da
      tentativa (mesma regra de hoje: a mesma tentativa reaproveita a chave se a rede cair).
   4. O serviço executa `payWithCard` e responde aprovado, recusado, desconhecido ou erro com campos.
   5. O iframe devolve ao app, por `postMessage` (destino exato: a origem do checkout da loja), só o resultado: status,
      últimos 4 dígitos para a mensagem de recusa, campos com erro, pedido de captcha. **Nunca o cartão.**
   6. O app navega para `/o/<id>` (aprovado ou desconhecido) ou mostra a recusa e os erros, como hoje.
4. O botão "Pagar" pode ficar no app (como hoje) ou dentro do iframe; ver "O que fica para o construtor".

### Identificação da loja e do pedido no serviço de cartão

- O serviço não resolve a loja pelo `Host` (o domínio é dele). Ele localiza o pedido pelo `orderPublicId` e só aceita
  pedido `card_asaas` pendente, como `payWithCard` já exige.
- Para não depender só de o `publicId` ser difícil de adivinhar, o app emite, junto com o pedido, um **bilhete curto
  assinado** (HMAC com chave própria, derivada só para isso) com:
  - loja;
  - pedido;
  - validade de alguns minutos.

  O iframe recebe o bilhete com a ordem de pagar e o envia no `POST /api/card`; o serviço confere antes de qualquer
  trabalho.
- O bilhete não carrega segredo nenhum (nem a chave do Asaas).
- A busca do pedido continua dentro do isolamento por loja (RLS): o bilhete diz a loja, e o serviço entra com o
  `app.store_id` dela.

### Banco e segredos do serviço de cartão

- **Papel próprio no Postgres (`card`):** sem bypass de RLS, com permissão só para o que a cobrança com cartão usa. Isso
  inclui:
  - ler pedido, oferta e cliente;
  - ler a conexão Asaas da loja;
  - gravar a tentativa de cartão, o pagamento e os limites;
  - mudar o status do pedido;
  - enfileirar os jobs que a confirmação do pagamento já enfileira hoje;
  - gravar os avisos ao vendedor e a auditoria que o fluxo já grava.

  O construtor levanta a lista exata pelos caminhos de código.
- **Proibido para esse papel:** usuários, sessões, membros, tentativas de login, conteúdo de produto/PDF e as outras
  conexões. SMTP e Meta guardam segredos.
- **Segredos:** o serviço não recebe o `SECRET` mestre. Recebe só:
  - a chave capaz de abrir a chave do Asaas das lojas (hoje todas as conexões são cifradas com uma chave derivada do
    `SECRET`; separar a chave da conexão Asaas das demais faz parte do trabalho);
  - a chave de verificação do bilhete;
  - as credenciais do papel `card`;
  - o segredo do Turnstile.

  Nenhum segredo de SMTP, Meta ou sessão do painel.

### Endurecimento e operação

- **Container `card` no `compose.yaml`:**
  - limite de memória próprio, pequeno;
  - `memswap_limit` igual ao limite;
  - `ulimits core 0`;
  - usuário não-root e raiz só leitura;
  - sem volume de dados;
  - rede interna só com Postgres e Caddy.
- **Saída de rede:** idealmente só Asaas, Turnstile e Postgres. O construtor decide se isso cabe no compose; se não
  couber, documenta como regra de firewall.
- **Logs:** os mesmos cuidados de hoje. `redact`, nunca o corpo da requisição, só códigos de erro.
- **Monitor semanal das páginas de pagamento (PCI 11.6.1):** passa a vigiar também a página do iframe:
  - cabeçalho CSP exato;
  - inventário de scripts: só os do próprio serviço com nonce, mais Turnstile.

  O checkout `/c` continua vigiado: ele não tem mais campos de cartão, mas embute o iframe, e a CSP dele ganha
  `frame-src` para o domínio do cartão.
- **Documentação:**
  - `docs/seguranca-pagamento.md` com o escopo novo: CDE = container `card`, Caddy, host; Postgres conectado; app
    principal como sistema que conecta ao CDE pelo banco e pelo iframe;
  - `docs/instalacao.md` com o DNS extra e as variáveis novas;
  - `docs/migracao-cakto.md`, se o passo a passo do cartão mudar.

## Entrega em etapas (regra de PRs separados para verificação)

O `CLAUDE.md` proíbe um PR que mude ao mesmo tempo código de produto e as verificações (`e2e/`, `.github/`,
`scripts/verify*`, `.claude/`, `REVIEW.md`). O E2E atual testa o cartão pela rota antiga. Por isso:

1. **PR de produto:**
   - serviço de cartão;
   - iframe no checkout;
   - container e Caddy;
   - papel `card`;
   - docs.

   Tudo atrás de uma configuração (por exemplo `CARD_ISOLATED=1`), desligada por padrão; com ela desligada, o fluxo
   antigo segue igual e o E2E atual passa. Testes de unidade e integração do serviço novo entram aqui (`tests/` não é
   área de verificação).
2. **PR de verificação:**
   - E2E e smoke de deploy passam a testar o fluxo com iframe (configuração ligada), inclusive a prova de que o app
     principal não recebe o cartão (ver abaixo);
   - o verify sobe o container `card`.
3. **PR de produto:**
   - configuração ligada por padrão;
   - remoção da rota `POST /api/checkout/card` e do código de cartão do bundle do Next;
   - a CSP de `/c` deixa de permitir envio de cartão ao próprio domínio.

## Como provar que deu certo

- **E2E:** com o Playwright interceptando todas as requisições ao domínio do app durante um pagamento com cartão,
  nenhuma carrega número, CVV ou validade, nem no corpo, nem na URL, nem em cabeçalho. Os campos do cartão existem só
  dentro do iframe, servido pelo domínio do cartão.
- **Teste de build:** o bundle do Next não contém a rota nem o módulo de cobrança com cartão (depois da etapa 3).
- **Testes do serviço:**
  - bilhete inválido, vencido ou de outra loja é recusado antes de qualquer consulta;
  - `Origin` diferente do próprio serviço é recusado;
  - CSP e `frame-ancestors` corretos por loja;
  - `postMessage` só para a origem da loja;
  - o papel `card` não consegue ler usuários, sessões nem as outras conexões.
- **Regressão:** os testes atuais de `card.test.ts` (idempotência, resultado desconhecido, limites, disjuntor,
  parcelado) continuam passando, agora contra o serviço.
- **Sandbox real do Asaas:** pagamento aprovado e parcelado pelo iframe.

## Decidido pelo dono

- Isolar o cartão, não usar a página hospedada do Asaas.
- O formulário do cartão fica dentro do serviço isolado (iframe), não no app.
- O serviço faz a cobrança inteira com acesso restrito ao banco, sem bilhete-only.

## Decisões minhas (o dono pode corrigir)

- Node puro no serviço de cartão, sem Next, para reduzir dependências e superfície.
- Domínio do cartão: `pagar.<DOMAIN>` no single, um único `pagar.<PLATFORM_DOMAIN>` no multi.
- Dados do titular (CPF do titular, CEP, número) passam para o iframe junto com o cartão.
- Bilhete assinado do app para o serviço, além da checagem atual do pedido.
- Entrega em três PRs, com a configuração desligada por padrão no primeiro.

## O que fica para o construtor

- Empacotamento do serviço: como gerar o artefato só com o que ele importa, e como manter o mesmo código de
  `card.ts` usado pelos testes.
- Carregar o iframe antes de o pedido existir (formulário vazio com bilhete chegando depois) ou só depois de o
  comprador tocar em "Pagar". O critério é a experiência: o comprador digita o cartão antes de tocar em "Pagar", como
  hoje.
- Posição do botão "Pagar" (no app mandando a ordem ao iframe, ou no iframe), desde que a validação dos dados pessoais
  continue antes da criação do pedido.
- Altura do iframe (redimensionamento por `postMessage`) e estilos espelhando o design atual do checkout.
- Lista exata de permissões do papel `card` e como separar a chave da conexão Asaas das demais, inclusive a migração
  das conexões já cifradas.
- Duração do bilhete e como renovar se o comprador demorar.
- Como o ambiente de desenvolvimento e o verify sobem o serviço (`compose.dev.yaml`, portas, Asaas falso).
