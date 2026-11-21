# Recuperação de vendas por e-mail: plano de implementação

> **Para agentes:** sub-skill obrigatória: superpowers:subagent-driven-development (recomendada) ou
> superpowers:executing-plans, tarefa por tarefa. Os passos usam checkbox (`- [ ]`).

**Objetivo:** mandar **um** lembrete automático por e-mail, pelo provedor da própria loja (SMTP ou Resend), a quem
começou a comprar e não pagou. São três casos: (1) digitou o e-mail no checkout e saiu antes do pedido; (2) gerou o Pix
e não pagou; (3) teve o cartão recusado. Todo e-mail tem um link para não receber mais. O caso do cartão tem proteção
para não virar spam contra vítimas de teste de cartão.

**Arquitetura:**
- **Varredura** `recovery_scan` (job global, a cada 5 min, agendado como o `expire_orders`): loja a loja, com a
  recuperação ligada, escolhe os candidatos dos três casos dentro de uma janela (vencidos há pelo menos o prazo do caso,
  criados há no máximo 6 h). Aplica supressão, dedupe por endereço, "já comprou", tetos e a proteção do cartão, grava uma
  linha `recovery_email` (`queued`) e enfileira `recovery_send` na mesma transação. Nenhum gancho novo em `createOrder`,
  `saveLead` nem no serviço do cartão: a política `job_card_insert` do papel `card` **não muda** (D1).
- **Envio** `recovery_send {recoveryId}`: reivindica a linha (`queued → sending`), confere de novo que o caso continua em
  aberto, monta o e-mail fixo (`templates.ts`), chama `sendMail` fora de transação e grava `email_log` (kind
  `recovery`, destinatário só em sha256) e o resultado na linha.
- **Descadastro:** cada linha tem um token aleatório (só o sha256 fica guardado). Rodapé com link
  `/sair/<token>` e os cabeçalhos `List-Unsubscribe` + `List-Unsubscribe-Post` (um clique, RFC 8058). O GET só mostra o
  botão; o POST grava `email_optout (store_id, email_hash)` e apaga os contatos abertos desse e-mail. Devolvido ou spam
  no webhook do Resend também grava `email_optout`.
- **Painel e métricas:** Configurações ganha a seção "Recuperação de vendas por e-mail" (mestre desligado + 3 caixas).
  Contatos mostra "Lembrete enviado"; a linha do tempo do pedido mostra o lembrete; a visão geral e o `metrics.summary`
  ganham só **números** (enviados, recuperados e receita recuperada, por caso). Nenhum item novo no menu.

**Stack:** Next 16 (rotas em Node), Drizzle e Postgres 17 (RLS), Zod 4, nodemailer e a API do Resend, testes em Bun.

**Spec:** `docs/superpowers/specs/2026-11-20-kids-migracao-design.md` (fora do escopo de lá: "sequência de e-mails"; este
PR é o próximo passo, pedido pelo dono em 21/11) e o plano do PR #14
`docs/superpowers/plans/2026-11-21-abandono-antes-de-comprar.md` (D6: texto do aviso; D14: e-mail automático adiado).

