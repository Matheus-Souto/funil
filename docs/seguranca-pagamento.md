# Segurança das páginas de pagamento

Páginas do comprador: `/c/<oferta>` (checkout: nome, e-mail, celular, CPF e, no cartão, número, validade e CVV) e
`/o/<pedido>` (pedido e obrigado). Os campos do cartão não ficam no checkout: ficam na página do iframe,
`CARD_ORIGIN/form/<loja>`, servida pelo container `card` (seção "Cartão isolado"). Referências: PCI DSS 4.0 requisitos 6.4.3 (inventário, autorização e integridade dos scripts da página de
pagamento) e 11.6.1 (detecção de mudanças nos cabeçalhos de segurança e scripts).

## Escopo PCI real: SAQ D (o cartão passa pelo servidor)

No cartão "transparente", o navegador envia número, validade e CVV em JSON ao `POST /api/card` do serviço de cartão
(`card`, no domínio `pagar.`), que valida e repassa ao Asaas. Nada disso é gravado (banco, log, fila, cache, mensagem
de erro: ver `src/lib/payments/asaas/card.ts`), mas **transmitir e processar** PAN/CVV num servidor da instalação
coloca esse servidor inteiro no ambiente de dados do titular (CDE). Por isso:

- **Questionário de autoavaliação: SAQ D** (não SAQ A nem A-EP, que valem só quando a página não envia o cartão ao
  servidor da loja). Os requisitos 6.4.3 e 11.6.1 abaixo continuam valendo, mas são uma parte pequena do SAQ D.
- **Tudo o que roda no mesmo servidor entra no escopo:** o `card`, o app (que serve o checkout que embute o iframe,
  o painel, valida PDFs enviados pelo vendedor, fala SMTP e roda a fila), o Caddy (termina o TLS), o Postgres na mesma
  rede do compose, o sistema operacional do host, a memória, o swap e os core dumps. Uma falha em qualquer um (pacote
  npm do painel comprometido que troque o iframe por um formulário falso, acesso ao host) expõe os cartões de todas as
  lojas.
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
- **Próximo passo:** o cartão isolado (seção abaixo) já tira o cartão do processo principal, mas no mesmo servidor o
  escopo continua o descrito aqui (a seção abaixo explica por quê); o que reduz o escopo é o `card` num host separado
  com teste de segmentação.

## Cartão isolado: como funciona

O cartão é sempre digitado num iframe do domínio `pagar.` (`CARD_ORIGIN`; passo a passo em `docs/instalacao.md`,
seção 12), servido pelo container `card`: um processo Node pequeno (`src/card-service/`), sem painel, PDF, SMTP nem
Meta, que recebe o `POST /api/card` e cobra no Asaas. Sem `CARD_ORIGIN`, a instalação não oferece cartão (só Pix). O
E2E de cada versão faz a compra com cartão por esse iframe. O app (Next) não recebe
número, validade, CVV nem nome impresso (nem por URL, cabeçalho, `postMessage` ou bundle); ele só emite um bilhete
assinado do pedido (`CARD_TICKET_KEY`, com o total e as parcelas que o iframe confere) e recebe do iframe o resultado
(aprovado, recusado). A rota antiga (`POST /api/checkout/card`) saiu do app (o build é conferido: nenhum arquivo do
servidor do Next tem a rota nem a cobrança); uma rota de API inexistente responde 404 sem corpo e sem ler a
requisição. O Caddy da instalação padrão (`deploy/Caddyfile` e `deploy/Caddyfile.multi`) corta essa rota antes do
app. Numa cópia `Caddyfile.local` sem esse bloco (ou com outro proxy na frente), os bytes que uma aba aberta antes da
atualização mandar ainda chegam ao socket do Next, que os descarta sem ler.

### Escopo: menos risco, o mesmo escopo enquanto tudo estiver no mesmo servidor

- **Continua SAQ D** (o cartão passa por um servidor da instalação) e, **no mesmo servidor, o escopo não diminui.** O
  app e o `card` dividem host, kernel, Docker e Caddy: quem compromete qualquer um deles alcança o cartão, venha o
  ataque do app ou de fora. O app segue no escopo como sistema conectado ao ambiente do cartão e que afeta a
  segurança dele: serve a página que embute o iframe (um app comprometido troca o iframe por um formulário falso),
  tem a `CARD_TICKET_KEY` (emite bilhetes) e a `ASAAS_SEAL_KEY` (abre a chave de API do Asaas de todas as lojas) e
  roda o monitor 11.6.1.
