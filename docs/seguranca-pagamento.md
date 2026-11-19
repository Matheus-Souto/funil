# Segurança das páginas de pagamento

Páginas do comprador: `/c/<oferta>` (checkout: nome, e-mail, celular, CPF e, no cartão, número, validade e CVV) e
`/o/<pedido>` (pedido e obrigado). Com o cartão isolado (`CARD_ISOLATED=1`), os campos do cartão saem do checkout e vão
para a página do iframe, `CARD_ORIGIN/form/<loja>`, servida pelo container `card` (seção "Cartão isolado"). Referências: PCI DSS 4.0 requisitos 6.4.3 (inventário, autorização e integridade
dos scripts da página de pagamento) e 11.6.1 (detecção de mudanças nos cabeçalhos de segurança e scripts).

## Escopo PCI real: SAQ D (o cartão passa pelo servidor)

No cartão "transparente", o navegador envia número, validade e CVV em JSON para `POST /api/checkout/card`; o processo
Node do app recebe, valida e repassa ao Asaas. Nada disso é gravado (banco, log, fila, cache, mensagem de erro: ver
`src/lib/payments/asaas/card.ts`), mas **transmitir e processar** PAN/CVV coloca o sistema inteiro no ambiente de
dados do titular (CDE). Por isso:

- **Questionário de autoavaliação: SAQ D** (não SAQ A nem A-EP, que valem só quando a página não envia o cartão ao
  servidor da loja). Os requisitos 6.4.3 e 11.6.1 abaixo continuam valendo, mas são uma parte pequena do SAQ D.
- **Tudo o que roda no mesmo servidor entra no escopo:** o processo Node (que também serve o painel, valida PDFs
  enviados pelo vendedor, fala SMTP e roda a fila), o Caddy (termina o TLS), o Postgres na mesma rede do compose, o
  sistema operacional do host, a memória, o swap e os core dumps. Uma falha em qualquer um (pacote npm do painel
  comprometido, PDF malicioso que escape do worker, acesso ao host) expõe os cartões em trânsito de todas as lojas.
- **`MODE=multi`: o operador da instalação vira provedor de serviço** que processa cartões de terceiros (as lojas).
  Isso exige o SAQ D para provedores de serviço (ou o relatório de conformidade feito por auditor, o ROC, conforme o
  volume anual de transações), contratos com cada loja dizendo quais requisitos são responsabilidade de quem, e
  teste de invasão e varredura trimestral de vulnerabilidades (ASV) da instalação.
- **O que isso implica para quem instala:** servidor dedicado ao app (nada mais rodando nele), sistema e imagens
  atualizados todo mês (`docs/instalacao.md`, "Atualizar"), acesso SSH só por chave e com poucas pessoas, firewall
  liberando só 80/443 (e, com Cloudflare, só as faixas dela), registro de quem acessa o servidor, backups cifrados,
  `SECRET` guardado fora dos backups e varredura de vulnerabilidades periódica. A adquirente ou bandeira pode pedir o
  questionário: responda com o escopo acima, não com o de SAQ A.
- **Endurecimento já feito na instalação padrão:** o container do app roda sem core dump (`ulimits core 0` no
  `compose.yaml`, e `ulimit -c 0` no entrypoint) e sem swap além da RAM do container (`memswap_limit` igual ao
  `mem_limit`: a memória do app nunca vai para o swap do host), usuário não-root, código só leitura, papel do banco
  sem acesso às tabelas de outras lojas. **No host:** o swap que o guia cria serve à montagem da imagem; com RAM de
  sobra, desligue-o depois (`swapoff -a` e remova a linha do `/etc/fstab`) ou use swap cifrado. Não tire o
  `memswap_limit` nem o `ulimits` do `compose.yaml`.
- **Próximo passo:** ligar o cartão isolado (seção abaixo), que tira o cartão do processo principal. Enquanto ele
  estiver desligado (`CARD_ISOLATED=0`, o padrão), o escopo é o descrito aqui.

## Cartão isolado (`CARD_ISOLATED=1`): escopo novo

Com o isolamento ligado (passo a passo em `docs/instalacao.md`, seção 12), o comprador digita o cartão num iframe do
domínio `pagar.` (`CARD_ORIGIN`), servido pelo container `card`: um processo Node pequeno (`src/card-service/`), sem
painel, PDF, SMTP nem Meta, que recebe o `POST /api/card` e cobra no Asaas. O app (Next) nunca recebe número, validade,
CVV nem nome impresso (nem por rede, URL, cabeçalho, `postMessage` ou bundle); ele só emite um bilhete assinado do
pedido (`CARD_TICKET_KEY`) e recebe do iframe o resultado (aprovado, recusado).