> Não sou advogado. Caso 1: o aviso que a pessoa viu ("para falar com você se a compra não for concluída" e "só para
> lembrar você desta compra") cobre um lembrete; base legítimo interesse (art. 7º, IX), como no PR #14. Casos 2 e 3: a
> pessoa iniciou o pedido; o lembrete do próprio pedido cabe em procedimentos preliminares do contrato a pedido do
> titular (art. 7º, V) ou em legítimo interesse. Em todos: link de saída de um clique e nenhum uso além do lembrete.
> Vale passar pelo jurídico junto com o texto do aviso do PR #14.

## O que encontrei no código e que muda o pedido

- **Cartão recusado não deixa o pedido `declined`.** Nenhum código faz essa transição: a recusa fecha a `card_attempt`
  como `declined` e o pedido segue `pending`, sem validade (`expires_at` nulo). A página `/o/<publicId>` desse pedido
  mostra "Pagamento em análise", então o e-mail do caso 3 vai para `/c/<slug>`. Critério do caso 3 (o mesmo do aviso
  `card_declined` do Telegram): pedido `card_asaas`, ainda `pending`, com pelo menos uma tentativa `declined`.
- **O serviço do cartão só enfileira alguns tipos de job** (`job_card_insert` em `src/lib/db/rls.sql`). Agendar o
  lembrete no momento da recusa exigiria ampliar essa política. A varredura do D1 evita isso.

## Decisões para o dono aprovar

Já decidido pelo dono: cobrir os 3 casos; e-mail pelo provedor da loja; link para não receber mais em todo e-mail;
proteção contra teste de cartão. Cada linha abaixo traz a minha recomendação (**R**), a alternativa e o custo.

| # | Assunto | Recomendação | Alternativa | Custo da recomendação |
|---|---------|--------------|-------------|-----------------------|
| D1 | Como dispara | **R:** varredura no app a cada 5 min (`recovery_scan`), olhando só o que venceu o prazo e foi criado há no máximo 6 h | Agendar um job no evento (criação do contato, do pedido Pix, recusa do cartão) | Até 5 min de atraso. Worker parado por mais de 6 h perde esses lembretes. Em troca: o serviço do cartão não ganha permissão nova, e ligar a recuperação (ou subir depois de uma queda) nunca manda e-mail em massa para abandonos antigos |
| D2 | Quantos e-mails e quando | **R:** 1 por caso. Contato: 60 min depois da captura. Pix: 30 min depois de gerado, só se faltar pelo menos 1 h para vencer. Cartão: 30 min depois da 1ª recusa. Prazos fixos no código | 2 no Pix (o segundo cerca de 4 h antes de vencer); ou prazos configuráveis | Quem ignora o primeiro não recebe outro. A sequência fica para o PR de sequência de e-mails |
| D3 | Texto | **R:** fixo, com nome da loja, produto e valor (seção "Textos" abaixo) | Editável pela loja | A loja não muda a copy. Editável pede escape, prévia e classificação no MCP |
| D4 | Liga/desliga | **R:** chave geral em Configurações, desligada por padrão, e uma caixa por caso, que já vêm marcadas. Só liga com o e-mail da loja conectado (o provedor ativo tem conexão salva). O caso 1 só roda com a captura de contato ligada. Pelo MCP vale o que já existe: `store.updateSettings` é sensível e passa pela fila de aprovação | Ligar por caso sem chave geral | Um campo a mais na tela |
| D5 | Descadastro | **R:** link no rodapé e cabeçalhos de um clique. A página `/sair/<token>` mostra um botão, e só o POST descadastra: leitores de link e antivírus abrem com GET e não descadastram ninguém. Vale para a loja inteira (os 3 casos), sem prazo, guardando só o sha256 do e-mail. Descadastrar também apaga os contatos abertos e contatados desse e-mail | Descadastrar já no GET; ou valer só para o caso daquele e-mail | Um clique a mais para a pessoa. O hash fica guardado para sempre (sem ele a loja não consegue respeitar o pedido) |
| D6 | Devolvido e spam | **R:** `bounced` ou `complained` no webhook do Resend, em qualquer e-mail da loja, grava o endereço em `email_optout` | Só registrar, como hoje | Um comprador que marcou a entrega como spam também deixa de receber lembretes (é o que se espera) |
| D7 | Dedupe entre casos | **R:** um e-mail por contato ou pedido. Por endereço, na loja: no máximo 1 lembrete a cada 24 h e 3 em 30 dias, contando os 3 casos juntos. Pula se o endereço já comprou essa oferta nos últimos 30 dias, ou se há pedido mais novo do mesmo cliente na mesma oferta (o lembrete vai para o mais novo). Quem digitou o e-mail e gerou o Pix não recebe o do contato, porque o pedido converte o contato na hora | Sem limite por endereço | Quem abandona duas vezes no mesmo dia recebe um lembrete só |
| D8 | Tetos por loja | **R:** 60 lembretes por hora (todos os casos), dentro deles no máximo 10 do caso cartão. O excedente fica para a próxima varredura, ainda dentro da janela de 6 h | Sem teto | Num pico real, alguns lembretes saem mais tarde ou não saem |
| D9 | Proteção do caso cartão | **R:** pula (e registra como `skipped`) se: o pedido teve mais de 3 recusas; o disjuntor de cartão da loja disparou nas últimas 2 h; o IP do pedido teve mais de 3 recusas nas últimas 2 h; ou o IP é desconhecido. Somam-se a isso D7 e D8. O texto não fala em "cartão recusado"; diz que o pagamento não foi concluído, que nada foi cobrado e "se não foi você, ignore" | Caso cartão desligado por padrão; ou só com Turnstile resolvido | Algum comprador real que tentou 4 cartões ou divide o IP com um robô fica sem lembrete. A vítima de um robô "lento" (até 3 recusas, IP próprio) ainda pode receber **um** e-mail neutro, e no máximo 3 em 30 dias |
| D10 | Para onde o link leva | **R:** contato e cartão: `/c/<slug>?utm_source=recuperacao&utm_medium=email&utm_campaign=contato` (ou `cartao`). Pix: `/o/<publicId>`. Nunca e-mail nem nome na URL (não preenche o checkout) | Preencher o e-mail no checkout por um token | A pessoa digita o e-mail de novo. Com a UTM, a venda recuperada aparece como origem `recuperacao` no último toque |
| D11 | Painel | **R:** em Contatos, "Lembrete enviado em …" na linha. No pedido, a linha do tempo mostra "Lembrete de pagamento por e-mail" (ou falhou). Na visão geral, um cartão com enviados, recuperados e receita recuperada. Sem item novo no menu | Página própria de recuperação | Não há lista de quem recebeu, só os números e as marcas nas linhas |
| D12 | Métricas e MCP | **R:** `metrics.summary` ganha `recovery: { sent, recovered, recoveredRevenueCents, byCase }`, só números, também pelo MCP. "Recuperado" = pedido pago da mesma oferta, do mesmo e-mail, até 7 dias depois do envio | Nada no MCP | O agente sabe quanto a recuperação rende, nunca quem |
| D13 | Retenção | **R:** `recovery_email` guarda só ids, hashes e datas, e é apagada com 90 dias pela varredura `sweep_leads` que já existe. O link de saída vale enquanto a linha existir. `email_optout` não vence | 30 dias, como os contatos | Métrica de recuperado olha até 90 dias para trás. Link com mais de 90 dias mostra "Link vencido" (o e-mail ainda pode responder à loja) |
| D14 | Falha no envio | **R:** provedor não configurado ou recusado → `failed` sem nova tentativa, com `email_log` `failed`. Erro temporário → a fila tenta de novo, mas só até 2 h depois do horário previsto; depois vira `failed` | Seguir o backoff inteiro (até 12 h) | Um lembrete muito atrasado não sai |
| D15 | Telegram | **R:** nada novo (os avisos de abandono que existem seguem iguais) | Avisar no Telegram quando um lembrete sai | Nenhum |

Decidido sem escolha (regra do dono, da spec ou do repo):
- **Nenhum dado pessoal do comprador sai pelo MCP, pelo Telegram nem por log.** `recovery_email`, `email_optout` e
  `email_log` guardam o destinatário só como sha256. Log e auditoria levam só `recoveryId`, `leadId` ou `orderId`, caso
  e motivo. O token do descadastro nunca vai a log.
- Tabelas novas com `store_id` + `enable_store_rls`; o papel `card` não lê nem escreve nelas.
- Rotas e páginas só chamam `runAction`; dinheiro em centavos; sem API exclusiva do Bun em `src/`.

### Textos (D3)

Todos: sem nome do comprador; valores dinâmicos com `esc` no HTML e `oneLine` no texto; mesmo `layout` da entrega.
Rodapé comum (HTML e texto):

> Você recebeu este lembrete porque {motivo} na {loja}. Se não foi você, ignore este e-mail.
> **Não quero receber lembretes da {loja}** → `/sair/<token>`

`{motivo}`: caso 1 "digitou este e-mail no checkout"; casos 2 e 3 "iniciou uma compra".

| Caso | Assunto | Título | Corpo | Botão |
|------|---------|--------|-------|-------|
| contato | `Sua compra de {produto} ficou pela metade` | Ainda dá tempo de garantir {produto} | Você começou a comprar {produto} ({valor}) na {loja} e não terminou. Se quiser concluir, é só voltar: | Concluir minha compra |
| pix | `Seu Pix de {valor} ainda não foi pago` | Seu Pix está pronto para pagar | Você gerou um Pix de {valor} para {produto} na {loja}, mas o pagamento ainda não chegou. O código vale até {data e hora de São Paulo}. Já pagou? Pode ignorar: o acesso chega assim que o banco confirmar. | Ver o Pix |
| cartão | `Sua compra de {produto} não foi concluída` | O pagamento não foi concluído | Sua compra de {produto} ({valor}) na {loja} não foi concluída e nada foi cobrado. Você pode tentar de novo com Pix ou outro cartão: | Tentar de novo |

`{produto}`: o mesmo critério do aviso de pedido (1 produto principal → o produto; mais de 1 → a oferta). `{valor}`:
contato → preço atual da oferta; pix e cartão → `total_cents` do pedido.

## Restrições globais

- **Prazos e números** (`RECOVERY` em `src/lib/recovery/rules.ts`): `leadAfterMin: 60`, `pixAfterMin: 30`,
  `cardAfterMin: 30`, `lookbackHours: 6`, `pixMinLeftMin: 60`, `addressGapHours: 24`, `addressMaxPer30d: 3`,
  `boughtLookbackDays: 30`, `storePerHour: 60`, `cardPerHour: 10`, `cardMaxDeclines: 3`, `cardIpDeclinesMax: 3`,
  `cardSuspicionWindowHours: 2`, `sendGraceMin: 120`, `retentionDays: 90`, `attributionDays: 7`.
  Varredura a cada `EXPIRE_EVERY_MS` (5 min).
- **Hash do e-mail:** `sha256(email.trim().toLowerCase())` em hex, o mesmo de `email_log.to_hash` e
  `checkout_lead.email_hash`. No SQL: `encode(sha256(convert_to(<email>, 'UTF8')), 'hex')` (o `customer.email` já é
  gravado minúsculo).
- **Log:** nunca e-mail, token nem URL de descadastro; só `recoveryId`, `storeId`, `kind`, motivo.
- **Testes:** nenhum literal com formato de segredo (`whsec_…`, token de bot, `re_…`, `fnl_…`, `upl_…`): monte em tempo
  de execução, como nos testes do PR 5. Nada de skip, only, retry ou espera fixa: o relógio é injetado e as datas mudam
  no banco. Nunca ofusque palavras para passar na higiene.
- **Escopo do PR:** produto. Não edita `e2e/`, `scripts/verify*`, `.github/`, `.claude/` nem `REVIEW.md`. Nenhum item
  novo no menu do painel.
- **Processo:** `bun run check` antes de cada commit; `bash scripts/verify.sh` (≈7–13 min, em segundo plano, sem
  interromper) antes do PR. Implementadores não usam `git stash`.

## Foco de revisão

1. **Spam contra terceiros:** robô de cartão com e-mails alheios; muitos Pix com o e-mail de uma vítima; a mesma pessoa
   em vários casos. Esperado: no máximo 1 lembrete por endereço a cada 24 h e 3 em 30 dias na loja; nada no caso cartão
   com disjuntor ou IP suspeito. Testes na Task 4.
2. **Lembrete depois de pagar ou de sair:** pagou (ou converteu o contato) entre a varredura e o envio; descadastrou
   com um lembrete já na fila; contato apagado pelo titular. Esperado: o envio confere de novo e não manda. Testes na
   Task 5.
3. **E-mail em massa ao ligar ou depois de uma queda:** loja liga a recuperação com 2 dias de abandonos; worker parado
   por 1 dia. Esperado: só o que foi criado nas últimas 6 h. Teste na Task 4.
4. **Descadastro por acidente ou por terceiros:** leitor de link (GET) não descadastra; token de outra loja ou
   inventado não acha nada; `/sair` com o POST de um clique (`List-Unsubscribe=One-Click`) descadastra. Testes na
   Task 6.
5. **Dado pessoal saindo:** e-mail ou token em `log`, `audit_log`, resposta do MCP (`metrics.summary` em qualquer
   papel) ou URL do lembrete. Testes nas Tasks 4, 5, 6 e 7.

---

### Task 1: tabelas, colunas da loja e o kind `recovery` no `email_log`

**Files:**
- Create: `src/lib/db/schema/recovery.ts` (exportado por `src/lib/db/schema/index.ts`), `drizzle/0033_recovery_email.sql`
  (via `bun run migration --name recovery_email`; acrescentar à mão `select enable_store_rls('recovery_email');` e
  `select enable_store_rls('email_optout');`)
- Modify: `src/lib/db/schema/core.ts` (store), `src/lib/db/schema/delivery.ts` (check do `email_log.kind`),
  `src/lib/delivery/email-log.ts` (`EmailKind`)
- Test: `tests/recovery.test.ts` (novo), `tests/card-role.test.ts`, `tests/rls.test.ts`/`tests/migrate.test.ts` (se listam tabelas)

**Interfaces:**
- Produces:
  - `recovery_email`: `id uuid pk`, `store_id → store (cascade)`, `kind text not null` (check `lead | pix | card`),
    `lead_id uuid → checkout_lead (set null)`, `order_id uuid → orders (cascade)`, `offer_id uuid not null → offer (cascade)`,
    `email_hash text not null`, `status text not null default 'queued'` (check `queued | sending | sent | failed | skipped`),
    `skip_reason text`, `unsub_hash text not null`, `job_id uuid`, `due_at timestamptz not null`, `sent_at timestamptz`,
    `created_at`, `expires_at timestamptz not null` (criação + 90 d). Restrições: único `unsub_hash`; único parcial
    `(lead_id) where lead_id is not null`; único parcial `(order_id, kind) where order_id is not null`; check
    `(kind = 'lead') = (order_id is null)`. Índices `(store_id, email_hash, created_at desc)`, `(store_id, created_at desc)`,
    `(expires_at)`.
  - `email_optout`: `store_id → store (cascade)`, `email_hash text not null`, `reason text not null` (check
    `unsubscribe | complaint | bounce`), `created_at`; pk `(store_id, email_hash)`.
  - `store.recovery_on boolean not null default false`, `store.recovery_lead`, `store.recovery_pix`,
    `store.recovery_card` (`boolean not null default true`).
  - `EmailKind = "delivery" | "seller_notice" | "test" | "recovery"`; check do `email_log.kind` com `recovery`.

- [ ] **Step 1: testes que falham:**
  - `tests/recovery.test.ts`: `RLS: recovery_email e email_optout de outra loja não aparecem`;
    `lead sem order_id ok; pix sem order_id recusado`; `segundo lembrete do mesmo pedido e caso recusado (único)`.
  - `tests/card-role.test.ts`: o papel `card` não lê `recovery_email` nem `email_optout`.
- [ ] **Step 2:** `bun test tests/recovery.test.ts tests/card-role.test.ts` → FAIL.
- [ ] **Step 3: implementar** (schema, migração, colunas, `EmailKind`).
- [ ] **Step 4:** os do Step 2 + `tests/migrate.test.ts tests/rls.test.ts tests/delivery.test.ts` → PASS.
- [ ] **Step 5:** `bun run check` e commit `feat(recuperacao): tabelas recovery_email e email_optout`.

### Task 2: cabeçalhos de descadastro no envio e os modelos de e-mail

**Files:**
- Modify: `src/lib/delivery/mailer.ts` (`MailMessage.headers`, repassado ao nodemailer), `src/lib/delivery/resend.ts`
  (campo `headers` da API), `src/lib/delivery/templates.ts` (`recoveryEmail`)
- Test: `tests/recovery-templates.test.ts` (novo), `tests/resend.test.ts`, `tests/delivery.test.ts` (SMTP falso)

**Interfaces:**
- Produces:
  - `MailMessage` ganha `headers?: { "List-Unsubscribe": string; "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }`.
    Os valores passam por `oneLine` antes de sair (nem SMTP nem Resend aceitam quebra de linha em cabeçalho).
  - `recoveryEmail(kind: "lead" | "pix" | "card", d: { storeName: string; brandColor: string | null; productName: string; totalCents: number; actionUrl: string; unsubscribeUrl: string; pixExpiresAt?: Date }): { subject: string; html: string; text: string; headers: MailMessage["headers"] }`
    com os textos exatos da seção "Textos"; `headers["List-Unsubscribe"] = "<" + unsubscribeUrl + ">"`.

- [ ] **Step 1: testes que falham:**
  - `tests/recovery-templates.test.ts`: para cada caso, assunto, título e botão exatos; o HTML tem `href` do
    `actionUrl` e do `unsubscribeUrl`; o texto tem os dois links; `"Se não foi você, ignore este e-mail."` nos três;
    caso cartão **não** contém "recusad"; nome de produto com `<script>` sai escapado no HTML e com `\n` sai numa linha no texto;
    pix mostra a validade em horário de São Paulo.
  - `tests/resend.test.ts`: o corpo enviado à API traz `headers` com os dois cabeçalhos.
  - `tests/delivery.test.ts`: o SMTP falso recebe os dois cabeçalhos; mensagem sem `headers` sai como antes.
- [ ] **Step 2:** `bun test tests/recovery-templates.test.ts tests/resend.test.ts tests/delivery.test.ts` → FAIL.
- [ ] **Step 3: implementar.**
- [ ] **Step 4:** os mesmos → PASS.
- [ ] **Step 5:** `bun run check` e commit `feat(recuperacao): modelos de lembrete e cabeçalho de descadastro`.

### Task 3: Configurações (liga/desliga por loja e por caso)

**Files:**
- Modify: `src/lib/store-settings.ts`, `src/app/admin/(panel)/settings/form.tsx`
- Create: `src/lib/recovery/settings.ts` (`emailProviderReady`)
- Test: `tests/panel-actions.test.ts`

**Interfaces:**
- Consumes: colunas da Task 1.
- Produces:
  - `emailProviderReady(tx: Tx, storeId: string): Promise<boolean>`: existe conexão salva do provedor ativo da loja
    (`store.email_provider`), sem abrir o segredo.
  - `store.updateSettings` aceita `recovery?: { on: boolean; lead: boolean; pix: boolean; card: boolean }` (omitido: mantém).
    Ligar `on` sem `emailProviderReady` → `invalid_input` no caminho `["recovery","on"]` com
    `"Conecte o e-mail da loja em Conexões antes de ligar."`. `store.getSettings` devolve `recovery` com os quatro.
    A classificação de `store.updateSettings` no MCP (sensível) não muda.

- [ ] **Step 1: testes que falham** (`tests/panel-actions.test.ts`): `ligar a recuperação sem e-mail conectado → invalid_input`;
  `com SMTP salvo liga e getSettings devolve os quatro campos`; `desligar só o caso cartão mantém os outros`.
- [ ] **Step 2:** `bun test tests/panel-actions.test.ts` → FAIL.
- [ ] **Step 3: implementar** a ação e a seção do formulário: título "Recuperação de vendas por e-mail"; chave
  "Mandar um lembrete por e-mail para quem não concluiu a compra"; caixas "Digitou o e-mail e saiu antes do pedido
  (precisa da captura de contato ligada)", "Pix gerado e não pago", "Cartão recusado"; ajuda "Sai pelo e-mail da loja
  (Conexões). Um lembrete por compra, com link para a pessoa não receber mais."
- [ ] **Step 4:** `bun test tests/panel-actions.test.ts` → PASS e `bun run build` sem erro.
- [ ] **Step 5:** `bun run check` e commit `feat(recuperacao): configuração da recuperação por loja e por caso`.

### Task 4: varredura (`recovery_scan`): candidatos, dedupe, tetos e proteção do cartão

**Files:**
- Create: `src/lib/recovery/rules.ts` (`RECOVERY`, `recoveryEmailHash`), `src/lib/recovery/scan.ts`
- Modify: `src/lib/jobs.ts` (`"recovery_scan"`, `"recovery_send"`), `src/lib/jobs/handlers.ts`,
  `src/lib/jobs/worker.ts` (`scheduleOnce("recovery_scan")` junto do `expire_orders`)
- Test: `tests/recovery.test.ts`

**Interfaces:**
- Consumes: Task 1 e 3; `countRecentEvents`, `hadRecentEvent`, `ipRateKey` (`src/lib/payments/ratelimit.ts`); as chaves
  `card:decline:ip:<ipKey>` e `card:breaker:store:<storeId>` de `src/lib/payments/asaas/card.ts` (exportar a montagem
  das chaves de lá, sem duplicar o texto). `UNKNOWN_IP` de `src/lib/client-ip.ts`.
- Produces:
  - `createRecoveryScanHandler(now?: () => Date): JobHandler` e `recoveryScanJob`.
  - Por loja com `recovery_on`, numa transação com `pg_advisory_xact_lock(hashtext('recovery:' || storeId))`:
    - candidatos (mais antigos primeiro): **lead** (`recovery_lead`, `store.lead_capture` ligado, contato `open` com
      e-mail, não vencido, `created_at` entre `now − 6 h` e `now − 60 min`); **pix** (`recovery_pix`, pedido `pending`
      `pix_asaas`/`pix_manual`, `created_at` entre `now − 6 h` e `now − 30 min`, `expires_at > now + 60 min`); **card**
      (`recovery_card`, pedido `card_asaas` `pending` cuja 1ª `card_attempt` `declined` tem `resolved_at` entre
      `now − 6 h` e `now − 30 min`); sem linha `recovery_email` para o contato ou o pedido.
    - **pula com linha `skipped`** e `skip_reason`: `optout` (hash em `email_optout`); `endereco_24h` (lembrete
      `queued|sending|sent` do mesmo hash nas últimas 24 h); `endereco_30d` (3 nos últimos 30 dias); `ja_comprou`
      (pedido `paid|disputed|refunded` da mesma oferta e do mesmo e-mail nos últimos 30 dias); `pedido_mais_novo` (pix e
      cartão: pedido mais novo do mesmo cliente na mesma oferta); `cartao_suspeito` (mais de 3 recusas no pedido,
      disjuntor da loja nas últimas 2 h, mais de 3 recusas do IP do pedido nas últimas 2 h, ou IP desconhecido).
    - **pula sem linha** (tenta na próxima varredura): teto da loja (60 linhas `queued|sending|sent` na última hora) ou
      do cartão (10).
    - senão: insere `recovery_email` (`queued`, `due_at` = momento previsto do caso, `unsub_hash` = sha256 de
      `randomToken(32)`) e enfileira `recovery_send { recoveryId, unsubToken }` na mesma transação. O token em claro vai
      **só** no payload do job (que não tem RLS, mas também não sai por log nem pelo MCP); a linha guarda o hash.
  - Falha numa loja não para as outras; no fim, se alguma falhou, o job falha (padrão do `expire_orders`).

- [ ] **Step 1: testes que falham** (`tests/recovery.test.ts`, relógio injetado, datas mudadas no banco):
  - `lead aberto há 61 min → 1 linha queued e 1 job recovery_send; há 59 min → nada`.
  - `lead criado há 7 h → nada (janela de 6 h)`; `loja liga a recuperação com 50 abandonos de ontem → nenhuma linha`.
  - `pix pendente há 31 min → enfileira; Pix que vence em 50 min → nada; pedido pago → nada`.
  - `cartão com 1 recusa há 31 min → enfileira; com 4 recusas → skipped cartao_suspeito`.
  - `disjuntor da loja disparado há 1 h → skipped cartao_suspeito`; `IP do pedido com 4 recusas em 2 h → skipped`;
    `IP desconhecido → skipped`.
  - `mesmo e-mail com lembrete há 2 h (outro caso) → skipped endereco_24h`; `3 lembretes em 30 dias → skipped endereco_30d`.
  - `e-mail em email_optout → skipped optout`; `já comprou a oferta há 10 dias → skipped ja_comprou`.
  - `dois Pix do mesmo cliente e oferta → só o mais novo recebe`.
  - `61º lembrete da loja na hora → sem linha; 11º do caso cartão → sem linha`.
  - `caso desligado (recovery_pix = false) ou chave geral desligada → nada`; `captura de contato desligada → caso lead não roda`.
  - `duas varreduras ao mesmo tempo → uma linha só por pedido (lock + único)`.
  - `log da varredura não contém o e-mail nem o token` (captura de `log` como em `tests/telegram.test.ts`).
- [ ] **Step 2:** `bun test tests/recovery.test.ts` → FAIL.
- [ ] **Step 3: implementar.** Confirmar que a limpeza ocasional de `rate_limit` guarda pelo menos 2 h de eventos
  `card:`; se não guardar, a janela de suspeita usa o que existe e o teste documenta o limite.
- [ ] **Step 4:** `bun test tests/recovery.test.ts tests/jobs.test.ts` → PASS.
- [ ] **Step 5:** `bun run check` e commit `feat(recuperacao): varredura dos três casos com dedupe, tetos e proteção do cartão`.

### Task 5: envio (`recovery_send`)

**Files:**
- Create: `src/lib/recovery/send.ts`
- Modify: `src/lib/jobs/handlers.ts`
- Test: `tests/recovery.test.ts`

**Interfaces:**
- Consumes: `recovery_email` (Task 1), `recoveryEmail` e `MailMessage.headers` (Task 2), `RECOVERY` (Task 4),
  `sendMail`, `logEmail`, `storeBaseUrl`.
- Produces: `recoverySendJob: JobHandler`, payload `{ recoveryId: uuid; unsubToken: string }`.
  1. Transação curta: reivindica `update recovery_email set status='sending', job_id=$job where id=$id and (status='queued' or (status='sending' and job_id=$job))`;
     sem linha → sai. Confere de novo: optout; lead ainda `open` com e-mail e não vencido; pedido ainda `pending`
     (pix: `expires_at > now`; cartão: sem tentativa `approved`); caso e chave geral ligados. Não vale mais → `skipped`
     com o motivo. Lê destinatário (contato ou `customer.email`), loja, produto e valor.
  2. Fora de transação: `sendMail(storeId, { to, ...recoveryEmail(...) }, { signal, idempotencyKey: recoveryId })`.
     `actionUrl`: D10. `unsubscribeUrl`: `<storeBaseUrl>/sair/<unsubToken>`.
  3. Sucesso: `status='sent'`, `sent_at=now()` e `email_log` (`kind: "recovery"`, `orderId` nos casos pix/cartão,
     `jobId`, `provider`, `messageId`). `ActionError` `provider_error`: `failed` + `email_log` `failed`, sem relançar.
     Outro erro: `email_log` `failed`; se `now < due_at + 120 min`, volta a `queued` e relança (a fila tenta de novo);
     senão `failed` sem relançar.

- [ ] **Step 1: testes que falham** (`tests/recovery.test.ts`, transporte SMTP falso):
  - `lead → e-mail para o contato com link /c/<slug>?utm_source=recuperacao&utm_medium=email&utm_campaign=contato,
    List-Unsubscribe e email_log recovery com to_hash`.
  - `pix → link /o/<publicId>`; `cartão → utm_campaign=cartao`.
  - `pago entre a varredura e o envio → skipped, nenhum e-mail`; `descadastrou com o job na fila → skipped optout`;
    `contato convertido ou apagado → skipped`.
  - `segundo recovery_send da mesma linha → não envia de novo`.
  - `provedor não configurado → failed sem relançar`; `erro de rede dentro de 2 h → relança e linha queued`;
    `erro de rede depois de 2 h → failed`.
  - `nem log nem audit_log contêm o e-mail ou o token`.
- [ ] **Step 2:** `bun test tests/recovery.test.ts` → FAIL.
- [ ] **Step 3: implementar.**
- [ ] **Step 4:** `bun test tests/recovery.test.ts tests/delivery.test.ts` → PASS.
- [ ] **Step 5:** `bun run check` e commit `feat(recuperacao): envio do lembrete pelo provedor da loja`.

### Task 6: descadastro (`/sair/<token>`) e supressão pelo webhook do Resend

**Files:**
- Create: `src/lib/recovery/unsubscribe.ts`, `src/app/sair/[token]/route.ts`
- Modify: `src/lib/delivery/resend-webhook.ts`, `src/lib/actions/all.ts`, `src/lib/mcp/tools.ts` (classificação)
- Test: `tests/recovery-unsubscribe.test.ts` (novo), `tests/resend-webhook.test.ts`, `tests/mcp-tools.test.ts`

**Interfaces:**
- Consumes: Task 1 e 5.
- Produces:
  - `recovery.unsubscribeView` (público, `audit: false`): `{ token, clientIp }` → `{ storeName, valid: boolean }`; não muda nada.
  - `recovery.unsubscribe` (público, `audit: false`): `{ token, clientIp }` → acha a linha pelo `unsub_hash` na loja do
    host; grava `email_optout` (`unsubscribe`, `on conflict do nothing`); apaga `checkout_lead` `open|contacted` da loja
    com o mesmo `email_hash`. Token desconhecido ou vencido → `{ done: false }` sem dizer se existiu. Limite 30 por
    IP por hora (`recovery:unsub:ip:<storeId>:<ipKey>`).
  - Rota (só parse HTTP + `runAction`, padrão de `/d/[token]` e de `src/lib/delivery/download.ts`): `GET` → página HTML
    com "Não quer mais receber lembretes da {loja}?" e o botão "Não quero mais receber" (form POST para a mesma URL);
    `POST` (botão ou corpo `List-Unsubscribe=One-Click`) → "Pronto: a {loja} não vai mais mandar lembretes de compra
    para este e-mail." Token inválido → "Este link não vale mais. Se quiser, responda a um e-mail da loja." Sem
    cache (`Cache-Control: no-store`) e `Referrer-Policy: no-referrer`.
  - Webhook do Resend: `email.bounced` → `email_optout` `bounce`; `email.complained` → `complaint`, pelo `to_hash` da
    linha do `email_log` casada.
  - Catálogo MCP: as duas ações ficam como as públicas do checkout (`checkout.saveLead`): nenhuma vira ferramenta.

- [ ] **Step 1: testes que falham** (`tests/recovery-unsubscribe.test.ts`):
  - `GET com token válido → 200 com o botão e nenhuma linha em email_optout`.
  - `POST com token válido → optout gravado e contatos abertos do e-mail apagados (os convertidos ficam)`.
  - `POST com corpo List-Unsubscribe=One-Click → optout gravado`.
  - `token de outra loja (host diferente) ou inventado → "Este link não vale mais" e nada gravado`.
  - `31º POST do mesmo IP na hora → nada gravado e a mesma página neutra`.
  - `resposta sem o e-mail; log sem o token`.
  - `tests/resend-webhook.test.ts`: `bounced e complained gravam email_optout com o to_hash`.
  - `tests/mcp-tools.test.ts`: `recovery.* não aparece como ferramenta em nenhum papel`.
- [ ] **Step 2:** `bun test tests/recovery-unsubscribe.test.ts tests/resend-webhook.test.ts tests/mcp-tools.test.ts` → FAIL.
- [ ] **Step 3: implementar.**
- [ ] **Step 4:** os mesmos → PASS e `bun run build` sem erro.
- [ ] **Step 5:** `bun run check` e commit `feat(recuperacao): descadastro de um clique e supressão por devolução ou spam`.

### Task 7: painel, métricas, retenção e documentação

**Files:**
- Modify: `src/lib/leads/panel.ts` (`leads.list` com `remindedAt`; `sweepLeadsJob` apaga `recovery_email` vencida),
  `src/app/admin/(panel)/contatos/page.tsx`, `src/lib/orders/panel.ts` (linha do tempo com `email_log` `recovery`),
  `src/lib/metrics.ts`, `src/lib/mcp/tools.ts` (projeção de `metrics.summary`), `src/app/admin/(panel)/page.tsx`
  (cartão da visão geral), `docs/instalacao.md` (seção "Recuperação de vendas por e-mail")
- Test: `tests/leads.test.ts`, `tests/orders.test.ts`, `tests/metrics.test.ts`, `tests/mcp-tools.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 4 e 5.
- Produces:
  - item de `leads.list` ganha `remindedAt: Date | null` (`sent_at` do lembrete do contato). A página mostra
    "Lembrete enviado em {data}".
  - linha do tempo do pedido: `"Lembrete de pagamento por e-mail"` (enviado) ou `"Lembrete por e-mail não enviado"` (falhou).
  - `MetricsSummary.recovery: { sent: number; recovered: number; recoveredRevenueCents: number; byCase: Record<"lead" | "pix" | "card", { sent: number; recovered: number }> }`,
    contando as linhas `sent` do período. Recuperado = existe pedido `paid|disputed|refunded` da mesma oferta, de cliente
    com o mesmo hash de e-mail, com `paid_at` entre `sent_at` e `sent_at + 7 d`. Receita = soma de `total_cents` desses
    pedidos, sem contar o mesmo pedido duas vezes. A projeção do MCP repassa `recovery` inteiro (só números).
  - `sweepLeadsJob` também apaga `recovery_email` com `expires_at < now()`; `email_optout` nunca.

- [ ] **Step 1: testes que falham:**
  - `tests/leads.test.ts`: `leads.list traz remindedAt do lembrete enviado`; `sweep apaga recovery_email vencida e mantém email_optout`.
  - `tests/orders.test.ts`: `linha do tempo mostra o lembrete enviado`.
  - `tests/metrics.test.ts`: `sent por caso; Pix pago 2 h depois do lembrete conta como recuperado e soma a receita;
    pago 8 dias depois não conta; dois lembretes para o mesmo pedido pago não somam a receita duas vezes`.
  - `tests/mcp-tools.test.ts`: `metrics_summary pelo MCP traz recovery só com números (nenhuma string com @)`.
- [ ] **Step 2:** `bun test tests/leads.test.ts tests/orders.test.ts tests/metrics.test.ts tests/mcp-tools.test.ts` → FAIL.
- [ ] **Step 3: implementar** e escrever a documentação: como ligar; os 3 casos e os prazos; os textos; descadastro;
  proteção do cartão; o que o MCP e o Telegram recebem (só números; nada); retenção; a nota sobre base legal.
- [ ] **Step 4:** os do Step 2 + `tests/jobs.test.ts` → PASS e `bun run build` sem erro.
- [ ] **Step 5:** `bun run check` e commit `feat(recuperacao): painel, métricas e documentação`.

## Fora deste PR

- Cupom, upsell/downsell, sequência pós-compra e segundo lembrete (D2).
- Texto editável pela loja (D3); preencher o checkout pelo link (D10); aviso no Telegram (D15).
- Descadastro manual de um e-mail pelo painel, e `email_hash` com HMAC (melhoria transversal, já anotada no PR #14).
- E2E do lembrete e do `/sair` (PR de verificação separado, pela regra do repo).
