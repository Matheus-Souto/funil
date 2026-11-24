# Cobrança de apps pelo funil, fase 1 (PeticionaAqui): plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** o funil passa a cobrar para um app com conta de usuário: registra o início do teste e cria pagamentos pela API, cobra o plano anual e pacotes fixos de créditos, avisa o app por webhook assinado e mostra a conversão teste → pagante por campanha, com o PeticionaAqui como segunda loja em produção.

**Architecture:** chave de integração = token da loja (`mcp_token`) com o papel novo `integration`, que só abre a API `/api/integracao/v1/*`. Oferta ganha `delivery = 'app'`: sem PDF, à vista, só Pix do Asaas ou cartão, com `app_code`. O app cria uma sessão de pagamento (servidor a servidor) e redireciona para `/c/<oferta>?s=<id>`; o pedido pago enfileira `notify_app` em vez de `deliver_order`. O início do teste vira `app_trial` + evento `StartTrial` no Meta.

**Tech Stack:** Next.js 16, React 19, Drizzle + Postgres 17 (RLS), Zod 4, Bun test, Node em produção.

**Spec:** `docs/superpowers/specs/2026-11-24-cobranca-de-apps-design.md` (seções citadas como §).

## Global Constraints

- Dinheiro em centavos inteiros; nada de ponto flutuante.
- Rota e página nova chamam só `runAction`; regra de negócio nas ações (`defineAction`).
- Tabela nova tem `store_id` e chama `enable_store_rls`; FKs compostas `(store_id, id)` para amarrar à loja, como `coupon_offer`.
- O papel `card` não ganha permissão nova (`tests/card-role.test.ts` lista as tabelas negadas; acrescentar as novas).
- Nenhum dado pessoal do comprador em log, MCP, Telegram, auditoria em claro ou URL (e-mail só como sha256 na auditoria).
- Cartão nunca persistido nem logado.
- Node em produção: nada de API exclusiva do Bun em `src/`.
- Toda ação nova classificada no catálogo MCP (`src/lib/mcp/tools.ts`): exposta (com projeção por lista branca) ou em `MCP_EXCLUDED`.
- Não editar `e2e/`, `scripts/verify*`, `.github/`, `.claude/`, `REVIEW.md` nos PRs de produto (E2E vai em PR de verificação).
- Textos de tela seguem `docs/padrao-de-paginas.md` (Arc, cores do tema, ícones, textos).
- Migrações novas numeradas a partir de `0038`.
- Oferta `app`: `max_installments = 1`, `pix_mode = 'asaas'`, sem bump, sem produtos, sem cupom (§4, §7.4, §7.5).
- Sessão de pagamento expira em 60 min (§7.4). Retenção: ip e user agent do teste apagados em até 7 dias; teste que não virou pagamento apagado em 180 dias (§7.3, §7.9).
- Webhook ao app: novas tentativas em 1 min, 5 min, 30 min, 2 h, 6 h, 24 h (até 48 h); 2xx em até 10 s; `t` aceito até 5 min (§7.6).
- Limite da API de integração: 60 requisições por minuto por chave (§9).
- Commits: `git -c user.name="Matheus Souto" -c user.email=79191133+Matheus-Souto@users.noreply.github.com commit`, terminando com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. `bun run check` antes de cada commit. Implementadores não usam `git stash` nem `pkill`/`killall` por nome.

## Review Focus

1. **Duas chamadas iguais ao mesmo tempo** (`POST /testes` ou `/pagamentos` repetido pelo app numa nova tentativa de rede): um registro de teste por conta e um evento `StartTrial` só; sessões repetidas não geram dois pedidos pagos para o mesmo clique. → Task 6 e Task 7.
2. **Sessão usada depois de paga, vencida ou de outra oferta/loja** (`?s=` copiado, voltar no navegador, trocar o slug na URL): checkout recusa com mensagem clara e nenhum pedido sai sem a conta da sessão. → Task 7.
3. **App fora do ar ou respondendo devagar/3xx/redirecionando para IP privado**: o aviso não se perde (novas tentativas, alerta, reenviar) e o funil nunca segue redirecionamento nem fala com host privado. → Task 9.
4. **Mesmo pagamento avisado duas vezes** (job at-least-once, reenvio manual): o `id` do evento é estável por (pedido, tipo, ocorrência), então o app deduplica. → Task 9.
5. **CNPJ válido de escritório no Pix do Asaas e no titular do cartão**, e CPF/CNPJ inválido com a mensagem certa; loja sem a opção continua só com CPF. → Task 8.

---

## Parte 1 — Várias lojas em produção (PR 1)

### Task 1: Definir o domínio de uma loja existente (CLI `store-domain`)

