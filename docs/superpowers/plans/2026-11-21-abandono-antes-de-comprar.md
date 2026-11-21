# Abandono antes de comprar: plano de implementação (PR 4b)

> **Para agentes:** sub-skill obrigatória: superpowers:subagent-driven-development (recomendada) ou
> superpowers:executing-plans, tarefa por tarefa. Os passos usam checkbox (`- [ ]`).

**Objetivo:** quando alguém preenche o e-mail no checkout e desiste **antes** de criar o pedido, a loja fica com o
contato (e-mail e celular) por pouco tempo, com aviso de privacidade visível antes da coleta, para avisar ou recuperar
essa pessoa. O Telegram avisa a equipe sem nenhum dado do comprador, e o MCP não enxerga esses contatos.

**Arquitetura:**
- Tabela `checkout_lead` (com `store_id` e RLS). A página do checkout gera uma chave aleatória por visita (`leadKey`,
  como já faz com o `eventId`). Ao sair do campo de e-mail válido (e depois do celular válido), o navegador chama a ação
  pública `checkout.saveLead`, que grava ou atualiza o contato **dessa chave** (só o sha256 da chave é guardado).
  "Não salvar meus dados" chama `checkout.forgetLead`, que apaga a linha.
- Ao criar um pedido (`createOrder`, mesma transação), os contatos abertos da loja com o mesmo e-mail (ou a mesma chave)
  viram `converted`, ligados ao pedido, e perdem e-mail e celular: daí em diante vale o pedido (e o aviso de "Carrinho
  abandonado" que já existe).
- Telegram: evento novo `lead_abandoned` (caixa própria, desligada por padrão), agendado para criado + o prazo do
  abandono que já existe; no envio confere que o contato continua aberto. Mensagem só com oferta, valor e um código do
  contato.
- Painel: página "Contatos" (`/admin/contatos`) para dono, admin e suporte, com copiar e-mail, WhatsApp, marcar como
  contatado e excluir (um ou todos de um e-mail). Varredura diária apaga tudo com mais de 30 dias.
- Permissões novas `leads.read` e `leads.write` entram em `TOKEN_DENIED`: nenhuma ação de contato sai pelo MCP, em
  nenhum papel, nem pela fila de aprovação.

**Stack:** Next 16 (rotas em Node), Drizzle e Postgres 17 (RLS), Zod 4, testes em Bun.

**Spec:** `docs/superpowers/specs/2026-11-20-kids-migracao-design.md` (seção "3. Telegram", "Ordem de entrega" 4b,
"O que seria fracasso"). Padrão de referência: `docs/superpowers/plans/2026-11-20-mcp-parte-2.md`.

> Não sou advogado: a base legal e o texto do aviso abaixo são a minha leitura da LGPD (arts. 6º, 7º IX, 9º, 10, 18 e
> 41) e do guia de legítimo interesse da ANPD. A loja é a controladora; vale conferir com quem cuida do jurídico antes
> de ligar em produção.

## Decisões para o dono aprovar

Cada linha traz a minha recomendação (**R**) e a alternativa. O que não estiver aqui segue a spec.

| # | Assunto | Recomendação | Alternativa | Custo da recomendação |
|---|---------|--------------|-------------|-----------------------|
| D1 | O que capturar | **R:** e-mail e celular (o WhatsApp é o canal de recuperação que funciona no Brasil). Nunca nome, CPF, IP nem user agent | Só e-mail | Um dado pessoal a mais guardado por até 30 dias |
| D2 | Quando capturar | **R:** ao sair do campo de e-mail com e-mail válido; o celular entra quando a pessoa sai do campo de celular válido (mesma chave, atualiza a linha) | A cada pausa na digitação (captura mais, mas grava e-mail incompleto e dispara muito mais chamadas) | Quem digita o e-mail e fecha a aba sem sair do campo não é capturado |
| D3 | Base legal e consentimento | **R:** legítimo interesse (art. 7º, IX), com aviso visível **antes** da coleta (embaixo do e-mail), coleta mínima, prazo curto e saída de um clique ("Não salvar meus dados"), que para a coleta e apaga o que já foi guardado | Consentimento: caixa **desmarcada** "Pode me avisar se eu não concluir a compra"; só captura se marcada | Exige da loja o registro do teste de balanceamento (a doc traz um modelo); risco jurídico um pouco maior que o consentimento. A alternativa captura bem menos gente |
| D4 | Liga/desliga | **R:** desligado por padrão; a loja liga em Configurações ("Guardar o contato de quem não finaliza a compra"), e só consegue ligar com um e-mail público de privacidade preenchido (D5) | Ligado para toda loja que tem o Telegram ligado | Um passo de configuração a mais |
| D5 | Canal para o titular | **R:** campo novo em Configurações, "E-mail para pedidos de privacidade" (público), obrigatório para ligar a captura e mostrado no "Saiba mais" do aviso | Sem campo novo; o texto manda responder a qualquer contato da loja | Um campo a mais; mas a LGPD pede um canal claro (art. 9º e 41) |
| D6 | Texto do aviso | **R:** o da seção "Texto do aviso" abaixo (curto embaixo do e-mail + "Saiba mais" expansível, sem página nova) | Página de política de privacidade da loja (URL configurável) | O detalhe fica dentro do checkout, não numa política completa da loja |
| D7 | Retenção | **R:** 30 dias a partir da captura (varredura diária `sweep_leads` apaga a linha, aberta ou convertida) | 7 dias (só o tempo da recuperação) ou 90 dias | 30 dias de contatos de quem não comprou guardados |
| D8 | Quando a pessoa compra depois | **R:** na **criação** do pedido (qualquer oferta da loja, mesmo e-mail, ou a mesma chave da página), o contato vira `converted`, ligado ao pedido, e perde e-mail e celular na hora; o painel mostra "Comprou — pedido #XXXX" | Converter só no **pagamento** (contato continua "aberto" enquanto o Pix não é pago) | Pix gerado e não pago sai da lista de contatos; a recuperação desse caso continua pelo aviso "Carrinho abandonado" do pedido, que já existe |
| D9 | Aviso no Telegram | **R:** evento novo "Abandono antes do pagamento", caixa própria e desligada por padrão, mesmo prazo do "Carrinho abandonado" (padrão 30 min). Texto: `Abandono antes do pagamento (30 min): Almanaque Bíblico Kids — R$ 9,90 — contato #3FA91C`. Sem dado do comprador e sem link | Reaproveitar a caixa "Carrinho abandonado" para os dois casos | Uma caixa a mais no cartão do Telegram |
| D10 | Spam de aviso | **R:** um aviso por contato; pula se outro contato com o mesmo e-mail já foi avisado nas últimas 24 h (a pessoa recarregou a página); teto de 30 avisos desse evento por loja por hora (o resto só aparece no painel) | Sem teto | Num pico real, avisos acima de 30/h ficam só no painel |
| D11 | Limites contra abuso na captura | **R:** contatos **novos**: 10 por IP por hora por loja e 500 por loja por hora; gravações por chave: 20 por hora. Sem Turnstile. Estourou: a ação falha calada (o comprador nunca vê erro) | Turnstile antes de capturar | Um robô com muitos IPs ainda injeta até 500 e-mails de terceiros por hora na lista (a loja só contata à mão; não há e-mail automático neste PR) |
| D12 | Quem vê no painel | **R:** dono, admin e suporte (`leads.read`, `leads.write`); tráfego não (não vê dado de comprador hoje) | Também tráfego | Nenhum relevante |
| D13 | O que o MCP vê | **R:** nada por contato (`leads.read`/`leads.write` em `TOKEN_DENIED`: fora do catálogo e da fila em todo papel). Só dois **números** novos em `metrics.summary`: `leads` (capturados no período) e `leadsConverted` (que viraram pedido) | Nem os números | O agente sabe quantos abandonaram, nunca quem |
| D14 | Recuperação automática por e-mail | **R:** fora deste PR (a spec põe "sequência de e-mails" fora do escopo); a loja contata à mão pelo painel (copiar e-mail, link do WhatsApp) | Um e-mail automático de recuperação pelo provedor da loja | Recuperação manual |
| D15 | Loja desliga a captura | **R:** para de capturar na hora; os contatos já guardados seguem até os 30 dias (ou até alguém excluir no painel) | Apagar tudo ao desligar | Contatos antigos ficam até vencer |

Decidido sem escolha (regra do dono, da spec ou do repo):
- **Nenhum dado pessoal do comprador sai pelo MCP (em nenhum papel), pelo Telegram, nem por log.** A auditoria das ações
  de contato nunca grava e-mail nem celular (só `leadId` ou `emailHash`).
- Tabela nova com `store_id` + `enable_store_rls`; o papel `card` não lê nem escreve nela.
- Página e server actions só chamam `runAction`.

### Texto do aviso (D6)

Embaixo do campo de e-mail, sempre visível quando a captura está ligada (antes de qualquer coleta):

> A {loja} guarda seu e-mail e celular por até 30 dias para falar com você se a compra não for concluída.
> **Não salvar meus dados** · **Saiba mais**

"Saiba mais" (expande ali mesmo):

> **Quem trata:** {loja}. **Para quê:** só para lembrar você desta compra; seus dados não são vendidos nem
> compartilhados. **Base legal:** legítimo interesse (LGPD, art. 7º, IX). **Por quanto tempo:** até 30 dias; se você
> concluir a compra, valem os dados do pedido e este registro perde o contato na hora. **Seus direitos:** peça acesso
> ou exclusão a qualquer momento por {privacyEmail}, ou toque em "Não salvar meus dados".

Depois de "Não salvar meus dados": o aviso vira "Pronto: seus dados não serão guardados antes da compra." e a página
não captura mais nada.

## Restrições globais

- **Dados:** só e-mail (minúsculo, até 254, `validEmail`) e celular (`normalizeBrMobile`). Nada de nome, CPF, IP, user
  agent ou toque na `checkout_lead`. `email_hash` = sha256 do e-mail normalizado; `key_hash` = sha256 da `leadKey`.
- **Prazos e números:** retenção 30 dias (`LEAD_TTL_DAYS = 30`); captura 10 novos/IP/h/loja, 500 novos/loja/h,
  20 gravações/chave/h (`LEAD_LIMITS`); Telegram 30 avisos `lead_abandoned`/loja/h e dedupe de 24 h por e-mail.
- **Log:** nunca e-mail, celular nem `leadKey`; só `leadId`, `storeId` e o motivo.
- **Telegram:** texto puro como os outros eventos (`telegramMessage`); código do contato = `leadCode(id)` (6 primeiros
  hex do UUID sem hífen, maiúsculos).
- **Testes:** nenhum literal com formato de segredo (`whsec_…`, token de bot, `re_…`, `fnl_…`, `upl_…`): monte em tempo
  de execução, como nos testes do PR 5. Sem skip/only/retry/espera fixa, sem ofuscar palavras para passar na higiene.
- **Regras do repo:** rotas e páginas só chamam `runAction`; toda tabela nova com `store_id` + `enable_store_rls`; sem
  APIs exclusivas do Bun em `src/`; toda ação nova classificada no catálogo MCP (aqui: `public` ou `TOKEN_DENIED`).
- **Escopo do PR:** produto. Não edita `e2e/`, `scripts/verify*`, `.github/`, `.claude/`, `REVIEW.md`.
- **Processo:** `bun run check` antes de cada commit; `bash scripts/verify.sh` (≈11–13 min, em segundo plano) antes do PR.

## Foco de revisão

1. **Contato saindo por onde não deve:** e-mail ou celular de um contato aparecendo em resposta de ferramenta MCP (em
   qualquer papel, inclusive `owner`), em pedido da fila de aprovação, em mensagem do Telegram, em `audit_log` ou em
   log. Testes nas Tasks 1, 2, 4 e 5.
2. **Captura sem aviso ou depois de "Não salvar":** loja com captura desligada, ou sem e-mail de privacidade, ou
   visitante que tocou "Não salvar" → nenhuma linha gravada; "Não salvar" depois de capturado apaga a linha. Testes nas
   Tasks 2 e 3.
3. **Sobrescrever o contato de outra pessoa:** sem a `leadKey` certa, ninguém altera nem apaga um contato (saber o
   e-mail não basta); chave de outra loja não acha nada. Teste na Task 2.
4. **Comprou e ainda recebe aviso:** pedido criado com o mesmo e-mail (outra oferta da loja) ou com a mesma chave e
   outro e-mail → contato `converted` sem e-mail e celular, e o job do Telegram pula. Testes nas Tasks 2 e 4.
5. **Enxurrada:** 11º contato novo do mesmo IP na hora, 21ª gravação da mesma chave, 31º aviso da loja na hora → nada
   gravado ou nada enviado, e o comprador não vê erro. Testes nas Tasks 2 e 4.

---

### Task 1: tabela, colunas da loja e permissões

**Files:**
- Create: `src/lib/db/schema/leads.ts` (exportado por `src/lib/db/schema/index.ts`), `drizzle/0031_checkout_lead.sql`
  (via `bun run migration --name checkout_lead`; acrescentar à mão `select enable_store_rls('checkout_lead');`)
- Modify: `src/lib/db/schema/core.ts` (store), `src/lib/actions/permissions.ts`, `src/lib/actions/core.ts` (`TOKEN_DENIED`)
- Test: `tests/leads.test.ts` (novo), `tests/card-role.test.ts`, `tests/mcp-tools.test.ts`, `tests/rls.test.ts`/`tests/migrate.test.ts` (se listam tabelas)

**Interfaces:**
- Produces:
  - `checkout_lead`: `id uuid pk`, `store_id → store (cascade)`, `offer_id → offer (cascade)`, `key_hash text not null`,
    `email text` (nulo depois de convertido), `email_hash text not null`, `phone text`, `status text not null default 'open'`
    (check `open | contacted | converted`), `order_id uuid → orders (set null)`, `notified_at timestamptz`,
    `telegram_message_id bigint`, `created_at`, `updated_at`, `expires_at timestamptz not null`.
    Restrições: único `(store_id, key_hash)`; check `status = 'converted' or email is not null`. Índices
    `(store_id, created_at desc)`, `(store_id, email_hash)`, `(expires_at)`.
  - `store.lead_capture boolean not null default false`, `store.privacy_email text` (nulo), check
    `not lead_capture or privacy_email is not null`.
  - `Permission` ganha `"leads.read"` e `"leads.write"` (owner, admin, support); `TOKEN_DENIED` passa a
    `["team.manage", "account.self", "approvals.decide", "leads.read", "leads.write"]`.

- [ ] **Step 1: testes que falham:**
  - `tests/leads.test.ts`: `RLS: contato de outra loja não aparece`; `check: converted sem e-mail ok, open sem e-mail recusado`;
    `check da loja: lead_capture sem privacy_email recusado`.
  - `tests/card-role.test.ts`: o papel `card` não lê `checkout_lead`.
  - `tests/mcp-tools.test.ts`: `leads.* em TOKEN_DENIED; nenhum papel (inclusive owner) enxerga ferramenta leads_*`.
- [ ] **Step 2:** `bun test tests/leads.test.ts tests/card-role.test.ts tests/mcp-tools.test.ts` → FAIL.
- [ ] **Step 3: implementar** (schema, migração, colunas da loja, permissões, `TOKEN_DENIED`).
- [ ] **Step 4:** os testes do Step 2 + `tests/migrate.test.ts tests/rls.test.ts tests/approvals-core.test.ts` → PASS.
- [ ] **Step 5:** `bun run check` e commit `feat(leads): tabela checkout_lead, colunas da loja e permissões`.

### Task 2: captura, "Não salvar", conversão no pedido e configuração da loja

**Files:**
- Create: `src/lib/leads/capture.ts` (ações públicas e conversão)
- Modify: `src/lib/checkout.ts` (`startInput` ganha `leadKey` opcional, repassado a `createOrder`),
  `src/lib/orders/create.ts` (chama `convertLeads`), `src/lib/store-settings.ts` (campos novos),
  `src/lib/catalog/offers.ts` (`offers.getPublic` devolve `leadCapture: { privacyEmail } | null`),
  `src/lib/actions/all.ts`
- Test: `tests/leads.test.ts`, `tests/checkout.test.ts`, `tests/panel-actions.test.ts` (settings)

**Interfaces:**
- Consumes: tabela e colunas da Task 1.
- Produces:
  - `LEAD_TTL_DAYS = 30`, `LEAD_LIMITS = { newPerIpPerHour: 10, newPerStorePerHour: 500, writesPerKeyPerHour: 20 }`.
  - `checkout.saveLead` (público, `audit: false`): entrada `{ slug, leadKey: uuid, email?, phone?, clientIp }`
    (pelo menos um de e-mail/celular; celular sozinho só atualiza linha existente). Captura desligada → `conflict`.
    Upsert por `(store_id, key_hash)`; linha `converted` não muda. Linha nova: `expires_at = now + 30 d`, devolve
    `{ created: boolean, leadId }` (o `leadId` só fica no servidor; a server action devolve `void`).
  - `checkout.forgetLead` (público, `audit: false`): `{ leadKey }` → apaga a linha da chave (não `converted`); sem
    linha → ok (não revela nada).
  - `convertLeads(tx, storeId, { email: string; leadKey?: string; orderId: string }): Promise<void>` → `update` para
    `converted`, `order_id`, `email = null`, `phone = null` onde `status in ('open','contacted')` e
    (`email_hash` igual **ou** `key_hash` igual).
  - `store.updateSettings` aceita `leadCapture?: boolean` e `privacyEmail?: string | null` (`z.email`);
    ligar sem e-mail → `invalid_input` no campo `privacyEmail`. `store.getSettings` devolve os dois.

- [ ] **Step 1: testes que falham** (`tests/leads.test.ts`):
  - `captura desligada → conflict e nenhuma linha`.
  - `e-mail válido grava; segundo saveLead da mesma chave com celular atualiza a mesma linha`.
  - `celular sem linha existente → nada gravado`.
  - `outra chave com o mesmo e-mail cria outra linha; chave de outra loja não toca a linha`.
  - `forgetLead apaga só a linha da chave; forgetLead de chave desconhecida → ok`.
  - `11º contato novo do mesmo IP na hora → rate_limited; 21ª gravação da chave → rate_limited`.
  - `nenhum audit_log nem log com o e-mail ou o celular` (captura de `log` como em `tests/telegram.test.ts`).
  - `tests/checkout.test.ts`: `pedido criado com o mesmo e-mail (outra oferta) converte o contato e zera e-mail e celular`;
    `pedido com a mesma leadKey e outro e-mail também converte`; `contato de outra loja com o mesmo e-mail não muda`.
  - settings: `ligar a captura sem privacyEmail → invalid_input`.
- [ ] **Step 2:** `bun test tests/leads.test.ts tests/checkout.test.ts` → FAIL.
- [ ] **Step 3: implementar** (limites no `prepare` com `checkRateLimit`, chaves `leads:new:ip:<storeId>:<ipRateKey>`,
  `leads:new:store:<storeId>`, `leads:key:<storeId>:<key_hash>`; a de contato novo só conta quando a linha não existia,
  no padrão `peekRateLimit`/`hitRateLimit` de `checkout.start`).
- [ ] **Step 4:** `bun test tests/leads.test.ts tests/checkout.test.ts tests/panel-actions.test.ts tests/catalog.test.ts` → PASS.
- [ ] **Step 5:** `bun run check` e commit `feat(leads): captura do contato no checkout e conversão no pedido`.

### Task 3: checkout (aviso, captura ao sair do campo) e Configurações

**Files:**
- Create: `src/app/c/[slug]/lead-capture.ts` (lógica pura: quando chamar o servidor)
- Modify: `src/app/c/[slug]/page.tsx` (`leadKey = randomUUID()` e `leadCapture` da oferta),
  `src/app/c/[slug]/actions.ts` (`saveLeadAction`, `forgetLeadAction`: `runAction`, IP do servidor, sempre `void`, erro
  engolido), `src/app/c/[slug]/checkout-form.tsx` (aviso, `onBlur` no e-mail e no celular, `leadKey` no `checkout.start`),
  `src/app/(design)/buyer.module.css`, `src/app/admin/(panel)/settings/form.tsx`
- Test: `tests/lead-capture.test.ts` (novo)

**Interfaces:**
- Consumes: `checkout.saveLead`, `checkout.forgetLead`, `offers.getPublic().leadCapture` (Task 2).
- Produces: `nextLeadSend(state: { optedOut: boolean; sent: { email: string | null; phone: string | null } }, field: "email" | "phone", values: { email: string; phone: string }): { email?: string; phone?: string } | null`
  — devolve o que mandar (só valores válidos e diferentes do último enviado; celular só depois de um e-mail enviado;
  nada depois de `optedOut`).

- [ ] **Step 1: testes que falham** (`tests/lead-capture.test.ts`): `e-mail inválido → null`; `e-mail válido → { email }`;
  `mesmo e-mail de novo → null`; `celular antes de e-mail → null`; `celular válido depois do e-mail → { phone }`;
  `optedOut → sempre null`.
- [ ] **Step 2:** `bun test tests/lead-capture.test.ts` → FAIL.
- [ ] **Step 3: implementar** `nextLeadSend` e o formulário: aviso e "Saiba mais" com o texto exato da seção D6 (só com
  `leadCapture` não nulo); "Não salvar meus dados" marca `optedOut` e chama `forgetLeadAction` se já enviou algo;
  Configurações: caixa "Guardar o contato de quem não finaliza a compra" e campo "E-mail para pedidos de privacidade",
  com a ajuda "Aparece no aviso de privacidade do checkout."
- [ ] **Step 4:** `bun test tests/lead-capture.test.ts` → PASS e `bun run build` sem erro.
- [ ] **Step 5:** `bun run check` e commit `feat(leads): aviso de privacidade e captura no checkout`.

### Task 4: aviso no Telegram

**Files:**
- Modify: `src/lib/notify/telegram.ts` (evento `lead_abandoned`, `leadCode`), `src/lib/notify/telegram-connection.ts`
  (flag `leadAbandoned`, padrão `false`, aceita em `saveTelegram`), `src/lib/notify/telegram-job.ts` (payload em união),
  `src/lib/leads/capture.ts` (enfileira na criação), `src/lib/connections.ts`,
  `src/app/admin/(panel)/connections/cards.tsx` (caixa "Abandono antes do pagamento")
- Test: `tests/telegram.test.ts`

**Interfaces:**
- Consumes: `checkout_lead` (Task 1), `checkout.saveLead` (Task 2).
- Produces:
  - payload `notify_telegram`: `{ event: "sale"|"pix_generated"|"card_declined"|"abandoned"; orderId; afterMinutes? }`
    **ou** `{ event: "lead_abandoned"; leadId: uuid; afterMinutes }`.
  - `leadCode(id: string): string`; `telegramMessage("lead_abandoned", { productName, bumpName: null, totalCents, method, orderCode: leadCode(id), abandonAfterMinutes })`
    → `Abandono antes do pagamento (30 min): <oferta> — R$ 9,90 — contato #3FA91C` (o `method` é ignorado neste evento).
  - enfileirado só quando `saveLead` **cria** a linha e a flag está ligada, com `runAt = created + abandonAfterMinutes`.
  - envio: pula se o contato não existe, não está `open`, já tem `notified_at`, antes do prazo, flag desligada, outro
    contato com o mesmo `email_hash` avisado nas últimas 24 h, ou 30 avisos `lead_abandoned` da loja na hora
    (`checkRateLimit("telegram:lead:<storeId>", 30, 3600)`); depois de enviar grava `notified_at` e `telegram_message_id`
    com `where notified_at is null`. Valor = preço atual da oferta; nome = mesmo critério do aviso de pedido.

- [ ] **Step 1: testes que falham** (`tests/telegram.test.ts`, com o `fetch` falso):
  - `contato aberto depois do prazo → envia; o texto não contém o e-mail nem o celular nem dígitos do celular`.
  - `convertido / contatado / apagado / antes do prazo / flag desligada → não envia`.
  - `segundo job do mesmo contato → não envia de novo`.
  - `outro contato com o mesmo e-mail já avisado há < 24 h → não envia`.
  - `31º aviso da loja na hora → não envia`.
  - `saveLead cria → um job lead_abandoned agendado; atualização da mesma chave → nenhum job a mais`.
- [ ] **Step 2:** `bun test tests/telegram.test.ts` → FAIL.
- [ ] **Step 3: implementar.**
- [ ] **Step 4:** `bun test tests/telegram.test.ts tests/leads.test.ts` → PASS.
- [ ] **Step 5:** `bun run check` e commit `feat(telegram): aviso de abandono antes do pagamento`.

### Task 5: ações do painel, varredura e métricas

**Files:**
- Create: `src/lib/leads/panel.ts`
- Modify: `src/lib/jobs.ts` (`"sweep_leads"`), `src/lib/jobs/handlers.ts`, `src/lib/jobs/worker.ts` (diário, como
  `sweep_watermarks`), `src/lib/metrics.ts` (`leads`, `leadsConverted`), `src/lib/mcp/tools.ts` (projeção de
  `metrics.summary` com os dois números), `src/lib/actions/all.ts`
- Test: `tests/leads.test.ts`, `tests/metrics.test.ts`, `tests/mcp-tools.test.ts`

**Interfaces:**
- Consumes: tabela (Task 1).
- Produces:
  - `leads.list` (`leads.read`): `{ status?: "open"|"contacted"|"converted"; q?: string; page?: number }` → 50 por
    página, mais novos primeiro; `q` = código do contato ou e-mail exato. Item: `{ id, code, createdAt, status, offerName, email, phone, orderCode }`.
  - `leads.markContacted` (`leads.write`): `{ id }` → `open → contacted`; auditoria só `{ leadId }`.
  - `leads.delete` (`leads.write`): `{ id }`; `leads.forgetEmail` (`leads.write`): `{ email }` → apaga todos da loja com
    o `email_hash`, devolve `{ deleted: number }`; auditoria só `{ emailHash }`.
  - `sweepLeadsJob`: apaga `expires_at < now()` loja a loja (padrão de `expireOrdersHandler`).
  - `metrics.summary` ganha `leads` e `leadsConverted` (contagens no período).

- [ ] **Step 1: testes que falham:**
  - `leads.list mostra e-mail e celular para suporte; tráfego → forbidden`.
  - `markContacted, delete e forgetEmail: auditoria sem e-mail nem celular`.
  - `forgetEmail apaga só os contatos da loja com aquele e-mail`.
  - `sweep apaga só os vencidos, de todas as lojas`.
  - `tests/metrics.test.ts`: `leads e leadsConverted contam no período`.
  - `tests/mcp-tools.test.ts`: `metrics_summary pelo MCP traz leads e leadsConverted como números e nada mais de contato`;
    `token owner chamando leads_list pelo callMcpTool → forbidden`.
- [ ] **Step 2:** `bun test tests/leads.test.ts tests/metrics.test.ts tests/mcp-tools.test.ts` → FAIL.
- [ ] **Step 3: implementar.**
- [ ] **Step 4:** os testes do Step 2 + `tests/jobs.test.ts` → PASS.
- [ ] **Step 5:** `bun run check` e commit `feat(leads): ações do painel, varredura de 30 dias e métricas`.

### Task 6: página "Contatos" e documentação

**Files:**
- Create: `src/app/admin/(panel)/contatos/page.tsx`, `src/app/admin/(panel)/contatos/lead-actions.tsx`
- Modify: `src/app/admin/(panel)/actions.ts` (`markLeadContactedAction`, `deleteLeadAction`, `forgetLeadEmailAction`),
  `src/app/admin/(panel)/layout.tsx` (item "Contatos", ícone existente, para `leads.read`), `src/app/admin/(panel)/page.tsx`
  (os dois números na visão geral), `docs/instalacao.md` (seção "Abandono antes de comprar": como ligar, texto do aviso,
  base legal e o modelo curto de teste de balanceamento, 30 dias, o que o Telegram e o MCP recebem)
- Test: nenhum unitário novo (as ações têm teste); `bun run build` + check.

- [ ] **Step 1: página** (padrão visual de `/admin/orders`): filtro por status (Abertos, Contatados, Compraram), busca
  por código ou e-mail, linhas com quando, oferta, e-mail (botão copiar), celular com link `https://wa.me/55<dígitos>`
  (`rel="noopener noreferrer"`), status e ações "Marcar como contatado" e "Excluir" (confirmação); convertido mostra
  "Comprou — pedido #XXXX" com link para o pedido e sem contato; rodapé "Contatos são apagados 30 dias depois da
  captura." e "Excluir todos deste e-mail" (pedido do titular). Vazio com a captura desligada: "A captura está
  desligada. Ligue em Configurações." Vazio ligado: "Nenhum contato de quem não finalizou a compra."
- [ ] **Step 2: server actions** (`requirePanelActor` + `runAction`; mensagens "Marcado como contatado.",
  "Contato excluído.", "N contato(s) excluído(s).").
- [ ] **Step 3: documentação.**
- [ ] **Step 4:** `bun run build` sem erro.
- [ ] **Step 5:** `bun run check` e commit `feat(leads): página de contatos e documentação`.

## Fora deste PR

- E-mail automático de recuperação e sequência de e-mails (D14; spec: fora do escopo).
- Turnstile na captura (D11), política de privacidade da loja por URL (D6), apagar ao desligar (D15).
- E2E do checkout com a captura (PR de verificação separado, pela regra do repo).
- Pendências do Telegram já anotadas (teto geral por loja, 429 com `retry_after`).