- **Continua SAQ D** (o cartão passa por um servidor da instalação), mas com escopo menor:
  - **CDE (ambiente do cartão):** o container `card`, o Caddy (termina o TLS do `pagar.`) e o host (sistema, memória,
    swap, Docker);
  - **Postgres: sistema conectado** (o `card` lê e grava pedidos e tentativas pelo papel `card`; nenhum dado do
    cartão vai para o banco);
  - **app (Next): sistema conectado** ao CDE pelo banco (cria o pedido que o `card` cobra) e pela página que embute o
    iframe. Um app comprometido não lê o cartão (o iframe é outra origem), mas pode tentar enganar o comprador na
    própria página; por isso o checkout continua com CSP e monitor.
- **O que o `card` recebe** (`compose.yaml`): `SERVICE=card`, o papel `card` do banco, `CARD_ORIGIN`,
  `CARD_TICKET_KEY`, `ASAAS_SEAL_KEY`, `TRUST_PROXY`, o Turnstile, `MODE`, `PLATFORM_DOMAIN` e `BASE_URL`. Nunca o
  `SECRET`, o papel dono, a senha do papel `app` nem credenciais de SMTP/Meta (o serviço recusa subir com elas).
- **Endurecimento do container:** sem volume, raiz só leitura (`/tmp` em memória), 192 MB sem swap além da RAM, sem
  core dump, usuário não-root, sem capabilities (`cap_drop: ALL`), `no-new-privileges` (um binário setuid da imagem
  base não vira root), no máximo 64 processos, imagem só com o bundle do serviço (sem `node_modules`). Rede `card`
  própria, só com o Postgres e o Caddy: o `card` não alcança o app diretamente (só pelo Caddy, pelo domínio público,
  como qualquer visitante). A senha do papel `card` precisa ser diferente das do `app` e do dono (o entrypoint recusa). O Caddy só encaminha `/form/*`, `/form.js`, `/form.css` e
  `/api/card` do domínio do cartão para o `card`, e nada mais vai para ele.
- **Papel `card` no Postgres** (`src/lib/db/rls.sql`, `card_role_grants`): sem `BYPASSRLS`, só o necessário para cobrar.
  Tabelas novas não ganham permissão para ele.

**Limites conhecidos** (do desenho; aceitos):

- O `card` lê a chave de API do Asaas **de qualquer loja** (e `id`, `slug` e `domain` da lista de lojas): ele precisa
  cobrar por qualquer loja da instalação. Um `card` comprometido com a `ASAAS_SEAL_KEY` abre essas chaves.
- Um `card` comprometido consegue, no banco, **só marcar como pago um pedido de cartão pendente** (gatilho
  `orders_card_guard`: nunca tira de pago, nunca mexe em pedido de Pix), gravar tentativas e cobranças de cartão, os
  ids do Asaas do comprador, avisos do disjuntor e auditoria. Não lê usuários, sessões, produtos, PDFs nem as outras
  conexões (SMTP, Meta).
- **Saída de rede do `card`:** o compose não consegue limitar destinos por nome. A regra é: o container `card` só fala
  com o **Asaas** (`api.asaas.com`, e `api-sandbox.asaas.com` em testes), o **Turnstile** (`challenges.cloudflare.com`)
  e o **Postgres** (rede interna). Aplique no firewall do host (cadeia `DOCKER-USER`, a sub-rede da rede `funil_card`
  vem de `docker network inspect funil_card`) ou num proxy de saída; no mínimo, só TCP 443 e DNS para fora. Isto é
  requisito do escopo acima (PCI 1.3), não opcional.

**Avisos operacionais:**

- **A `ASAAS_SEAL_KEY` não pode mudar nem sumir** depois que o app re-selou as conexões (primeira subida com
  `CARD_ISOLATED=1`). O app e o `card` recusam subir com "ASAAS_SEAL_KEY ausente ou diferente da que selou a conexão
  Asaas de N loja(s); restaure a chave correta". Guarde-a com o `SECRET`, fora dos backups.
- **A `ASAAS_SEAL_KEY` só tem efeito com `CARD_ISOLATED=1`.** Com `CARD_ISOLATED=0` o app grava a chave do Asaas com
  o `SECRET` (`v1`), mesmo com a `ASAAS_SEAL_KEY` presente; só com `CARD_ISOLATED=1` ela passa a ser cifrada com a
  chave própria (`a1`) e a re-selagem roda.