**Files:**
- Modify: `src/lib/stores.ts` (nova função; reaproveita a validação de `domain` do `createStoreWithOwner`, linha ~131)
- Create: `scripts/store-domain.ts`
- Create: `deploy/store-domain.sh`
- Modify: `deploy/Dockerfile:35` (empacotar `scripts/store-domain.ts`) e `:83-85` (copiar e `chmod` o wrapper), `deploy/Dockerfile.dockerignore` (`!scripts/store-domain.ts`)
- Modify: `package.json` (`"store:domain": "bun scripts/store-domain.ts"`)
- Test: `tests/stores.test.ts`

**Interfaces:**
- Produces: `setStoreDomain(input: { slug: string; domain: string | null }): Promise<{ storeId: string; previous: string | null }>` em `src/lib/stores.ts`.

- [ ] **Step 1: testes que falham** em `tests/stores.test.ts`:
  - `setStoreDomain grava o domínio normalizado (minúsculas) e resolve a loja por ele`: depois de `setStoreDomain({ slug, domain: "Checkout.Exemplo.com.br" })`, a resolução de loja por host (`MODE=multi`, mesma função que a linha 39 usa) com `checkout.exemplo.com.br` devolve a loja; `previous` é `null`.
  - `setStoreDomain recusa domínio de outra loja` → `ActionError` `conflict`.
  - `setStoreDomain recusa domínio inválido` (`"http://x"`, `"x"`, `"*.exemplo.com"`) → `invalid_input`, com a mesma regra do `store-create`.
  - `setStoreDomain com null apaga o domínio` e `previous` traz o antigo.
  - `setStoreDomain com slug inexistente` → `not_found`.
  - Grava em `audit_log` uma linha `store.setDomain` com `{ slug, domain, previous }` e ator `system`.
- [ ] **Step 2:** `bun test tests/stores.test.ts` → FAIL (`setStoreDomain` não existe).
- [ ] **Step 3:** implementar `setStoreDomain` (transação com o papel dono, como `createStoreWithOwner`); `scripts/store-domain.ts` com `parseArgs` (`--slug`, `--domain` ou `--clear`), só com `MODE=multi` (mesma mensagem do `store-create`), imprime `Domínio da loja <slug>: <antes> -> <depois>`; wrapper `deploy/store-domain.sh` igual ao `deploy/store-create.sh`.
- [ ] **Step 4:** `bun test tests/stores.test.ts` → PASS; `bun run check` → OK.
- [ ] **Step 5:** commit `feat(lojas): CLI store-domain para definir o domínio de uma loja existente`.

### Task 2: Roteiro da migração da produção para várias lojas

**Files:**
- Modify: `docs/instalacao.md` (seção 11: `store-domain`; nova subseção "Passar uma instalação `single` para `multi`")

- [ ] **Step 1:** escrever o roteiro (§7.1), com comandos e conferências, sem segredos:
  1. Backup (`docs/instalacao.md`, seção de backup) e conferir `select count(*) from store` = 1.
  2. `.env`: `MODE=multi`, `PLATFORM_DOMAIN=checkout.moradah.com.br`, `DOMAIN` mantido; atualizar a cópia no Infisical junto.
  3. Antes de reiniciar: `docker compose exec app store-domain --slug <slug da Kids> --domain checkout.moradah.com.br` (funciona com `MODE=multi` passado por `-e`, como no smoke).
  4. Reiniciar `app` e `card`; conferir `/api/health`, abrir `/c/<oferta>` da Kids, `pagar.checkout.moradah.com.br/form.js`, login no painel.
  5. Caminho de volta: `.env` antigo + `docker compose up -d` (o `store.domain` preenchido não atrapalha o `single`).
  6. Nova loja: `store-create --name PeticionaAqui --slug peticionaaqui --owner-email <e-mail> --domain checkout.peticionaaqui.com.br`; DNS (nuvem cinza) e `Caddyfile.local` (lista fixa) com o domínio novo; hostname no widget do Turnstile; segundo webhook no Asaas com o `webhookToken` da loja nova.
- [ ] **Step 2:** `bun run check` → OK; commit `docs(lojas): roteiro para passar a produção para várias lojas`.

> PR 1 = Tasks 1–2. **PR de verificação V1** (separado, depois do merge do PR 1, toca `e2e/` e talvez `scripts/verify.sh`): E2E com duas lojas lado a lado (pedidos isolados, webhook do Asaas de uma loja ignorado pela outra com 200, painel de uma sem dados da outra). Desenho do V1 combinado com o dono antes, porque o verify hoje sobe o app em `single`.

---

## Parte 2 — API de integração e entrega para app (PR 2)