- **O ganho é de risco:** número, validade e CVV não passam mais pelo processo que serve o painel, valida PDFs, fala
  SMTP e roda a fila. Uma falha nessas partes (pacote npm do painel, PDF malicioso) não lê o cartão em trânsito sem
  antes sair do processo do app.
- **Componentes:**
  - ambiente do cartão (CDE): o container `card`, o Caddy (termina o TLS do `pagar.`) e o host (sistema, Docker,
    memória, swap);
  - conectados ou que afetam a segurança do CDE: o app (Next) e o Postgres (o `card` lê e grava pedidos e tentativas
    pelo papel `card`; nenhum dado do cartão vai para o banco);
  - prestadores de serviço com acesso ao cartão ou ao ambiente (12.8: liste-os com o atestado PCI de cada um): o
    **Asaas**, o provedor do servidor (VPS) e, com o proxy da Cloudflare (nuvem laranja) ligado no `pagar.`, a
    **Cloudflare**: ela termina o TLS e vê o número do cartão em claro. Como o checkout e o `pagar.` precisam do mesmo
    estado de proxy (seção 12 da instalação), com a nuvem laranja no checkout ela entra nesta lista.
- **Próximo passo (exigido pela spec para reduzir o escopo):** o `card` num **host separado**, com Caddy próprio, sem
  nada do app. Só então o app sai do CDE, e só depois do **teste de segmentação** (11.4.5) que comprove que o resto
  não alcança o ambiente do cartão; no `MODE=multi` (provedor de serviço), o teste de segmentação se repete **a cada 6
  meses** (11.4.6). Sem o teste, responda ao questionário com o escopo do servidor inteiro.
- **Escopo confirmado todo ano (12.5.2) e diagrama de fluxo de dados atualizado (1.2.4):** revise esta seção e o
  diagrama abaixo pelo menos uma vez a cada 12 meses e a cada mudança significativa (configurar ou tirar o cartão,
  trocar de servidor, ligar o proxy da Cloudflare, levar o `card` para outro host). Registre a data e quem revisou.

Fluxo de dados do cartão (o mesmo servidor; `[CDE]` marca o que vê o cartão em claro):

```
 navegador do comprador
   |  checkout da loja (app)                      iframe pagar.<domínio>
   |  nome, e-mail, celular, CPF                  número, validade, CVV, nome impresso
   v                                               v
 [CDE] Caddy :443 (TLS do checkout)             [CDE] Caddy :443 (TLS do pagar.) ---(proxy da Cloudflare? [CDE])
   |                                               |  só /form/*, /form.js, /form.css, /api/card
   v                                               v
 app (Next) ---- bilhete do pedido ----------> [CDE] card (Node) ---- HTTPS ----> Asaas (prestador, 12.8)
   |  (o bilhete vai pelo navegador: pay)          |  papel `card`
   v                                               v
 Postgres  <------------------------------------- Postgres (pedidos, tentativas; nunca o cartão)
 host, kernel, Docker e memória: [CDE] (dividido por todos acima)
```

### O `card` por dentro

- **O que o `card` recebe** (`compose.yaml`): `SERVICE=card`, o papel `card` do banco, `CARD_ORIGIN`,
  `CARD_TICKET_KEY`, `ASAAS_SEAL_KEY`, `TRUST_PROXY`, as duas chaves do Turnstile, `MODE`, `PLATFORM_DOMAIN` e
  `BASE_URL`. Nunca o `SECRET`, o papel dono nem a senha do papel `app`: o serviço recusa subir com `SECRET`,
  `OWNER_DATABASE_URL` ou `APP_DB_PASSWORD` no ambiente. As credenciais de SMTP e Meta não vêm do ambiente em
  nenhum dos dois serviços (ficam no banco, cifradas com o `SECRET`, que o `card` não tem, e o papel `card` só
  enxerga a conexão do Asaas).
- **Endurecimento do container:** sem volume, raiz só leitura (`/tmp` em memória), 192 MB sem swap além da RAM, sem
  core dump, usuário não-root, sem capabilities (`cap_drop: ALL`), `no-new-privileges` (um binário setuid da imagem
  base não vira root), no máximo 64 processos, imagem só com o bundle do serviço (sem `node_modules`). Rede `card`
  própria, só com o Postgres e o Caddy: o `card` não alcança o app diretamente (só pelo Caddy, pelo domínio público,
  como qualquer visitante). A senha do papel `card` precisa ser diferente das do `app` e do dono (o entrypoint
  recusa). O Caddy só encaminha `/form/*`, `/form.js`, `/form.css` e `/api/card` do domínio do cartão para o `card`,
  lê o corpo inteiro antes de repassar (um corpo enviado devagar não prende as conexões do serviço) e nada mais vai
  para ele.