- **Rollback:** voltar para `CARD_ISOLATED=0` na mesma versão é seguro (o app ainda abre `a1` com a chave). Voltar
  para uma **imagem anterior ao isolamento** trava o Asaas das lojas re-seladas (ela não conhece `a1`). Rollback
  preventivo: desligue o isolamento na versão atual, cole de novo a chave de API do Asaas de cada loja em Conexões
  (com o isolamento desligado ela é gravada em `v1`) e só então volte a imagem. Se já voltou, cole a chave do mesmo
  jeito. Desligando de vez: `alter role card nologin` (`docs/instalacao.md`, seção 12).
- **Cloudflare:** o checkout e o `pagar.` com o mesmo estado de proxy (o `TRUST_PROXY` é um só para o app e o `card`)
  e sem recursos que injetam scripts (Rocket Loader, Email Obfuscation, JS Detections, Zaraz, Web Analytics
  automático): ver `docs/instalacao.md`, seção 12.
- **Restore de backup:** precisa do mesmo `SECRET` e da mesma `ASAAS_SEAL_KEY`. Os erros de `CREATE POLICY ... TO
  card` ("role does not exist") e o "errors ignored on restore" no `pg_restore` são esperados (`docs/instalacao.md`,
  seção 10); a migração do app recria o papel `card` (com login, se houver `CARD_DB_PASSWORD`) ao iniciar.

## Monitor semanal em produção (11.6.1)

Além do smoke E2E antes de cada deploy, o job `pci_page_monitor` (`src/lib/security/page-monitor.ts`) roda **toda
semana** em produção. Para cada loja, ele busca no próprio domínio da loja o checkout de uma oferta ativa
(`/c/<slug>`, de preferência com cartão) e a página do pedido mais recente (`/o/<id>`) e confere:

- o cabeçalho `Content-Security-Policy` é exatamente a política gerada pelo app (abaixo), com nonce (com o cartão
  isolado, a que tem `frame-src` do domínio do cartão);
- o inventário de scripts do HTML: só `/_next/static/*` do próprio domínio, `https://connect.facebook.net` e (com
  Turnstile) `https://challenges.cloudflare.com`; todo script inline com o nonce daquela resposta.

Com o cartão isolado (`CARD_ISOLATED=1`), confere também a página do iframe de cada loja, `CARD_ORIGIN/form/<loja>`
(página `/form`):

- o cabeçalho `Content-Security-Policy` é exatamente o de `cardFormCsp` (`src/card-service/page.ts`), com o
  `frame-ancestors` das origens do checkout da loja;
- o inventário de scripts: só `/form.js` do domínio do cartão e (com Turnstile) `https://challenges.cloudflare.com`;
  nenhum script inline executável (a configuração vai num `<script type="application/json">`, que não executa);
- o sha256 do conteúdo do `/form.js` baixado, que entra no inventário: o mesmo caminho com outro conteúdo (skimmer
  servido por um Caddy ou host comprometido) avisa com `inventario_mudou`. Cada atualização que mude o formulário
  também avisa uma vez: confira que a mudança veio da atualização. Se o `/form.js` não responder, a página não é
  conferida nessa semana (só log).

O resultado (um hash do cabeçalho normalizado e do inventário, e os códigos de problema) fica em `page_check`. Quando
muda, o vendedor recebe um aviso no painel e por e-mail (`monitor_pagina_pagamento`, com a página, `/c`, `/o` ou
`/form`, e o código: `csp_ausente`, `csp_diferente`, `script_nao_autorizado`, `script_sem_nonce`, `script_inline` ou
`inventario_mudou`). Ligar o isolamento muda a política do checkout (entra o `frame-src`): o aviso de `/c` sai uma vez. Uma atualização do
sistema que mude a política ou os scripts também dispara o aviso uma vez: confira que a mudança veio da atualização.
Página fora do ar ou resposta diferente de 200 só vai para o log (não é mudança de página). O servidor precisa
conseguir acessar o próprio domínio público (o normal numa VPS); se não conseguir, o log mostra "página
indisponível" toda semana.

## Política de segurança de conteúdo (CSP)

Aplicada por `src/proxy.ts` só em `/c/*` e `/o/*`, com nonce novo a cada requisição (o Next aplica o nonce aos próprios
scripts; as páginas são dinâmicas):

```
script-src 'self' 'nonce-<aleatório>' https://connect.facebook.net [https://challenges.cloudflare.com]
connect-src 'self' https://www.facebook.com https://connect.facebook.net
img-src 'self' data: https://www.facebook.com
[frame-src https://challenges.cloudflare.com]
frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'
```