### Task 3: Banco (migração 0038)

**Files:**
- Create: `drizzle/0038_app_billing.sql` (+ entrada no journal do drizzle, como na 0037)
- Create: `src/lib/db/schema/apps.ts`; Modify: `src/lib/db/schema/index.ts`, `core.ts`, `catalog.ts`, `orders.ts`, `tracking.ts`, `mcp.ts`, `integrations.ts`
- Test: `tests/rls.test.ts`, `tests/card-role.test.ts`, `tests/migrate.test.ts` (se lista migrações)

**Interfaces (Produces, nomes de coluna em snake_case no banco):**
- `store.accept_cnpj boolean not null default false`.
- `offer.delivery text not null default 'download'` check `in ('download','app')`; `offer.app_code text` check `^[a-z0-9_]{1,40}$`; check `delivery = 'app'` ⇔ `app_code is not null`; check `delivery <> 'app' or (max_installments = 1 and pix_mode = 'asaas' and bump_price_cents is null)`; unique `(store_id, app_code)`.
- `mcp_token_role_check` aceita `'integration'`.
- `integration_kind_check` aceita `'app_webhook'` (config `{ url }`, segredo selado).
- `app_trial`: `id`, `store_id`, `account text not null` (1..64), `email_hash text not null`, `mailbox_hash text not null`, `first_touch jsonb`, `ref text`, `fbc text`, `fbp text`, `client_ip text`, `user_agent text`, `event_id text not null`, `started_at timestamptz not null`, `created_at`; unique `(store_id, account)`; unique `(store_id, id)`.
- `app_checkout_session`: `id uuid` (é o `?s=`), `store_id`, `offer_id` (FK composta), `account`, `buyer_name`, `buyer_email`, `buyer_phone` (nulo), `touch jsonb`, `ref`, `fbc`, `fbp`, `return_url text`, `expires_at`, `order_id uuid` (nulo; FK composta para `orders`), `created_at`; unique `(store_id, id)`.
- `orders.app_account text` e `orders.app_session_id uuid` (FK composta para a sessão; nulos em pedido `download`).
- `app_webhook_delivery`: `id`, `store_id`, `event_id text not null unique`, `event_type text` check `in ('pagamento.confirmado','pagamento.reembolsado','pagamento.reembolso_parcial','pagamento.contestado','pagamento.restabelecido','ping')`, `order_id uuid` (nulo no ping), `status text` check `in ('pending','delivered','failed')`, `attempts int not null default 0`, `last_http_status int`, `created_at`, `delivered_at`.
- `conversion`: `order_id` passa a aceitar nulo, nova coluna `trial_id uuid` (FK composta para `app_trial`, cascade), check `(order_id is null) <> (trial_id is null)`, `conversion_event_check` aceita `'StartTrial'`, unique `(trial_id, event)`.
- Todas as tabelas novas com `enable_store_rls`.

- [ ] **Step 1: testes que falham:** em `tests/rls.test.ts`, `app_trial`, `app_checkout_session` e `app_webhook_delivery` de uma loja não aparecem para outra (mesmo padrão das tabelas existentes); em `tests/card-role.test.ts`, as três tabelas novas entram na lista de negadas ao papel `card`; um teste novo em `tests/catalog.test.ts`: inserir oferta `app` com `max_installments = 3` falha pelo check.
- [ ] **Step 2:** `bun test tests/rls.test.ts tests/card-role.test.ts tests/catalog.test.ts` → FAIL.
- [ ] **Step 3:** escrever schema Drizzle e a migração SQL.
- [ ] **Step 4:** os mesmos testes → PASS; `bun run check` → OK.
- [ ] **Step 5:** commit `feat(apps): tabelas de teste, sessão de pagamento e aviso ao app`.

### Task 4: Chave de integração (papel `integration`) e borda HTTP da API

**Files:**
- Modify: `src/lib/actions/permissions.ts` (papel `integration`, permissão `integration.use`), `src/lib/actions/core.ts` (`TOKEN_DENIED` não muda; ver abaixo), `src/lib/mcp/tokens.ts` (`TOKEN_ROLES` ganha `integration`), `src/lib/mcp/server.ts` (token `integration` → 401 no MCP)
- Create: `src/lib/apps/http.ts`
- Test: `tests/mcp-tokens.test.ts`, `tests/mcp-endpoint.test.ts`, `tests/apps-http.test.ts` (novo)