- **Papel `card` no Postgres** (`src/lib/db/rls.sql`, `card_role_grants`): sem `BYPASSRLS`, só o necessário para
  cobrar e no máximo 10 conexões. O `statement_timeout` padrão de 10 s do papel só corta consultas presas por erro do
  próprio serviço: **não é controle contra um `card` comprometido**, que o desfaz com `SET statement_timeout` na
  sessão dele (o teto de conexões vale, porque é do papel). Tabelas novas não ganham permissão para ele.
- **Turnstile:** o token só vale se o siteverify da Cloudflare disser que o desafio foi resolvido num host do checkout
  da loja do pedido (`hostname` da resposta): um token resolvido em outro site com a mesma chave de site, ou no
  checkout de outra loja da plataforma, é recusado.

**Limites conhecidos** (do desenho; aceitos):

- O `card` lê a chave de API do Asaas **de qualquer loja** (e `id`, `slug` e `domain` da lista de lojas): ele precisa
  cobrar por qualquer loja da instalação. Um `card` comprometido com a `ASAAS_SEAL_KEY` abre essas chaves, e a chave
  de API do Asaas permite mais que cobrar (inclusive transferir o saldo da loja): ver "`card` comprometido" abaixo.
- Um `card` comprometido consegue, no banco: marcar como pago **só um pedido de cartão pendente ou expirado** (gatilho
  `orders_card_guard`: nunca tira de pago, nunca mexe em pedido de Pix); **inserir cobranças (`payment`) em qualquer
  pedido da loja e mudar o status de qualquer `payment`** (não só os de cartão); gravar tentativas, os ids do Asaas
  do comprador, avisos do disjuntor e auditoria. Não lê usuários, sessões, produtos, PDFs nem as outras conexões
  (SMTP, Meta).

**Regras a configurar no servidor** (o compose não as aplica; são requisito do escopo acima, PCI 1.3, não opcionais):

- **Saída de rede do `card`:** o compose não consegue limitar destinos por nome. A regra é: o container `card` só fala
  com o **Asaas** (`api.asaas.com`, e `api-sandbox.asaas.com` em testes), o **Turnstile** (`challenges.cloudflare.com`,
  onde o `card` confere o token) e o **Postgres** (rede interna). Aplique no firewall do host (cadeia `DOCKER-USER`, a
  sub-rede da rede `funil_card` vem de `docker network inspect funil_card`) ou num proxy de saída; no mínimo, só TCP
  443 e DNS para fora.
- **Entrada no Postgres vinda da rede `card`:** hoje o Postgres aceita qualquer papel de qualquer rede do compose (só
  a senha separa). Da sub-rede `funil_card`, só o papel `card` no banco `funil`; o resto, recusado. Num
  `pg_hba.conf` próprio (montado no container `postgres`), antes da linha geral:

  ```
  host  funil  card  <sub-rede da funil_card>  scram-sha-256
  host  all    all   <sub-rede da funil_card>  reject
  ```

### `card` comprometido: o que trocar

Suspeita de invasão do `card` (ou do host): guarde os logs antes de qualquer coisa
(`docker compose logs --no-color --timestamps card > card-incidente.log`, fora do servidor) e então:

1. **Chave de API do Asaas de todas as lojas:** gere uma nova no Asaas de cada loja e cole em Conexões → Asaas. A
   chave antiga permite transferir o saldo: troque primeiro as lojas com saldo. Nas configurações de segurança da
   conta Asaas, quando disponíveis, restrinja o uso da chave de API ao IP do servidor e exija aprovação para
   transferências.
2. **`CARD_TICKET_KEY`:** valor novo no `.env` e reinicie o app e o `card` juntos (`docker compose up -d app card`).
   Os bilhetes antigos param de valer; quem estava no meio da compra recebe um bilhete novo ou a mensagem genérica.
3. **`CARD_DB_PASSWORD`:** valor novo no `.env` e `docker compose up -d` (a migração do app troca a senha do papel
   `card`; o `card` reinicia com ela).