Os itens entre colchetes só entram com o Turnstile configurado (`TURNSTILE_SITE_KEY`). Com o cartão isolado, o
`frame-src` ganha também o `CARD_ORIGIN` (o checkout embute o iframe). Em `next dev` entra também
`'unsafe-eval'` (o React usa eval para as pilhas de erro; nunca em produção). O smoke E2E reprova qualquer violação
de CSP no console nas páginas do comprador e confere o cabeçalho (nonce diferente a cada requisição; painel sem CSP de
comprador). Mudar esta política é mudança de verificação: revisar junto com este inventário.

Página do iframe do cartão (`CARD_ORIGIN/form/<loja>`, gerada por `cardFormCsp`), sem nonce porque não tem script
inline executável:

```
default-src 'none'; script-src 'self' [https://challenges.cloudflare.com]; style-src 'self'; connect-src 'self';
[frame-src https://challenges.cloudflare.com;] img-src 'self' data:; base-uri 'none'; form-action 'none';
frame-ancestors <origens do checkout da loja>
```

## Inventário de scripts da página de pagamento

| Script | Origem | Quando carrega | Justificativa | Controle |
|---|---|---|---|---|
| Runtime do Next.js/React e chunks da página (`/_next/static/...`) | própria (`'self'`) | sempre | renderização e formulário do checkout | build do próprio app; servido pelo próprio domínio |
| Scripts inline do Next (dados do RSC, `self.__next_f`) | própria, inline | sempre | hidratação das páginas | só executam com o nonce da requisição |
| Meta Pixel `fbevents.js` (e a configuração do pixel que ele busca) | `https://connect.facebook.net` | só com Pixel configurado (oferta ou loja) | medir anúncios (spec 7.8: InitiateCheckout, AddPaymentInfo, Purchase; deduplicado com a API de Conversões) | `fbq('set','autoConfig',false,<pixel>)` antes do `init` (desliga a configuração automática de eventos: cliques em botões e metadados da página); a correspondência avançada automática (leitura de e-mail/telefone digitados) NÃO é coberta pelo autoConfig e fica desligada no Gerenciador de Eventos (seção abaixo); eventos só com `currency`, `value` e `payment_type` (tipados como valores simples em `src/lib/tracking/fbq.ts`); nenhum dado do formulário; carregado por código próprio (`src/lib/tracking/fbq.ts`), sem HTML inline |
| Cloudflare Turnstile `api.js` | `https://challenges.cloudflare.com` | só se configurado E a API do cartão pedir o desafio (muitas tentativas) | antifraude de teste de cartões | o desafio roda em iframe da Cloudflare; script e frame só dessa origem |
| Formulário do cartão `form.js` (página do iframe, cartão isolado) | domínio do cartão (`CARD_ORIGIN`, `'self'` do iframe) | com `CARD_ISOLATED=1`, na página `/form/<loja>` | campos do cartão e envio ao `POST /api/card` do mesmo domínio | build do próprio projeto (`bun run card:build`), servido só pelo container `card`; único `fetch` relativo (`/api/card`) |

Não há outros scripts de terceiros. `public/t.js` NÃO roda nestas páginas: ele é embutido pelo vendedor na página de
vendas externa. O painel (`/admin`) e o download (`/d/<token>`) não carregam o Pixel nem terceiros (o download tem CSP
própria, `default-src 'none'`).

## Dados enviados ao Meta

- Navegador (Pixel): eventos com `eventID` e só moeda, valor e método de pagamento.
- Servidor (API de Conversões, `src/lib/tracking/meta.ts`): e-mail, celular, nome, país e id do cliente em SHA-256
  (normalizados conforme a documentação do Meta); IP, user agent, `fbc` e `fbp` sem hash; valor, moeda, ids dos
  produtos e o id público do pedido. Nunca dados de cartão nem CPF. Token só no header `Authorization: Bearer`.
- Reembolso não é enviado. Purchase só sai com o pedido ainda pago no momento do envio.

## Ação obrigatória do dono no Meta

O `autoConfig` desligado não controla a **correspondência avançada automática** (Automatic Advanced Matching): esse
recurso só é configurado no Meta. Ligado, o Pixel pode ler campos de e-mail e telefone digitados no checkout e enviá-los
(com hash) ao Meta pelo navegador. Desligue em: Gerenciador de Eventos → pixel da loja → **Configurações** →
**Correspondência avançada automática** → desligado. Os dados do comprador já vão ao Meta pelo servidor (API de
Conversões, acima), com hash e sem nada do cartão. Passo a passo em `docs/instalacao.md` (seção 8).

A CSP foi testada com um Pixel falso (o smoke E2E não chama o Meta): depois de publicar, abra o checkout no navegador
com o Pixel real e confira que o console não mostra violações de CSP.