**Interfaces:**
- Produces: `ROLE_PERMISSIONS.integration = ["integration.use"]`; nenhum outro papel tem `integration.use`.
- Produces: `handleIntegrationRequest(req: Request, run: (call: { storeId: string; actor: Actor; origin: "api" }, body: unknown) => Promise<unknown>, opts?: { now?: () => Date; trustProxy?: boolean }): Promise<Response>` em `src/lib/apps/http.ts`: lê `Authorization: Bearer`, autentica com `authenticateMcpToken`, exige `role === "integration"`, limite `60/min` por token (`checkRateLimit("apps:<tokenId>", 60, 60)`), mesmo balde de falhas de autenticação por IP do MCP, corpo até 32 KB, JSON; mapeia `ActionError` → HTTP: `invalid_input` 422, `not_found` 404, `conflict` 409, `forbidden` 403, `rate_limited` 429, demais 500 (corpo `{ erro: { codigo, mensagem, detalhes? } }`), sucesso com o status que `run` devolver (`{ status, body }`).

- [ ] **Step 1: testes que falham:**
  - `tests/mcp-tokens.test.ts`: `createMcpToken` aceita `role: "integration"`.
  - `tests/mcp-endpoint.test.ts`: token `integration` válido no `/api/mcp` → 401.
  - `tests/apps-http.test.ts`: sem token → 401; token `reader` → 401; token `integration` revogado → 401; corpo > 32 KB → 413; JSON inválido → 400; 61ª chamada no minuto → 429; `ActionError("conflict")` vira 409 com `{ erro: { codigo: "conflict" } }`.
- [ ] **Step 2:** rodar os três arquivos → FAIL.
- [ ] **Step 3:** implementar.
- [ ] **Step 4:** PASS; `bun run check`.
- [ ] **Step 5:** commit `feat(apps): chave de integração da loja e borda HTTP da API`.

### Task 5: Oferta de app no catálogo e no editor

**Files:**
- Modify: `src/lib/catalog/offers.ts` (`offers.create`, `offers.update`: campos `delivery`, `appCode`), `src/lib/catalog/checkout-offer.ts` (expor `delivery`), `src/lib/mcp/tools.ts` (projeção de ofertas inclui `delivery` e `appCode`)
- Modify: `src/app/admin/(panel)/offers/[id]/…` (editor: seletor "Entrega: download | app" e campo "Código no app"; com `app`, esconde produtos, bump, parcelas e Pix manual)
- Test: `tests/catalog.test.ts`, `tests/mcp-tools.test.ts`

**Interfaces:**
- Produces: entrada `delivery: "download" | "app"` (padrão `"download"`) e `appCode?: string` (regex `^[a-z0-9_]{1,40}$`) em `offers.create` e `offers.update`; oferta `app` exige `productIds = []`, `bump = null`, `maxInstallments = 1`, `pixMode = "asaas"`, senão `invalid_input` com o caminho do campo. `appCode` repetido na loja → `conflict` "Código já usado por outra oferta".
- Produces: `CheckoutOffer.delivery`.

- [ ] **Step 1: testes que falham** (`tests/catalog.test.ts`): cria oferta `app` sem produtos com `appCode: "start_anual"`; recusa `app` com produtos, com bump, com `maxInstallments: 3`, com `pixMode: "manual"`, com `appCode` ausente ou `"Start Anual"`; recusa `appCode` duplicado; oferta `download` continua exigindo produto como hoje. `tests/mcp-tools.test.ts`: projeção de `offers.list` traz `delivery` e `appCode`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar ações e editor. **Step 4:** PASS + `bun run check`.
- [ ] **Step 5:** commit `feat(apps): oferta de app no catálogo e no editor`.

### Task 6: Início do teste (`POST /api/integracao/v1/testes`), `StartTrial` e retenção

**Files:**
- Create: `src/lib/apps/trials.ts`, `src/app/api/integracao/v1/testes/route.ts`
- Modify: `src/lib/tracking/meta.ts` (`StartTrial`), `src/lib/jobs.ts` (`JobType` `sweep_app_trials`), `src/lib/jobs/handlers.ts`, agendamento periódico onde os outros `sweep_*` são agendados
- Test: `tests/apps-trials.test.ts` (novo), `tests/meta.test.ts`

**Interfaces:**
- Produces: ação `apps.registerTrial` (permissão `integration.use`, em `MCP_EXCLUDED`), entrada:
  `{ conta: string(1..64), email, nome?: string(2..120), telefone?: string, origem?: { utm_source?, utm_medium?, utm_campaign?, utm_content?, utm_term?, fbclid?, ref?, fbc?, fbp? } (limites do touch.ts), ip?: string(≤64), user_agent?: string(≤500), iniciado_em?: ISO datetime (não futura, até 7 dias atrás), event_id?: META_EVENT_ID_RE }`; saída `{ id: string; criado: boolean }`. Auditoria só com `{ conta_hash: sha256(conta), emailHash }`.
