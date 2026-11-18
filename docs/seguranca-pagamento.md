# Segurança das páginas de pagamento

Páginas do comprador: `/c/<oferta>` (checkout: nome, e-mail, celular, CPF e, no cartão, número, validade e CVV) e
`/o/<pedido>` (pedido e obrigado). Referências: PCI DSS 4.0 requisitos 6.4.3 (inventário, autorização e integridade
dos scripts da página de pagamento) e 11.6.1 (detecção de mudanças nos cabeçalhos de segurança e scripts).

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
| Meta Pixel `fbevents.js` (e a configuração do pixel que ele busca) | `https://connect.facebook.net` | só com Pixel configurado (oferta ou loja) | medir anúncios (spec 7.8: InitiateCheckout, AddPaymentInfo, Purchase; deduplicado com a API de Conversões) | `fbq('set','autoConfig',false,<pixel>)` antes do `init` (sem coleta automática de cliques, campos ou metadados); eventos só com `currency`, `value` e `payment_type` (tipados como valores simples em `src/lib/tracking/fbq.ts`); nenhum dado do formulário; carregado por código próprio (`src/lib/tracking/fbq.ts`), sem HTML inline |
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