4. **Chave secreta do Turnstile** (`TURNSTILE_SECRET`): gere outra no painel da Cloudflare e troque no `.env`.
5. **`ASAAS_SEAL_KEY`:** não há rotação automática (limitação conhecida). Com o `card` comprometido, a chave vazou junto
   com acesso de leitura às conexões; o que protege as lojas é o item 1. Para trocá-la mesmo assim:
   `docker compose stop card`, `docker compose exec app asaas-unseal` (volta tudo para `v1`, com o `SECRET`; a saída
   vai para o terminal), troque a `ASAAS_SEAL_KEY` no `.env` e `docker compose up -d`: no boot, o app re-sela tudo com
   a chave nova e o `card` volta com ela. Entre a CLI e a subida, o cartão responde "indisponível" (sem cobrança).

**Avisos operacionais:**

- **A `ASAAS_SEAL_KEY` não pode mudar nem sumir** depois que o app re-selou as conexões (primeira subida com ela). O app e o `card` recusam subir com "ASAAS_SEAL_KEY ausente ou diferente da que selou a conexão
  Asaas de N loja(s); restaure a chave correta". Guarde-a com o `SECRET`, fora dos backups. (Troca planejada: item 5
  acima.)
- **Com a `ASAAS_SEAL_KEY` definida**, o app grava a chave do Asaas cifrada com ela (`a1`) e, a cada início, re-sela
  as que ainda estão com o `SECRET` (`v1`). O `card` não abre `v1`: o boot dele registra quantas conexões ainda estão
  assim, e o pagamento dessas lojas responde "indisponível" (sem cobrança) até o próximo início do app.
- **Rollback:** voltar para a versão anterior desta (com `CARD_ISOLATED`) é seguro: ela abre `a1` com a chave. Voltar
  para uma **imagem anterior ao isolamento** trava o Asaas das lojas re-seladas (ela não conhece `a1`). Rollback: com o
  app desta versão no ar, rode a CLI `asaas-unseal` (`docker compose exec app asaas-unseal`; regrava `a1` em `v1` com o
  `SECRET`, loja a loja, idempotente, só contagens, no terminal de quem roda) e troque a imagem logo em seguida (esta
  versão re-sela tudo em `a1` a cada início). Parando de vender com cartão de vez: `alter role card nologin`
  (`docs/instalacao.md`, seção 12).
- **Logs do `card` (10.5.1, guardar 12 meses):** o driver de log padrão do Docker apaga os logs quando o container é
  recriado (`docker compose up -d --build` numa atualização, `docker compose rm`). Configure um driver persistente no
  Docker do host (por exemplo, `journald` no `/etc/docker/daemon.json`, com o journal guardado por 12 meses) ou envie
  os logs a um coletor externo; no mínimo, exporte (`docker compose logs --no-color --timestamps card`) antes de
  recriar ou remover o container. Os logs do `card` não têm dados do cartão.
- **Cloudflare:** o checkout e o `pagar.` com o mesmo estado de proxy (o `TRUST_PROXY` é um só para o app e o `card`)
  e sem recursos que injetam scripts (Rocket Loader, Email Obfuscation, JS Detections, Zaraz, Web Analytics
  automático): ver `docs/instalacao.md`, seção 12. Com a nuvem laranja, a Cloudflare vê o cartão (prestador, acima).
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

Com o serviço de cartão configurado (`CARD_ORIGIN`), confere também a página do iframe de cada loja, `CARD_ORIGIN/form/<loja>`
(página `/form`):

- o cabeçalho `Content-Security-Policy` é exatamente o de `cardFormCsp` (`src/card-service/page.ts`), com o
  `frame-ancestors` das origens do checkout da loja;
- o inventário de scripts: só `/form.js` do domínio do cartão, nenhum de terceiro (o Turnstile, quando configurado,
  roda no checkout, não no iframe) e nenhum script inline executável (a configuração vai num
  `<script type="application/json">`, que não executa);
- o sha256 do conteúdo do `/form.js` baixado, que entra no inventário e é comparado com o sha256 do build da mesma
  revisão (o `bun run card:build` grava `dist/card/form.js.sha256`; a imagem do app o leva como
  `/app/card-form.sha256`). Diferente do build avisa com `inventario_mudou` já na primeira conferência (skimmer
  servido por um Caddy ou host comprometido, ou `card` e app de versões diferentes). Sem o arquivo (desenvolvimento),
  vale só o histórico: o mesmo caminho com outro conteúdo avisa uma vez. Se o `/form.js` não responder, a página não é
  conferida nessa semana (só log).