- Produces: `trialEventId(trialId: string): string` = `trial:<id>` quando o app não mandou `event_id`.
- Produces: `meta_event` aceita `{ event: "StartTrial", trialId }`; marca em `conversion` por `trial_id`.
- Produces: job `sweep_app_trials`: zera `client_ip`/`user_agent` de testes com `created_at < now() - 7 days` e apaga testes com `created_at < now() - 180 days` sem pedido pago da mesma `(store_id, account)`.
- Rota: `POST` → `handleIntegrationRequest` → `runAction(apps.registerTrial)` → `201 { id }` (novo) ou `200 { id }` (já existia).

- [ ] **Step 1: testes que falham** (`tests/apps-trials.test.ts`):
  - grava `app_trial` com `email_hash`, `mailbox_hash` (como a recuperação) e sem e-mail em claro em nenhuma coluna; `fbc` derivado de `fbclid` quando `fbc` não vem (`fbcFromFbclid`).
  - segunda chamada com a mesma `conta` → `criado: false`, mesmo `id`, um só job `meta_event` `StartTrial`.
  - duas chamadas simultâneas (`Promise.all`) com a mesma `conta` → um registro, um job.
  - `iniciado_em` no futuro → `invalid_input`.
  - `sweep_app_trials`: teste de 8 dias perde ip/user agent e mantém o resto; teste de 181 dias sem pagamento some; teste de 181 dias com pedido pago da mesma conta fica.
  - `tests/meta.test.ts`: `StartTrial` manda `event_name: "StartTrial"`, `event_id` do registro, `user_data.em` = sha256 do e-mail normalizado, `external_id` = sha256(conta), `fbc`, `fbp`, `client_ip_address`, `client_user_agent`, `custom_data: { value: 0, currency: "BRL" }`; não reenvia com marca `sent`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. O payload do job `meta_event` `StartTrial` leva só `trialId` e o sha256 do e-mail normalizado (o que o Meta recebe); o e-mail em claro não é gravado em lugar nenhum. **Step 4:** PASS + `bun run check`.
- [ ] **Step 5:** commit `feat(apps): início do teste pela API, StartTrial e retenção`.

### Task 7: Sessão de pagamento (`POST /api/integracao/v1/pagamentos`) e checkout com `?s=`

**Files:**
- Create: `src/lib/apps/sessions.ts`, `src/app/api/integracao/v1/pagamentos/route.ts`
- Modify: `src/lib/checkout.ts` (`checkout.start` aceita `sessionId`), `src/lib/orders/create.ts` (grava `app_account`, `app_session_id`, toque da sessão), `src/app/c/[slug]/page.tsx`, `checkout-form.tsx`, `actions.ts`
- Test: `tests/apps-sessions.test.ts` (novo), `tests/checkout.test.ts`

**Interfaces:**
- Produces: ação `apps.createPayment` (permissão `integration.use`, `MCP_EXCLUDED`), entrada `{ conta, oferta: slug, email, nome, telefone?, origem? (como em registerTrial), retorno?: URL https }`; saída `{ url: string; expira_em: string }`, `url = <origem da loja>/c/<slug>?s=<id>`. Oferta inexistente, inativa ou `download` → `not_found` "Oferta de app não encontrada". `retorno` só com host igual ao domínio da loja ou a um host listado em `app_webhook` (`config.returnHosts`); senão `invalid_input`.
- Produces: `loadCheckoutSession(tx, storeId, sessionId): Promise<CheckoutSession | null>` (só sessão não vencida e sem `order_id` de pedido pago).
- `checkout.start` ganha `sessionId?: uuid`. Regras: oferta `app` sem `sessionId` → `invalid_input` "Abra o pagamento pelo app"; sessão de outra oferta/loja, vencida ou já paga → `conflict` com `{ code: "SESSION_INVALID" }` e mensagem "Este link de pagamento venceu. Volte ao app e tente de novo."; com sessão, `customer.name` e `customer.email` vêm da sessão (o que o navegador mandar é ignorado), `couponCode` e `withBump` são recusados, o toque do pedido vem da sessão ou, sem origem na sessão, do `app_trial` da conta; pedido criado grava `app_account` e `app_session_id`, e a sessão ganha `order_id` do pedido mais recente.
- Página: `/c/<slug>?s=<id>` mostra nome e e-mail travados (texto, não input), sem campo de cupom nem bump; oferta `app` sem `s` válido mostra a mensagem acima, sem formulário.
- Rota: `201 { url, expira_em }`.

