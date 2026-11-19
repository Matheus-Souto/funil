# Segurança das páginas de pagamento

Páginas do comprador: `/c/<oferta>` (checkout: nome, e-mail, celular, CPF e, no cartão, número, validade e CVV) e
`/o/<pedido>` (pedido e obrigado). Referências: PCI DSS 4.0 requisitos 6.4.3 (inventário, autorização e integridade
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
- **Próximo passo recomendado (decisão do dono):** tirar o cartão do processo principal, ou com a página de pagamento
  hospedada do Asaas para cartão (a loja volta a SAQ A), ou isolando a rota de cartão num processo/container próprio,
  sem painel, sem PDF e sem SMTP. Enquanto isso não for feito, o escopo é o descrito aqui.

## Monitor semanal em produção (11.6.1)

Além do smoke E2E antes de cada deploy, o job `pci_page_monitor` (`src/lib/security/page-monitor.ts`) roda **toda
semana** em produção. Para cada loja, ele busca no próprio domínio da loja o checkout de uma oferta ativa
(`/c/<slug>`, de preferência com cartão) e a página do pedido mais recente (`/o/<id>`) e confere:

- o cabeçalho `Content-Security-Policy` é exatamente a política gerada pelo app (abaixo), com nonce;
- o inventário de scripts do HTML: só `/_next/static/*` do próprio domínio, `https://connect.facebook.net` e (com
  Turnstile) `https://challenges.cloudflare.com`; todo script inline com o nonce daquela resposta.

O resultado (um hash do cabeçalho normalizado e do inventário, e os códigos de problema) fica em `page_check`. Quando
muda, o vendedor recebe um aviso no painel e por e-mail (`monitor_pagina_pagamento`, com a página e o código:
`csp_ausente`, `csp_diferente`, `script_nao_autorizado`, `script_sem_nonce` ou `inventario_mudou`). Uma atualização do
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

Os itens entre colchetes só entram com o Turnstile configurado (`TURNSTILE_SITE_KEY`). Em `next dev` entra também
`'unsafe-eval'` (o React usa eval para as pilhas de erro; nunca em produção). O smoke E2E reprova qualquer violação
de CSP no console nas páginas do comprador e confere o cabeçalho (nonce diferente a cada requisição; painel sem CSP de
comprador). Mudar esta política é mudança de verificação: revisar junto com este inventário.

## Inventário de scripts da página de pagamento

| Script | Origem | Quando carrega | Justificativa | Controle |
|---|---|---|---|---|
| Runtime do Next.js/React e chunks da página (`/_next/static/...`) | própria (`'self'`) | sempre | renderização e formulário do checkout | build do próprio app; servido pelo próprio domínio |
| Scripts inline do Next (dados do RSC, `self.__next_f`) | própria, inline | sempre | hidratação das páginas | só executam com o nonce da requisição |
| Meta Pixel `fbevents.js` (e a configuração do pixel que ele busca) | `https://connect.facebook.net` | só com Pixel configurado (oferta ou loja) | medir anúncios (spec 7.8: InitiateCheckout, AddPaymentInfo, Purchase; deduplicado com a API de Conversões) | `fbq('set','autoConfig',false,<pixel>)` antes do `init` (desliga a configuração automática de eventos: cliques em botões e metadados da página); a correspondência avançada automática (leitura de e-mail/telefone digitados) NÃO é coberta pelo autoConfig e fica desligada no Gerenciador de Eventos (seção abaixo); eventos só com `currency`, `value` e `payment_type` (tipados como valores simples em `src/lib/tracking/fbq.ts`); nenhum dado do formulário; carregado por código próprio (`src/lib/tracking/fbq.ts`), sem HTML inline |
| Cloudflare Turnstile `api.js` | `https://challenges.cloudflare.com` | só se configurado E a API do cartão pedir o desafio (muitas tentativas) | antifraude de teste de cartões | o desafio roda em iframe da Cloudflare; script e frame só dessa origem |

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