- toda mudança no resultado do `/form` (CSP, inventário ou sha256) também vai para o log do app como **erro**
  ("a página do cartão mudou", com a loja e os códigos): no `MODE=multi` o aviso do painel vai ao vendedor, mas quem
  pode agir é o operador do servidor. Monitore os erros do log do app (`docker compose logs app`).

O resultado (um hash do cabeçalho normalizado e do inventário, e os códigos de problema) fica em `page_check`. Quando
muda, o vendedor recebe um aviso no painel e por e-mail (`monitor_pagina_pagamento`, com a página, `/c`, `/o` ou
`/form`, e o código: `csp_ausente`, `csp_diferente`, `script_nao_autorizado`, `script_sem_nonce`, `script_inline` ou
`inventario_mudou`). Configurar o cartão (`CARD_ORIGIN`) muda a política do checkout (entra o `frame-src`): o aviso de `/c` sai uma vez. Uma atualização do
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

Os itens entre colchetes só entram com o Turnstile configurado (`TURNSTILE_SITE_KEY`). Com o cartão configurado, o
`frame-src` ganha também o `CARD_ORIGIN` (o checkout embute o iframe). Em `next dev` entra também
`'unsafe-eval'` (o React usa eval para as pilhas de erro; nunca em produção). O smoke E2E reprova qualquer violação
de CSP no console nas páginas do comprador e confere o cabeçalho (nonce diferente a cada requisição; painel sem CSP de
comprador). Mudar esta política é mudança de verificação: revisar junto com este inventário.

Página do iframe do cartão (`CARD_ORIGIN/form/<loja>`, gerada por `cardFormCsp`), sem nonce porque não tem script
inline executável:

```
default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:;
base-uri 'none'; form-action 'none'; frame-ancestors <origens do checkout da loja>
```

Nenhum código de terceiro roda no documento dos campos do cartão: o Turnstile, quando a loja usa, aparece no checkout
(página do app, que já o libera na CSP acima) e o token vai ao iframe na mensagem `pay`; o iframe o repassa no corpo
do `POST /api/card` e o `card` o confere na Cloudflare (inclusive o host em que o desafio foi resolvido). A cor da loja
chega ao iframe na mensagem `config` (só `#rrggbb`) e vira variável CSS pelo CSSOM (`style.setProperty`), que a
`style-src 'self'` permite; atributo `style` e `<style>` inline continuam bloqueados.

## Inventário de scripts da página de pagamento

| Script | Origem | Quando carrega | Justificativa | Controle |
|---|---|---|---|---|
| Runtime do Next.js/React e chunks da página (`/_next/static/...`) | própria (`'self'`) | sempre | renderização e formulário do checkout | build do próprio app; servido pelo próprio domínio |
| Scripts inline do Next (dados do RSC, `self.__next_f`) | própria, inline | sempre | hidratação das páginas | só executam com o nonce da requisição |
| Meta Pixel `fbevents.js` (e a configuração do pixel que ele busca) | `https://connect.facebook.net` | só com Pixel configurado (oferta ou loja) | medir anúncios (spec 7.8: InitiateCheckout, AddPaymentInfo, Purchase; deduplicado com a API de Conversões) | `fbq('set','autoConfig',false,<pixel>)` antes do `init` (desliga a configuração automática de eventos: cliques em botões e metadados da página); a correspondência avançada automática (leitura de e-mail/telefone digitados) NÃO é coberta pelo autoConfig e fica desligada no Gerenciador de Eventos (seção abaixo); eventos só com `currency`, `value` e `payment_type` (tipados como valores simples em `src/lib/tracking/fbq.ts`); nenhum dado do formulário; carregado por código próprio (`src/lib/tracking/fbq.ts`), sem HTML inline |
| Cloudflare Turnstile `api.js` | `https://challenges.cloudflare.com` | só se configurado E a API do cartão pedir o desafio (muitas tentativas); sempre no checkout (`/c`), também com o cartão isolado, nunca na página do iframe | antifraude de teste de cartões | o desafio roda em iframe da Cloudflare; script e frame só dessa origem; com o cartão isolado, o token vai ao iframe no `pay` |
| Formulário do cartão `form.js` (página do iframe, cartão isolado) | domínio do cartão (`CARD_ORIGIN`, `'self'` do iframe) | com `CARD_ORIGIN`, na página `/form/<loja>` | campos do cartão e envio ao `POST /api/card` do mesmo domínio | o **único** script da página do iframe; build do próprio projeto (`bun run card:build`), servido só pelo container `card`; único `fetch` relativo (`/api/card`) |

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