- [ ] **Step 1: testes que falham** (`tests/apps-sessions.test.ts` e `tests/checkout.test.ts`): cria sessão e a URL não contém e-mail, nome nem conta; `checkout.start` com sessão grava `app_account` e usa nome/e-mail da sessão mesmo com outros no corpo; sem sessão numa oferta `app` → `invalid_input`; sessão vencida (61 min, relógio injetado) → `SESSION_INVALID`; sessão de outra oferta → `SESSION_INVALID`; sessão cujo pedido já está `paid` → `SESSION_INVALID`; Pix pendente e depois cartão na mesma sessão → permitido (dois pedidos, a sessão aponta para o último); cupom com sessão → `invalid_input`; toque vem do `app_trial` quando a sessão não trouxe origem; `retorno` com host estranho → `invalid_input`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar ação, rota, `checkout.start` e página. **Step 4:** PASS + `bun run check`.
- [ ] **Step 5:** commit `feat(apps): sessão de pagamento pela API e checkout ligado à conta`.

### Task 8: CPF ou CNPJ por loja

**Files:**
- Modify: `src/lib/validation/` (mover `validCnpj` de `src/lib/payments/manual.ts:108` para o módulo de validação brasileira, reexportando onde era usado), `src/lib/checkout.ts` (`requireCpf` → `requireTaxId(doc, { acceptCnpj })`), `src/lib/payments/asaas/*` (cliente com `cpfCnpj` do documento), `src/card-service/…` (titular aceita CNPJ só se o pedido for de loja com `accept_cnpj`), `src/app/c/[slug]/checkout-form.tsx` (rótulo "CPF ou CNPJ", máscara pelos dígitos), ação de configurações da loja (`store.updateSettings` ganha `acceptCnpj`) e aba Checkout em Configurações
- Test: `tests/br-validation.test.ts`, `tests/checkout.test.ts`, `tests/card-service.test.ts`

**Interfaces:**
- Produces: `requireTaxId(doc: string | undefined, opts: { acceptCnpj: boolean }): string` em `src/lib/checkout.ts`. Mensagens: sem documento → "Informe o CPF" (ou "Informe o CPF ou CNPJ"); inválido → "CPF inválido. Confira os 11 números." (só CPF) / "CPF ou CNPJ inválido. Confira os números." (com CNPJ).

- [ ] **Step 1: testes que falham:** CNPJ válido aceito no Pix do Asaas com `accept_cnpj` e recusado sem ele com a mensagem atual; CNPJ inválido com a mensagem nova; o cliente do Asaas (fake) recebe o CNPJ em `cpfCnpj`; no serviço `card`, titular CNPJ aceito só para pedido de loja com `accept_cnpj`; `store.updateSettings({ acceptCnpj: true })` só para quem já pode mudar configurações.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS + `bun run check`.
- [ ] **Step 5:** commit `feat(checkout): CPF ou CNPJ por loja`.

### Task 9: Aviso ao app (`notify_app`, webhook assinado)

**Files:**
- Create: `src/lib/apps/webhook.ts`
- Modify: `src/lib/orders/state.ts` (pedido com `app_account`: `paid` enfileira `notify_app` em vez de `deliver_order`; `refunded`/`disputed` enfileiram `notify_app` em vez de `revoke_downloads`; `disputed → paid` enfileira `notify_app` `pagamento.restabelecido` em vez de `restore_downloads`), `src/lib/payments/asaas/webhook.ts:246-249` (estorno parcial de pedido `app` enfileira `pagamento.reembolso_parcial` com `valor_estornado_centavos`), `src/lib/refund.ts` / ação de reembolso do painel (pedido `app` só reembolso total; parcial → `invalid_input`), `src/lib/jobs.ts` (`notify_app`), `src/lib/jobs/handlers.ts`, `src/lib/alerts.ts` (`AlertReason` `app_webhook_falhou`), detalhe do pedido no painel (estado do aviso e botão "Reenviar aviso ao app")
- Test: `tests/apps-webhook.test.ts` (novo), `tests/orders.test.ts`, `tests/asaas-webhook.test.ts`, `tests/refund.test.ts`

**Interfaces:**
- Produces: `signAppWebhook(secret: string, body: string, t: number): string` → `t=<t>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)>`.
- Produces: `appEventId(orderId: string, type: AppEventType, seq: number): string` = `evt_` + sha256(`${orderId}:${type}:${seq}`) (primeiros 32 hex); `seq` = quantas vezes aquele tipo já saiu para o pedido (o `pagamento.confirmado` de um pedido é sempre `seq` 0).
- Produces: job `notify_app` com payload `{ deliveryId }`; a linha `app_webhook_delivery` é criada no mesmo `enqueue` (mesma transação). Corpo: `{ id, tipo, criado_em, dados: { conta, pedido: publicId, app_code, valor_centavos, metodo, pago_em, valor_estornado_centavos? } }` (sem e-mail, nome, telefone, CPF/CNPJ). Cabeçalhos `Funil-Assinatura`, `Funil-Evento`, `Content-Type: application/json`, `User-Agent: funil-webhook/1`.
- Envio: `fetch` com `redirect: "manual"` (3xx = falha), timeout 10 s, destino resolvido e conferido com `isPublicAddress` (`src/lib/delivery/mailer.ts:120`) antes de conectar, exceto variável só de teste `APP_WEBHOOK_ALLOW_LOOPBACK=1` aceita só com `BASE_URL` em loopback (validar em `src/lib/env.ts`, como `RESEND_BASE_URL`). Backoff próprio do aviso: `[60, 300, 1800, 7200, 21600, 86400]` s; esgotado → `status = 'failed'` e `alertSeller(tx, storeId, "app_webhook_falhou", { orderId })`.
- Produces: ação `apps.resendNotice({ orderId })` (permissão `orders.resend`, exposta no painel, `MCP_EXCLUDED`): reenfileira o último aviso do pedido com o **mesmo** `id` de evento.

- [ ] **Step 1: testes que falham** (`tests/apps-webhook.test.ts` com servidor HTTP local e `APP_WEBHOOK_ALLOW_LOOPBACK`):
  - pedido `app` pago → um `notify_app`, nenhum `deliver_order`, e o app recebe `pagamento.confirmado` com assinatura que confere com o segredo e `t` atual; nenhum e-mail ao comprador.
  - corpo sem e-mail/nome/telefone/documento (procurar as strings do pedido no corpo).
  - 500 do app → nova tentativa agendada em 60 s; 2xx depois → `delivered`; 302 → falha; resposta depois de 10 s → falha.
  - destino que resolve para `10.0.0.1` sem a variável de teste → falha sem conectar.
  - seis falhas → `failed` + alerta `app_webhook_falhou`.
  - reembolso → `pagamento.reembolsado`; contestação → `pagamento.contestado`; contestação revertida → `pagamento.restabelecido`; estorno parcial vindo do Asaas → `pagamento.reembolso_parcial` com `valor_estornado_centavos`.
  - reenviar manda o mesmo `Funil-Evento` e o mesmo `id`.
  - pedido `download` continua com `deliver_order` (regressão).
  - painel: reembolso parcial de pedido `app` → `invalid_input`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS + `bun run check`.
- [ ] **Step 5:** commit `feat(apps): aviso ao app por webhook assinado com novas tentativas`.

### Task 10: Painel: cartão "App (integração)" em Conexões

**Files:**
- Create: `src/lib/apps/connection.ts`
- Modify: `src/app/admin/(panel)/connections/cards.tsx`, `connections/page.tsx`, `src/app/admin/(panel)/actions.ts`, `src/lib/connections.ts` (`connections.status` inclui o app), `src/lib/mcp/tools.ts`
- Test: `tests/apps-connection.test.ts` (novo), `tests/mcp-tools.test.ts`, `tests/mcp-matrix.test.ts`, `tests/panel-actions.test.ts`

**Interfaces:**
- Produces: `connections.saveAppWebhook({ url: string; returnHosts?: string[] })` (permissão `connections.write`, **sensível**): só `https`, host público (resolução + `isPublicAddress`), sem credencial na URL; na primeira gravação gera o segredo (`randomToken(32)`) e o devolve **uma vez** na saída `{ secret?: string }`.
- Produces: `connections.rotateAppWebhookSecret()` (sensível) → `{ secret }` uma vez.
- Produces: `connections.testAppWebhook()` (`connections.write`) → manda `ping` e devolve `{ httpStatus }` ou erro "O app não respondeu com 2xx (HTTP <código>)".
- Chaves: o cartão cria e revoga tokens com `role: "integration"` usando as ações existentes de token (`createMcpToken`, `revokeMcpToken`), listando só os `integration`; a tela de Tokens MCP deixa de listar `integration`.
- MCP: as três ações em `MCP_EXCLUDED`. Desvio consciente do §7.9 (que previa a fila de aprovação): `saveAppWebhook` e `rotateAppWebhookSecret` devolvem o segredo, que não pode passar pela fila nem chegar a um agente; `testAppWebhook` só faz sentido junto da configuração. As duas primeiras continuam `sensitive: true` no painel. Anotar como ruling no corpo do PR.

- [ ] **Step 1: testes que falham:** URL `http://`, `https://127.0.0.1`, `https://user:pw@x.com` → `invalid_input`; segredo aparece uma vez e depois só "configurado"; rotação invalida o anterior (assinatura velha não confere); `ping` chega ao servidor de teste assinado; papel `admin` não salva (`connections.write`); a matriz do MCP classifica as três ações.
- [ ] **Step 2:** FAIL. **Step 3:** implementar ações e cartão (padrão do `UseProvider`: mensagem que sobrevive ao refresh). **Step 4:** PASS + `bun run check`.
- [ ] **Step 5:** commit `feat(apps): conexão do app no painel (chave, webhook e segredo)`.

### Task 11: `Purchase` do pedido de app

**Files:**
- Modify: `src/lib/tracking/meta.ts:340-395`
- Test: `tests/meta.test.ts`

- [ ] **Step 1: testes que falham:** pedido `app` pago → `Purchase` com `user_data.external_id` = sha256(`app_account`), `custom_data.content_ids = [app_code]`, `fbc`/`fbp` do `app_trial` da conta quando o pedido não tem; pedido `download` igual a hoje (`external_id` do `customerId`, ids de produto).
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS + `bun run check`.
- [ ] **Step 5:** commit `feat(apps): Purchase do pedido de app com a conta e a origem do teste`.

## Parte 3 — Métricas e contrato (PR 2, continuação)

### Task 12: Métricas teste → pagante

**Files:**
- Modify: `src/lib/metrics.ts` (nova ação), Dashboard `src/app/admin/(panel)/page.tsx`, `src/lib/mcp/tools.ts`
- Test: `tests/metrics.test.ts`, `tests/mcp-tools.test.ts`

**Interfaces:**
- Produces: ação `metrics.trials({ period: Period } | { from, to })` (`metrics.read`, exposta no MCP sem dado pessoal) → `{ trials: number; paying: number; conversionBp: number | null; byCampaign: { campaign: string; trials: number; paying: number; conversionBp: number | null; revenueCents: number }[] }`. `trials` = `app_trial` com `started_at` no período; `paying` = desses, contas com pedido `app` `paid` (qualquer data); `conversionBp` = `floor(paying * 10000 / trials)` (nulo sem testes); campanha = `first_touch.utm_campaign` do teste ou `"(sem campanha)"`; `revenueCents` = soma dos pedidos `paid` das contas do grupo pagos no período.
- Dashboard: bloco "Testes do app" só quando a loja tem oferta `app` ativa.

- [ ] **Step 1: testes que falham:** 4 testes no período, 1 pagante → `conversionBp = 2500`; pagante de teste fora do período não conta; agrupamento por campanha com "(sem campanha)"; loja sem testes → `conversionBp: null`; a saída do MCP não tem `account` nem hashes.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS + `bun run check`.
- [ ] **Step 5:** commit `feat(apps): métricas de teste para pagante por campanha`.

### Task 13: Contrato de integração para o app

**Files:**
- Create: `docs/integracao-apps.md`
- Modify: `docs/instalacao.md` (link na seção de Conexões)

- [ ] **Step 1:** escrever o contrato (§7.10, oito partes), com: exemplos `curl` reais dos dois endpoints e das respostas de erro da Task 4; o corpo exato dos eventos da Task 9; verificação da assinatura em TypeScript com Web Crypto (`crypto.subtle.importKey` HMAC SHA-256, comparação em tempo constante, janela de 5 min); idempotência pelo `id`; o que o PeticionaAqui faz em cada evento (`creditar_recarga_peticao(tenant, quantidade, pedido)` com o `pedido` como chave; ativar plano anual sem recriar o teste; `pagamento.reembolsado` e `pagamento.contestado` tiram o que foi liberado; `pagamento.restabelecido` devolve); como guardar a origem no cadastro (UTMs da URL de entrada, cookies `_fbc` e `_fbp`); lista de conferência de produção. Nenhum segredo real; chaves de exemplo sem formato de segredo (usar `<CHAVE_DA_LOJA>`).
- [ ] **Step 2:** conferir cada exemplo contra o código das Tasks 4, 6, 7 e 9 (nomes de campos, códigos HTTP). `bun run check` → OK.
- [ ] **Step 3:** commit `docs(apps): contrato de integração para apps`.

> PR 2 = Tasks 3–13. **PR de verificação V2** (depois do merge do PR 2): E2E com um app falso em `e2e/fakes/` que recebe o webhook e confere a assinatura, cobrindo teste → sessão → Pix do Asaas falso pago → `pagamento.confirmado`, e sessão vencida.
>
> **Operação com o dono (fora de PR):** migração da produção (roteiro da Task 2), criação da loja PeticionaAqui, ofertas `start_anual`, `plus_anual`, `firma_anual` e pacotes de créditos com os preços aprovados pelo Gabriel, `accept_cnpj` ligado, chave e webhook configurados.
