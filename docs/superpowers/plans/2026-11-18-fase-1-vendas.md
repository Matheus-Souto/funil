# Fase 1: vender (MVP) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O dono vende o PDF "Maná bíblico para crianças" (R$ 9,90 e R$ 27 com order bump) pela própria plataforma,
com Pix manual, Pix Asaas e cartão Asaas no próprio checkout, entrega automática por e-mail, Meta Pixel + CAPI e painel,
sobre uma base multi-loja com camada de ações e permissões.

**Architecture:** Um único app Next.js serve self-hosted (`MODE=single`) e nuvem (`MODE=multi`). Toda regra de negócio
é uma *ação* (`defineAction`) executada por `runAction`, que abre uma transação com `app.store_id` definido (Row Level
Security no Postgres), valida entrada com Zod, checa permissão e grava auditoria. Painel, rotas públicas, webhooks e
(na fase 2) MCP chamam só ações. Efeitos colaterais (e-mail, Meta, avisos) passam por uma fila em tabela do Postgres.

**Tech Stack:** Bun 1.3+, Next.js 16 (App Router), React 19, TypeScript estrito, PostgreSQL 17, Drizzle ORM +
`postgres` (postgres.js), Zod 4, nodemailer, pdf-lib, Docker Compose + Caddy.

**Spec:** `docs/superpowers/specs/2026-11-18-plataforma-funil-mvp-design.md` (ler inteiro antes da Task 1).

## Global Constraints

- Raiz do repositório: este diretório. Nome do pacote: `funil` (nome do produto ainda a definir).
- Dinheiro sempre em **centavos inteiros** (`*_cents`), nunca float. Conversão para reais só na borda (Asaas, UI).
- **Toda tabela de negócio tem `store_id uuid not null`** e política RLS `store_id = current_setting('app.store_id')::uuid`.
  O app conecta com o papel `app` (sem `BYPASSRLS`, não dono das tabelas). Só migrations e o CLI de criação de loja usam
  o papel dono.
- Nenhuma regra de negócio fora de uma ação. Rotas e páginas só fazem parse de HTTP e chamam `runAction`.
- **Dados de cartão nunca em banco, log, fila, cache ou mensagem de erro.** Só em memória durante a requisição.
- Segredos de conexões guardados com `seal()` (AES-256-GCM); nunca devolvidos ao painel depois de salvos.
- Pagamentos da loja vão para a chave Pix / conta Asaas **da loja**; a plataforma nunca intermedia.
- Asaas: sandbox `https://api-sandbox.asaas.com/v3`, produção `https://api.asaas.com/v3`, header `access_token`;
  cliente exige `cpfCnpj`; cartão exige `creditCardHolderInfo` com `name, email, cpfCnpj, postalCode, addressNumber,
  phone, mobilePhone` e `remoteIp` do comprador; timeout de **60 s** na criação de cobrança com cartão.
- Webhook do Asaas nunca é confiado: sempre reconsultar `GET /payments/{id}` antes de mudar estado.
- Pix manual: validade padrão **24 h**; valor único = total + offset de **1 a 99 centavos**.
- Link de download: validade padrão **30 dias**, **5 downloads**; reembolso ou estorno revoga.
- Ações sensíveis chamadas com origem `mcp` ou `ai` lançam `approval_required` (fila de aprovação é fase 2).
- Atribuição: arquivos copiados/adaptados do LibreFunnel mantêm no topo o aviso MIT
  `Copyright (c) 2026 Genesis Innovation` + texto da licença.
- Textos da interface em português do Brasil.
- `bun run check` (tsc + eslint + higiene de testes + testes) passa ao fim de cada task.
- **Verificação (Task 0):** toda task termina com `bash scripts/verify.sh` verde (carimbo em `.verify/<sha>.json`)
  antes do commit final da task. As Tasks 6 a 14 têm um passo extra: **estender o smoke E2E** em `e2e/smoke.spec.ts`
  com o fluxo que a task entrega, do jeito que um comprador ou o dono usaria.
- **Testes instáveis:** proibido `.skip`, `.only`, `.todo`, `retry`/`retries` > 0, `waitForTimeout`, `setTimeout`,
  `Bun.sleep` ou `sleep(` em testes (o `check-test-hygiene` barra). Teste instável = achar a causa; sem causa, apagar e
  documentar em `docs/testes-removidos.md`.
- **3 rodadas:** depois de 3 execuções seguidas do verify falhando, o verify trava. Parar e chamar o dono
  (`bun run verify:reset` só por ele).
- **Testes de propriedade (fast-check):** Task 2 `seal/open` ida e volta e `redact` nunca deixa passar PAN gerado;
  Task 7 `transitionOrder` idempotente; Task 8 BR Code com CRC sempre válido e valores únicos nunca repetidos entre
  pendentes; Task 9 webhook repetido N vezes = 1 vez.
- `ASAAS_BASE_URL` sobrescrevível por env **só fora de produção** (o env recusa em `NODE_ENV=production`), para o smoke
  usar o Asaas falso de `e2e/fakes/asaas-server.ts`.

## Review Focus

1. **Webhook do Asaas duplicado ou chegando antes da resposta do checkout** → o pedido vira `paid` uma vez e a entrega
   é enfileirada uma vez (teste na Task 9).
2. **Duplo clique em "Pagar" no cartão** (mesma `idempotencyKey`, requisições simultâneas) → uma única cobrança no
   Asaas (teste na Task 10).
3. **Dois pedidos Pix manual simultâneos com o mesmo preço** → valores únicos diferentes, sem erro para o comprador
   (teste na Task 8).
4. **Acesso cruzado entre lojas**: webhook da loja A com token da loja B, `publicId` de outra loja na URL, usuário de uma
   loja agindo em outra → recusado / 404 (testes nas Tasks 3, 9 e 11).
5. **Recusa do cartão cujo erro do Asaas ecoa dados enviados** → resposta ao comprador e logs sem número/CVV (teste na
   Task 10). Também: SMTP fora do ar → pedido continua `paid`, entrega re-tentada e visível no painel (teste na Task 12).

---

### Task 0: Infraestrutura de verificação (feita junto com a Task 1, antes de qualquer outra)

Base: artigo "How the Claude Code team thinks about verification" (claude.dev). A Task 0 e a Task 1 são executadas
juntas porque o verify precisa de um app para subir; ao fim delas o verify sobe o app e testa `/api/health` de ponta a
ponta, e cada task seguinte estende o smoke.

**Files:**
- Create: `.claude/skills/verify/SKILL.md`, `scripts/verify.sh`, `scripts/verify-gate.sh`,
  `scripts/check-test-hygiene.ts`, `.claude/settings.json`, `CLAUDE.md`, `REVIEW.md`, `.github/CODEOWNERS`,
  `.github/workflows/verify.yml`, `e2e/smoke.spec.ts`, `playwright.config.ts`, `docs/testes-removidos.md`,
  `.verify/.gitkeep` (`.verify/*` exceto `.gitkeep` e `gate-mode` no `.gitignore`), `.verify/gate-mode` (conteúdo
  `enforce`)
- Test: `tests/verify/hygiene.test.ts`, `tests/verify/gate.test.sh`

**Interfaces / comportamento:**
- `scripts/verify.sh [--deploy]` — etapas, parando na primeira falha: (1) trava de 3 rodadas: se
  `.verify/state.json` tem `failures >= 3` para o branch atual, imprime `PARE: 3 rodadas de correção falharam. Chame o
  dono do projeto.` e sai com código 3 sem rodar nada; (2) `bun install --frozen-lockfile`; (3)
  `docker compose -f compose.dev.yaml up -d --wait` (Postgres + Mailpit); (4) `bun run check`; (5) `bun run build`;
  (6) sobe `bun run start` numa porta livre com banco novo `verify_<sha curto>` migrado, Mailpit e Asaas falso;
  (7) `bunx playwright test e2e/` com viewport 375×812; (8) com `--deploy` (ou se o diff contra `main` toca
  `deploy/`, `compose.yaml` ou `Dockerfile`) roda `tests/smoke.sh`; (9) derruba app e banco; (10) grava
  `.verify/<sha do HEAD>.json` = `{ sha, branch, dirty: boolean, startedAt, durationSec, steps: [{ name, ok,
  durationSec }], ok }` e atualiza `.verify/state.json` (`failures` += 1 em falha, zera em sucesso). Evidências
  (logs, screenshots, traces do Playwright) em `.verify/runs/<sha>/`. Meta: < 3 min; a duração fica registrada.
- `package.json`: `"verify": "bash scripts/verify.sh"`, `"verify:reset": "rm -f .verify/state.json"`.
- `scripts/verify-gate.sh` — lê o modo de `.verify/gate-mode` (`off|observe|enforce`); passa se existe
  `.verify/<HEAD>.json` com `ok: true` e `dirty: false` **e** `git status --porcelain` está vazio; senão, em
  `enforce` sai com código 2 e mensagem `Bloqueado: rode /verify no commit <sha> antes de abrir PR ou dar push.`; em
  `observe` só registra em `.verify/gate.log` e passa.
- `.claude/settings.json` — hook `PreToolUse` com matcher `Bash` que, quando o comando contém `gh pr create` ou
  `git push`, executa **a versão do branch padrão**: `git show main:scripts/verify-gate.sh | bash` (se `main` ainda não
  existe, usa o arquivo local). Assim um branch que edite o gate não muda o gate que o julga.
- `scripts/check-test-hygiene.ts` — varre `tests/**` e `e2e/**` e falha (listando arquivo:linha) em: `.skip(`,
  `.only(`, `.todo(`, `retry`, `retries:` com valor > 0, `waitForTimeout`, `setTimeout(`, `Bun.sleep`, `sleep(`.
  Entra no `bun run check`. Exceção única: `playwright.config.ts` precisa ter `retries: 0` explícito.
- `.github/workflows/verify.yml` — em `pull_request` e `push` para `main`: checkout do PR, depois
  `git fetch origin main` e roda `git show origin/main:scripts/verify.sh > "$RUNNER_TEMP/verify.sh"` e
  `bash "$RUNNER_TEMP/verify.sh"` (no primeiro push, quando ainda não existe `main` remoto, usa o arquivo local). Sobe
  `.verify/runs/` como artefato.
- `.github/CODEOWNERS` — `@Matheus-Souto` dono de `/.claude/`, `/REVIEW.md`, `/CLAUDE.md`, `/scripts/verify*`,
  `/scripts/check-test-hygiene.ts`, `/e2e/`, `/playwright.config.ts`, `/.github/`, `/.verify/gate-mode`.
- `CLAUDE.md` — regras curtas: rodar `/verify` antes de commit final e antes de PR; nunca pular, re-tentar ou pôr espera
  em teste instável (achar causa ou apagar e documentar); após 3 rodadas de correção falhando, parar e perguntar ao
  dono; não editar `.claude/`, `REVIEW.md`, `scripts/verify*`, `e2e/` ou `.github/` em PR que também muda código de
  produto (PR separado para mudar verificações); regras do produto (centavos, ações, RLS, cartão).
- `REVIEW.md` — regras de revisão + checklist de confiabilidade, cada item com **gatilho legível no diff**, a
  **verificação** e a **origem**. Itens iniciais: (1) diff toca `payments/` → idempotência de cobrança e webhook;
  (2) cria tabela → `store_id` + `enable_store_rls`; (3) toca `card.ts` ou rota de cartão → nenhum dado de cartão
  persistido/logado; (4) rota ou página nova → chama só `runAction`; (5) toca `orders/state.ts` → efeitos só em
  `changed: true`; (6) toca `delivery/` → link revogado em reembolso; (7) toca `tracking/meta.ts` → `event_id` igual no
  navegador e no servidor; (8) mexe em valores → centavos inteiros. Seção "Como acrescentar regras": falha que passou
  na revisão vira item novo; podar itens que não disparam há muito tempo.
- `e2e/smoke.spec.ts` (nesta task) — abre `/api/health` e a página inicial no app de produção; as Tasks 6–14 acrescentam
  o fluxo de compra.

- [ ] **Step 1: Testes que falham** — `tests/verify/hygiene.test.ts`: o checker acusa um arquivo temporário com
  `test.skip(`, outro com `retries: 2`, outro com `await Bun.sleep(10)`, e aceita um arquivo limpo.
  `tests/verify/gate.test.sh`: em um repositório temporário, sem carimbo → código 2; carimbo `ok: true` do HEAD e árvore
  limpa → 0; carimbo de outro sha → 2; árvore suja → 2; modo `observe` sem carimbo → 0 e linha em `gate.log`;
  `state.json` com `failures: 3` → `verify.sh` sai com 3 sem rodar etapas.
- [ ] **Step 2:** Rodar → FAIL.
- [ ] **Step 3:** Implementar os arquivos acima.
- [ ] **Step 4:** Testes passam. Rodar `bash scripts/verify.sh` de verdade e anotar a duração.
- [ ] **Step 5: Teste de estresse do verify** (o artigo pede verify confiável) — rodar o verify 3 vezes seguidas sem
  mudanças: as 3 passam e o tempo varia pouco. Introduzir de propósito um erro de tipo, um teste com `.skip` e uma
  rota que devolve 500: o verify falha nos 3 casos na etapa certa. Desfazer.
- [ ] **Step 6:** Commit `chore: verificação automática (verify, gate de PR, higiene de testes)`.
- [ ] **Step 7 (com confirmação já dada pelo dono):** criar o repositório no GitHub na conta `Matheus-Souto`, fazer push
  do `main` e ligar a proteção do `main`: CI `verify` obrigatório, revisão de code owner obrigatória, sem push direto,
  sem force-push.

---

### Task 1: Esqueleto do projeto

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `eslint.config.js`, `bunfig.toml`, `.gitignore`,
  `.env.example`, `compose.dev.yaml`, `drizzle.config.ts`, `src/app/layout.tsx`, `src/app/api/health/route.ts`,
  `tests/setup.ts`, `tests/health.test.ts`

**Interfaces:**
- Produces: scripts `bun run dev`, `bun run check`, `bun run migration` (drizzle-kit generate), `bun run migrate`;
  `compose.dev.yaml` com Postgres 17 em `localhost:5433` (usuário `owner`, banco `funil`) e Mailpit (SMTP `localhost:1025`, API/UI `localhost:8025`); `tests/setup.ts` pré-carregado
  pelo `bunfig.toml` que faz mock do módulo `server-only`.

- [ ] **Step 1:** `git init`; criar `package.json` com `next@16`, `react@19`, `react-dom@19`, `drizzle-orm`, `postgres`,
  `zod@4`, `nodemailer`, `pdf-lib`; dev: `drizzle-kit`, `typescript`, `eslint`, `eslint-config-next`, `@types/*`, `@playwright/test`, `fast-check`, `happy-dom`.
  `tsconfig` com `strict: true` e alias `@/*` → `src/*`. `next.config.ts` com `output: "standalone"`.
- [ ] **Step 2: Teste que falha** — `tests/health.test.ts`:

```ts
import { GET } from "@/app/api/health/route";
test("health responde ok", async () => {
  const res = await GET();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
```

- [ ] **Step 3:** `bun test tests/health.test.ts` → FAIL (módulo não existe).
- [ ] **Step 4:** Implementar `GET(): Response` em `src/app/api/health/route.ts`.
- [ ] **Step 5:** `docker compose -f compose.dev.yaml up -d` e `bun run check` → tudo verde.
- [ ] **Step 6:** Commit `chore: esqueleto do projeto`.

---

### Task 2: Configuração, criptografia e log com redação

**Files:**
- Create: `src/lib/env.ts`, `src/lib/crypto.ts`, `src/lib/log.ts`
- Test: `tests/crypto.test.ts`, `tests/log.test.ts`

**Interfaces:**
- Produces:
  - `env: { MODE: "single"|"multi"; BASE_URL: string; PLATFORM_DOMAIN?: string; DATABASE_URL: string;
    OWNER_DATABASE_URL: string; SECRET: string; DATA_DIR: string; TURNSTILE_SITE_KEY?: string;
    TURNSTILE_SECRET?: string }` — validado com Zod; `SECRET` mínimo 32 caracteres; erro lista as variáveis faltando.
  - `seal(plain: string): string`, `open(sealed: string): string` — AES-256-GCM, chave derivada de `SECRET` com HKDF
    (info `"funil:seal:v1"`), formato `v1.<iv>.<tag>.<ciphertext>` em base64url.
  - `randomToken(bytes = 32): string` (base64url), `sha256(s: string): string` (hex),
    `timingSafeEqualStr(a: string, b: string): boolean`.
  - `log.info|warn|error(msg: string, data?: unknown): void` — JSON em stdout, sempre via `redact(data)`.
  - `redact(v: unknown): unknown` — remove recursivamente chaves que casam com
    `/^(number|ccv|cvv|cardNumber|creditCard|expiryMonth|expiryYear|card)$/i` (valor vira `"[redacted]"`) e substitui
    qualquer sequência de 13 a 19 dígitos (com ou sem espaços/hífens) em strings por `"[redacted]"`.

- [ ] **Step 1: Testes que falham**

```ts
test("seal/open ida e volta", () => {
  const s = seal("chave-asaas");
  expect(s.startsWith("v1.")).toBe(true);
  expect(s).not.toContain("chave-asaas");
  expect(open(s)).toBe("chave-asaas");
});
test("open recusa texto adulterado", () => {
  const s = seal("x"); expect(() => open(s.slice(0, -2) + "AA")).toThrow();
});
test("redact remove campos de cartão e PAN em texto", () => {
  const out = redact({ creditCard: { number: "4444444444444444", ccv: "123" },
    msg: "cartão 4444 4444 4444 4444 recusado", name: "Ana" }) as any;
  expect(JSON.stringify(out)).not.toMatch(/4444|123/);
  expect(out.name).toBe("Ana");
});
```

- [ ] **Step 2:** `bun test tests/crypto.test.ts tests/log.test.ts` → FAIL.
- [ ] **Step 3:** Implementar os módulos com as assinaturas acima (`node:crypto`).
- [ ] **Step 4:** Testes passam; `bun run check` verde.
- [ ] **Step 5:** Commit `feat: env, criptografia e log com redação`.

---

### Task 3: Banco, multi-loja e RLS

**Files:**
- Create: `src/lib/db/schema/core.ts` (store, user, membership, session, audit_log), `src/lib/db/schema/index.ts`,
  `src/lib/db/client.ts`, `src/lib/db/rls.sql`, `src/lib/db/migrate.ts`, `drizzle/` (migrations geradas),
  `tests/db.ts` (helper), `tests/rls.test.ts`

**Interfaces:**
- Produces:
  - Tabelas: `store(id uuid pk, slug text unique, name, domain text unique null, notify_email text null,
    created_at)`; `user(id, email unique, name, password_hash, created_at)`;
    `membership(user_id, store_id, role text check in ('owner','admin','support','traffic'), unique(user_id,store_id))`;
    `session(id_hash text pk, user_id, store_id, expires_at, created_at)`;
    `audit_log(id, store_id, actor jsonb, origin text, action text, input jsonb, ok boolean, error text null, at)`.
    `store`, `user`, `membership`, `session` **sem** RLS; `audit_log` e todas as tabelas de negócio futuras **com** RLS.
  - `rls.sql`: cria o papel `app` (idempotente, `DO $$ ... IF NOT EXISTS`), concede DML, e uma função
    `enable_store_rls(table regclass)` que liga RLS + `FORCE` + política `store_isolation` usando
    `current_setting('app.store_id', true)::uuid`. Toda migration que cria tabela de negócio chama essa função.
  - `db` (conexão papel `app`), `ownerDb` (papel dono).
  - `type Tx` (transação Drizzle). `withStore<T>(storeId: string, fn: (tx: Tx) => Promise<T>): Promise<T>` — abre
    transação e executa `select set_config('app.store_id', $1, true)`.
  - `tests/db.ts`: `createTestDb(): Promise<{ db, ownerDb, url, drop(): Promise<void> }>` cria banco `test_<random>`
    no Postgres do compose, roda migrations, e reconfigura os clientes de `src/lib/db/client.ts` para ele
    (`setDbForTests`). `seedStore(name?: string): Promise<{ storeId: string }>`.

- [ ] **Step 1: Teste que falha** — `tests/rls.test.ts`:

```ts
test("loja A não lê auditoria da loja B", async () => {
  const a = await seedStore("A"), b = await seedStore("B");
  await withStore(b.storeId, tx => tx.insert(auditLog).values({ storeId: b.storeId,
    actor: { kind: "system" }, origin: "system", action: "x", input: {}, ok: true }));
  const rows = await withStore(a.storeId, tx => tx.select().from(auditLog));
  expect(rows).toHaveLength(0);
});
test("insert com store_id de outra loja é recusado", async () => {
  const a = await seedStore("A"), b = await seedStore("B");
  await expect(withStore(a.storeId, tx => tx.insert(auditLog).values({ storeId: b.storeId,
    actor: { kind: "system" }, origin: "system", action: "x", input: {}, ok: true }))).rejects.toThrow();
});
test("sem app.store_id nada é visível", async () => {
  expect(await db.select().from(auditLog)).toHaveLength(0);
});
```

- [ ] **Step 2:** Rodar → FAIL.
- [ ] **Step 3:** Implementar schema, `rls.sql` aplicado pelo `migrate.ts` após as migrations do drizzle-kit, cliente e
  `withStore`.
- [ ] **Step 4:** Testes passam.
- [ ] **Step 5:** Commit `feat: banco multi-loja com RLS`.

---

### Task 4: Camada de ações e permissões

**Files:**
- Create: `src/lib/actions/core.ts`, `src/lib/actions/permissions.ts`, `src/lib/actions/registry.ts`
- Test: `tests/actions.test.ts`

**Interfaces:**
- Consumes: `withStore`, `Tx`, `auditLog`, `log`.
- Produces:
  - `type Permission = "products.read"|"products.write"|"offers.read"|"offers.write"|"orders.read"|"orders.release"|
    "orders.refund"|"orders.resend"|"orders.export"|"metrics.read"|"connections.read"|"connections.write"|
    "team.manage"`.
  - `ROLE_PERMISSIONS: Record<Role, Permission[]>` — `owner`: todas; `admin`: todas menos `team.manage` e
    `connections.write`; `support`: `orders.read`, `orders.resend`, `products.read`, `offers.read`; `traffic`:
    `metrics.read`, `offers.read`, `products.read`, `connections.read`.
  - `type Actor = { kind: "user"; userId: string; role: Role } | { kind: "public" } | { kind: "system" }`.
  - `type Origin = "panel"|"api"|"mcp"|"ai"|"public"|"system"|"webhook"`.
  - `type Ctx = { storeId: string; actor: Actor; origin: Origin; tx: Tx }`.
  - `defineAction<I, O>(def: { name: string; description: string; input: z.ZodType<I>;
    permission: Permission | "public" | "system"; sensitive?: boolean; audit?: boolean;
    run(ctx: Ctx, input: I): Promise<O> }): Action<I, O>` — registra em `registry` (nome único).
  - `runAction<I, O>(action: Action<I, O>, call: { storeId: string; actor: Actor; origin: Origin },
    raw: unknown): Promise<O>`.
  - `class ActionError extends Error { code: "invalid_input"|"forbidden"|"not_found"|"conflict"|
    "approval_required"|"provider_error"|"rate_limited"; details?: unknown }`.
  - Regras de `runAction`: valida com Zod (`invalid_input` com `issues`); `"public"` aceita qualquer ator;
    `"system"` só `actor.kind === "system"`; permissão exige `actor.kind === "user"` e papel com a permissão;
    `sensitive && (origin === "mcp" || origin === "ai")` → `approval_required`; executa dentro de `withStore`;
    grava `audit_log` (entrada passada por `redact`) quando `audit !== false`, também em falha (em transação
    separada); erros desconhecidos viram log + rethrow.
  - `listActions(): Array<{ name; description; permission; sensitive; inputSchema: JSONSchema }>` (para MCP na fase 2,
    via `z.toJSONSchema`).

- [ ] **Step 1: Testes que falham** — cobrir: entrada inválida → `invalid_input`; papel `support` chamando ação
  `orders.refund` → `forbidden`; ação `sensitive` com origem `mcp` → `approval_required` e `run` não chamado; mesma ação
  com origem `panel` e papel `owner` executa; sucesso grava 1 linha em `audit_log` com `ok = true`; falha grava
  `ok = false`; entrada com `creditCard.number` aparece `"[redacted]"` na auditoria; `ctx.tx` só enxerga a loja do
  `call.storeId`.
- [ ] **Step 2:** Rodar → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Passa; `bun run check`.
- [ ] **Step 5:** Commit `feat: camada de ações com permissões e auditoria`.

---

### Task 5: Login no painel, setup inicial e resolução de loja

**Files:**
- Create: `src/lib/auth/password.ts`, `src/lib/auth/session.ts`, `src/lib/stores.ts`, `scripts/store-create.ts`,
  `src/app/admin/login/page.tsx`, `src/app/admin/setup/page.tsx`, `src/app/admin/layout.tsx`, `src/app/admin/actions.ts`
- Test: `tests/auth.test.ts`, `tests/stores.test.ts`

**Interfaces:**
- Produces:
  - `hashPassword(p: string): Promise<string>` / `verifyPassword(p, hash): Promise<boolean>` — `Bun.password`
    (argon2id). Senha mínima 10 caracteres.
  - `createSession(userId, storeId): Promise<string /*token*/>` — guarda `sha256(token)`, validade 30 dias; cookie
    `__Host-funil_session` (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`).
  - `getPanelActor(): Promise<{ storeId: string; actor: Extract<Actor, {kind:"user"}> } | null>` — lê cookie, valida
    sessão e membership; usado por toda página/ação do painel.
  - `destroySession()`.
  - `resolveStore(host: string): Promise<{ id: string; slug: string; name: string } | null>` — `single`: a única loja;
    `multi`: `store.domain = host` ou `host = <slug>.${PLATFORM_DOMAIN}`. Host normalizado (minúsculas, sem porta).
  - `setupFirstRun({ storeName, email, password, name })` — só funciona com `MODE=single` e zero usuários; cria loja +
    dono. Página `/admin/setup` redireciona para `/admin/login` se já houver usuário.
  - CLI `bun run store:create --name <n> --slug <s> --owner-email <e> [--domain <d>]` (`MODE=multi`): cria loja e dono
    (ou vincula usuário existente), imprime senha temporária uma vez.
  - Login com 5 falhas por e-mail em 15 min → bloqueio de 15 min.

- [ ] **Step 1: Testes que falham** — senha certa/errada; sessão expirada → `null`; usuário sem membership na loja da
  sessão → `null` (Review Focus 4); `setupFirstRun` segunda vez → `conflict`; `resolveStore` em `multi` por domínio e por
  subdomínio, host desconhecido → `null`; 6ª tentativa de login errada → bloqueado.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar (páginas com formulário simples + server actions que só chamam essas
  funções). **Step 4:** Passa. **Step 5:** Commit `feat: login, setup e resolução de loja`.

---

### Task 6: Catálogo — arquivos, produtos e ofertas com order bump

**Files:**
- Create: `src/lib/storage.ts`, `src/lib/db/schema/catalog.ts`, `src/lib/catalog/products.ts`,
  `src/lib/catalog/offers.ts`
- Test: `tests/catalog.test.ts`

**Interfaces:**
- Consumes: `defineAction`, `runAction`, `enable_store_rls`.
- Produces:
  - `storage: { put(key: string, data: Uint8Array): Promise<void>; get(key: string): Promise<Uint8Array | null>;
    delete(key: string): Promise<void> }` — disco em `${DATA_DIR}/files`, chave sanitizada (sem `..`).
  - Tabelas (com RLS): `product(id, store_id, name, file_key, file_name, file_size, created_at, deleted_at null)`;
    `offer(id, store_id, slug, name, product_id, price_cents int > 0, methods text[] ⊆ {'pix','card'},
    pix_mode text in ('manual','asaas'), max_installments int 1..12 default 1, bump_product_id null,
    bump_price_cents null, bump_label null, thank_you_text null, pixel_id null, active bool default true,
    unique(store_id, slug))`.
  - Ações: `products.create({ name, fileName, fileBase64 })` (PDF ≤ 50 MB, começa com `%PDF-`), `products.update`,
    `products.list`, `products.delete` (sensitive, soft delete); `offers.create`, `offers.update`, `offers.list`,
    `offers.get({ id })`; `offers.getPublic({ slug })` (permission `"public"`, só ofertas ativas, devolve preço, nome,
    bump, métodos e `pixMode`; nunca o `file_key`). Bump: ambos `bump_product_id` e `bump_price_cents` presentes ou
    ambos nulos; bump ≠ produto principal. Alterar `price_cents` é `sensitive`.

- [ ] **Step 1: Testes que falham** — upload com bytes que não são PDF → `invalid_input`; criar oferta com o caso do
  dono (`price_cents: 990`, bump do produto completo com `bump_price_cents: 1710`) e ler por `getPublic`; slug repetido
  na mesma loja → `conflict`, em loja diferente ok; `getPublic` de oferta inativa → `not_found`; resposta pública não
  contém `fileKey`; `traffic` não cria oferta.
- [ ] **Step 2–4:** FAIL → implementar → passa.
- [ ] **Step 5:** Commit `feat: catálogo com produtos, ofertas e order bump`.

---

### Task 7: Pedidos, máquina de estados, conexões e fila de tarefas

**Files:**
- Create: `src/lib/db/schema/orders.ts`, `src/lib/db/schema/integrations.ts`, `src/lib/db/schema/jobs.ts`,
  `src/lib/orders/state.ts`, `src/lib/orders/create.ts`, `src/lib/integrations.ts`, `src/lib/jobs.ts`,
  `src/instrumentation.ts`
- Test: `tests/orders.test.ts`, `tests/jobs.test.ts`

**Interfaces:**
- Produces:
  - Tabelas (RLS): `customer(id, store_id, email, name, phone, cpf null, asaas_customer_id null,
    unique(store_id, email))`; `order(id, store_id, public_id text unique (randomToken 16), offer_id, customer_id,
    status in ('pending','paid','refunded','disputed','expired','declined'),
    method in ('pix_manual','pix_asaas','card_asaas'), subtotal_cents, total_cents, manual_amount_cents null,
    has_bump bool, expires_at null, paid_at null, first_touch jsonb, last_touch jsonb, ref text null, fbc null, fbp null,
    client_ip, user_agent, created_at)`; `order_item(id, store_id, order_id, product_id, price_cents,
    kind in ('main','bump'))`; `payment(id, store_id, order_id, provider in ('asaas','manual'), provider_id null,
    status text, amount_cents, raw jsonb, unique(provider, provider_id))`; `integration(store_id, kind text in
    ('pix_manual','asaas','smtp','meta'), config jsonb /*público*/, secret text null /*seal()*/, updated_at,
    pk(store_id, kind))`; `job(id, store_id null, type, payload jsonb, run_at, attempts int, status in
    ('queued','running','done','failed'), last_error null)`; `checkout_view(id, store_id, offer_id, touch jsonb, at)`.
  - `createOrder(ctx: Ctx, input: { offerId; withBump: boolean; method: Method; customer: { name; email; phone;
    cpf?: string }; touch: Touch; ref?: string; fbc?: string; fbp?: string; clientIp: string; userAgent: string }):
    Promise<Order>` — recalcula preços do banco (nunca do cliente), cria itens `main` e `bump`, upsert de customer por
    e-mail. `type Touch = { first: Record<string,string> | null; last: Record<string,string> | null }`.
  - `transitionOrder(ctx: Ctx, orderId: string, to: OrderStatus, reason: string): Promise<{ changed: boolean }>` —
    transições válidas: `pending→paid|expired|declined`, `paid→refunded|disputed`, `disputed→paid|refunded`;
    feita com `UPDATE ... WHERE status = <from>` (sem corrida); transição igual ao estado atual → `{ changed: false }`
    sem efeitos; ao entrar em `paid`: grava `paid_at` e enfileira `deliver_order`, `meta_event` (payload `{ event: "Purchase", orderId }`), `notify_seller`;
    ao entrar em `refunded|disputed`: enfileira `revoke_downloads`.
  - `getIntegration<K>(tx, storeId, kind): Promise<{ config; secret: string | null } | null>` (abre `secret` com
    `open`), `saveIntegration(tx, storeId, kind, config, secret?)`.
  - `enqueue(tx: Tx, job: { storeId: string | null; type: JobType; payload: unknown; runAt?: Date })`;
    `runDueJobs(handlers: Record<JobType, (job) => Promise<void>>, limit = 10): Promise<number>` — `FOR UPDATE SKIP
    LOCKED`; falha reagenda em 60 s, 300 s, 1800 s, 7200 s, 43200 s e depois `failed`.
    `type JobType = "deliver_order"|"meta_event"|"notify_seller"|"revoke_downloads"|"expire_orders"`.
  - `instrumentation.ts` inicia o worker (intervalo 2 s) e agenda `expire_orders` a cada 5 min (marca `expired` os
    `pending` com `expires_at < now()`).

- [ ] **Step 1: Testes que falham** — preço do pedido vem do banco mesmo se o cliente mandar outro; bump soma
  `990 + 1710 = 2700` e cria 2 itens; `transitionOrder` duas vezes para `paid` em paralelo (`Promise.all`) → exatamente
  um `changed: true` e um único job `deliver_order` (Review Focus 1); transição inválida `expired→paid` → `conflict`;
  `refunded` enfileira `revoke_downloads`; job que falha 5 vezes vira `failed`; segredo salvo não aparece em texto puro
  no banco.
- [ ] **Step 2–4:** FAIL → implementar → passa.
- [ ] **Step 5:** Commit `feat: pedidos, máquina de estados, conexões e fila`.

---

### Task 8: Pix manual (chave própria, liberação no painel)

**Files:**
- Create: `src/lib/payments/brcode.ts` (pode adaptar `src/lib/orders/pix.ts` do LibreFunnel com aviso MIT),
  `src/lib/payments/manual.ts`
- Test: `tests/brcode.test.ts`, `tests/manual-pix.test.ts`

**Interfaces:**
- Consumes: `createOrder`, `transitionOrder`, `getIntegration`, `defineAction`.
- Produces:
  - `buildPixBrCode({ key: string; name: string; city: string; amountCents: number; txid: string }): string` — EMV
    estático (`00` payload format `01`, `26` com GUI `br.gov.bcb.pix` e chave, `52 0000`, `53 986`, `54` valor com 2
    casas, `58 BR`, `59` nome ≤ 25 sem acento, `60` cidade ≤ 15 sem acento, `62/05` txid ≤ 25 alfanumérico, `63` CRC16
    CCITT-FALSE em hex maiúsculo).
  - Conexão `pix_manual` config: `{ key, name, city }` (sem segredo). Ação `connections.savePixManual`
    (`connections.write`).
  - `allocateManualAmount(ctx, totalCents): Promise<{ amountCents: number; expiresAt: Date }>` — expira vencidos
    primeiro; escolhe o menor offset 1..99 livre entre pedidos `pix_manual` `pending` da loja com o mesmo
    `total_cents`; validade 24 h, ou 2 h se já houver ≥ 50 pendentes nesse total; nenhum livre → `ActionError
    ("conflict", "pix_manual_exhausted")`. Índice único parcial `(store_id, manual_amount_cents) WHERE method =
    'pix_manual' AND status = 'pending'`; em violação, tenta o próximo offset (até 3 vezes).
  - Ação `orders.release({ orderId })` — `orders.release`, `sensitive: true`, só `pix_manual` `pending`; chama
    `transitionOrder(..., "paid", "liberado manualmente")` e registra `payment` (`provider: "manual"`).

- [ ] **Step 1: Testes que falham** — BR Code de entrada fixa (`key "teste@exemplo.com"`, nome `"Fulano"`, cidade
  `"SAO PAULO"`, `amountCents 993`, txid `"PED123"`) bate com o valor esperado e o CRC confere (validar o vetor com um
  app de banco ou com a função do LibreFunnel antes de fixá-lo); acentos removidos; 10 pedidos simultâneos de 990 →
  10 valores diferentes entre 991 e 1089 (Review Focus 3); 99 pendentes → 100º lança `pix_manual_exhausted`; pedido
  expirado libera o offset; `orders.release` em pedido Asaas → `conflict`; papel `support` → `forbidden`.
- [ ] **Step 2–4:** FAIL → implementar → passa.
- [ ] **Step 5:** Commit `feat: Pix manual com valor único e liberação`.

---

### Task 9: Asaas — cliente, Pix automático, webhook e reembolso

**Files:**
- Create: `src/lib/payments/asaas/client.ts`, `src/lib/payments/asaas/pix.ts`, `src/lib/payments/asaas/webhook.ts`,
  `src/lib/payments/refund.ts`, `src/app/api/webhooks/asaas/[storeId]/route.ts`, `tests/fakes/asaas.ts`
- Test: `tests/asaas.test.ts`, `tests/asaas-webhook.test.ts`, `tests/asaas.sandbox.test.ts` (só roda com
  `ASAAS_SANDBOX_KEY`)

**Interfaces:**
- Consumes: `getIntegration`, `createOrder`, `transitionOrder`, `ActionError`.
- Produces:
  - `createAsaasClient({ apiKey: string; env: "sandbox"|"production"; fetch?: typeof fetch })` com:
    `createCustomer({ name, email, cpfCnpj, mobilePhone, externalReference }): Promise<{ id }>`,
    `createPayment(body, { timeoutMs }): Promise<AsaasPayment>`, `getPayment(id): Promise<AsaasPayment>`,
    `getPixQrCode(id): Promise<{ encodedImage: string; payload: string; expirationDate: string }>`,
    `refundPayment(id): Promise<AsaasPayment>`, `getBalance(): Promise<{ balance: number }>` (`GET /finance/balance`,
    usado pelo botão Testar). Erros viram `ActionError("provider_error", <mensagem do Asaas passada por redact>)`.
  - Conexão `asaas`: config `{ env, webhookToken }` público para exibir; segredo = API key. Ação
    `connections.saveAsaas({ env, apiKey })` (`connections.write`, `sensitive`) gera `webhookToken = randomToken()` e
    testa com `getBalance` antes de salvar. A URL do webhook mostrada é `${BASE_URL}/api/webhooks/asaas/<storeId>`.
  - `ensureAsaasCustomer(ctx, customerId): Promise<string>` — cria uma vez e guarda `asaas_customer_id`.
  - `startAsaasPix(ctx, orderId): Promise<{ qrImage: string; copyPaste: string; expiresAt: string }>` — cria cobrança
    `billingType: "PIX"`, `value = total_cents / 100`, `externalReference = order.id`, grava `payment`.
  - `mapAsaasStatus(s: string): OrderStatus | null` — `CONFIRMED|RECEIVED|RECEIVED_IN_CASH → paid`;
    `REFUNDED|REFUND_IN_PROGRESS → refunded`; `CHARGEBACK_REQUESTED|CHARGEBACK_DISPUTE|
    AWAITING_CHARGEBACK_REVERSAL → disputed`; `OVERDUE → expired`; outros → `null`.
  - `handleAsaasWebhook(storeId: string, headers: Headers, body: unknown): Promise<{ status: number }>` — compara
    `asaas-access-token` com `webhookToken` da loja (`timingSafeEqualStr`; diferente → 401); extrai `payment.id`;
    **reconsulta** `getPayment`; acha o pedido por `externalReference` **dentro da loja** (não achou → 200 e ignora);
    só vira `paid` se `value * 100 >= total_cents`; aplica `transitionOrder`; sempre 200 em evento já processado.
  - Ação `orders.refund({ orderId })` (`orders.refund`, `sensitive`): Asaas → `refundPayment` e depois
    `transitionOrder("refunded")`; Pix manual → só `transitionOrder("refunded")` com aviso para devolver pelo banco.

- [ ] **Step 1: Testes que falham** (com `tests/fakes/asaas.ts`: servidor fake via `fetch` injetado) — `startAsaasPix`
  envia `value: 9.9` para pedido de 990 e `externalReference` = id; webhook com token errado → 401 e nada muda; token da
  loja B no webhook da loja A → 401 (Review Focus 4); webhook cujo corpo diz `RECEIVED` mas reconsulta diz `PENDING`
  → nada muda; mesmo webhook `RECEIVED` 3 vezes em paralelo → um `paid`, um `deliver_order` (Review Focus 1); valor
  pago menor que o total → continua `pending`; `CHARGEBACK_REQUESTED` em pedido pago → `disputed`; reembolso chama o
  endpoint e muda estado; erro do Asaas contendo número de cartão não vaza na mensagem.
- [ ] **Step 2–4:** FAIL → implementar → passa. Rodar `tests/asaas.sandbox.test.ts` com chave de sandbox: cria
  cliente, cobrança Pix e lê o QR.
- [ ] **Step 5:** Commit `feat: Asaas Pix, webhook verificado e reembolso`.

---

### Task 10: Cartão Asaas no próprio checkout, com proteção contra teste de cartão

**Files:**
- Create: `src/lib/payments/asaas/card.ts`, `src/lib/payments/ratelimit.ts`, `src/lib/payments/turnstile.ts`,
  `src/lib/db/schema/card.ts`, `src/app/api/checkout/card/route.ts`
- Test: `tests/card.test.ts`, `tests/ratelimit.test.ts`

**Interfaces:**
- Consumes: `createAsaasClient`, `ensureAsaasCustomer`, `transitionOrder`, `redact`, `log`.
- Produces:
  - Tabela (RLS) `card_attempt(id, store_id, order_id, idempotency_key text unique, status in
    ('processing','approved','declined','error'), asaas_payment_id null, error_message null, created_at)` — **sem
    nenhum dado de cartão nem do titular**. Tabela `rate_limit(key text, window_start timestamptz, count int,
    pk(key, window_start))` sem RLS (chaves `card:ip:<ip>` e `card:email:<sha256(email)>`).
  - `checkRateLimit(key: string, limit: number, windowSec: number): Promise<boolean>`. Limites: IP 10/h, e-mail 5/h.
    Cartão: 3 tentativas/h por impressão digital `sha256(SECRET + número)` guardada **só num `Map` em memória** com
    expiração.
  - `verifyTurnstile(token: string | undefined, ip: string): Promise<boolean>` — se `TURNSTILE_SECRET` não existe,
    `true`; exigido quando o IP já teve ≥ 1 recusa na última hora.
  - `payWithCard(ctx, input: { orderPublicId; idempotencyKey: string (uuid); installments: number;
    card: { holderName; number; expiryMonth; expiryYear; ccv }; holder: { cpf; postalCode; addressNumber };
    turnstileToken?: string; clientIp: string }): Promise<{ status: "approved"|"declined"; message?: string }>` — esta
    **não** é uma ação registrada (para não passar pela auditoria); chamada só pela rota. Sequência: pedido `pending`
    e `card_asaas` da loja; já `paid` → `approved`; `insert card_attempt` com a chave (conflito → espera o status da
    tentativa existente e devolve o mesmo resultado); limites e Turnstile (`rate_limited`); `installments ≤
    offer.max_installments`; `createPayment({ billingType: "CREDIT_CARD", ..., installmentCount?, installmentValue?,
    remoteIp }, { timeoutMs: 60_000 })`; 200 → `transitionOrder("paid")`; 400 → `declined` com mensagem genérica
    ("Pagamento recusado. Confira os dados ou pague com Pix."). Os objetos do cartão saem de escopo ao fim; nenhum
    `log` recebe `input`.
  - Rota `POST /api/checkout/card`: resolve a loja pelo host, chama `payWithCard`, devolve JSON; `catch` registra só
    `redact(err)`; resposta exige HTTPS fora de desenvolvimento.

- [ ] **Step 1: Testes que falham** — mesma `idempotencyKey` em 2 chamadas paralelas → 1 chamada ao Asaas fake (Review
  Focus 2); chaves diferentes em pedido já pago → `approved` sem nova cobrança; recusa do fake com mensagem que ecoa
  `"4444444444444444"` → resposta e todas as linhas capturadas de `log` não contêm `4444` nem o CVV (Review Focus 5);
  nenhuma linha de nenhuma tabela contém o número após o fluxo (varrer `card_attempt`, `audit_log`, `job`, `payment`);
  11ª tentativa do mesmo IP na hora → `rate_limited`; 4ª tentativa do mesmo cartão → `rate_limited`; parcelas acima do
  máximo → `invalid_input`; corpo enviado ao Asaas contém `remoteIp` = IP do cliente.
- [ ] **Step 2–4:** FAIL → implementar → passa. Teste de sandbox com o cartão de teste do Asaas (aprovado e recusado).
- [ ] **Step 5:** Commit `feat: cartão Asaas transparente com antifraude básico`.

---

### Task 11: Checkout público e página do pedido

**Files:**
- Create: `src/app/c/[slug]/page.tsx`, `src/app/c/[slug]/checkout-form.tsx` (client), `src/app/c/[slug]/actions.ts`,
  `src/app/o/[publicId]/page.tsx`, `src/app/o/[publicId]/status.tsx` (client),
  `src/app/api/orders/[publicId]/status/route.ts`, `src/lib/checkout.ts`
- Test: `tests/checkout.test.ts`

**Interfaces:**
- Consumes: `resolveStore`, `offers.getPublic`, `createOrder`, `allocateManualAmount`, `buildPixBrCode`,
  `startAsaasPix`, `payWithCard`, `getIntegration`.
- Produces:
  - Ação pública `checkout.start({ slug, withBump, method: "pix"|"card", customer: { name, email, phone, cpf? },
    touch, ref?, fbc?, fbp?, eventId })` (`permission: "public"`) → `{ publicId, method }`. Regras: `method` precisa
    estar em `offer.methods`; CPF obrigatório e validado (dígitos verificadores) se o pagamento for Asaas
    (`pix_mode = 'asaas'` ou cartão); com `pix_mode = 'manual'` o CPF não é pedido nem guardado; e-mail validado;
    telefone BR com DDD. Pix manual esgotado e Asaas conectado → se veio CPF válido, cria o pedido como `pix_asaas`;
    sem CPF, devolve `ActionError("conflict", "needs_cpf")` e o formulário mostra o campo CPF e reenvia. Sem Asaas →
    mensagem "Pix indisponível no momento, tente em alguns minutos". Cartão exige conexão Asaas na loja.
  - Ação pública `checkout.view({ slug, touch })` grava `checkout_view`.
  - `getOrderPublic(storeId, publicId)` → `{ status, method, totalCents, manualAmountCents, pix?: { qrImage | brCode,
    copyPaste, expiresAt }, items: [{ name }], thankYouText }` — nunca e-mail, CPF ou ids internos; `publicId` de outra
    loja → `null` (Review Focus 4).
  - `GET /api/orders/[publicId]/status` → `{ status }` (polling a cada 3 s por até 30 min na página do pedido).
  - Página `/c/[slug]`: resumo, caixa do bump (`bump_label` + "+ R$ 17,10"), nome, e-mail, WhatsApp, escolha Pix/Cartão
    (só os métodos da oferta), CPF só quando exigido, campos do cartão (nome impresso, número, validade, CVV, CEP, número
    do endereço, parcelas se `max_installments > 1`), widget Turnstile quando a API pedir. Primeiro carregamento sem JS
    pesado; layout pensado para celular (≤ 400 px).
  - Página `/o/[publicId]`: `pending` + Pix → QR e copia-e-cola com botão copiar e aviso (manual: "o envio acontece
    depois que o pagamento for conferido"); `paid` → obrigado com `thank_you_text` e "enviamos o acesso para seu e-mail";
    `declined/expired` → link para tentar de novo.

- [ ] **Step 1: Testes que falham** (na camada de ações) — oferta só com Pix recusa `method: "card"`; CPF inválido →
  `invalid_input` quando `pix_mode = 'asaas'`; `pix_mode = 'manual'` ignora CPF enviado e não o salva; bump marcado gera
  pedido de 2700; `getOrderPublic` não contém e-mail nem CPF; `publicId` da loja B consultado pelo host da loja A →
  `null`; manual esgotado com Asaas conectado → sem CPF dá `needs_cpf`, com CPF vira pedido `pix_asaas`.
- [ ] **Step 2–4:** FAIL → implementar → passa.
- [ ] **Step 5: Verificação manual** — `bun run dev`, criar loja e oferta, abrir `/c/<slug>` em largura 375 px e
  concluir um Pix manual até a liberação. Anotar o que achar no PR.
- [ ] **Step 6:** Commit `feat: checkout público e página do pedido`.

---

### Task 12: Entrega por e-mail com link pessoal e PDF personalizado

**Files:**
- Create: `src/lib/delivery/mailer.ts`, `src/lib/delivery/links.ts`, `src/lib/delivery/watermark.ts`,
  `src/lib/delivery/jobs.ts`, `src/lib/db/schema/delivery.ts`, `src/app/d/[token]/route.ts`
- Test: `tests/delivery.test.ts`, `tests/watermark.test.ts`

**Interfaces:**
- Consumes: `storage`, `getIntegration`, `enqueue`, handlers da fila.
- Produces:
  - Tabelas (RLS): `download_link(id, store_id, order_id, product_id, token_hash unique, expires_at, max_downloads
    default 5, downloads default 0, revoked_at null)`; `email_log(id, store_id, order_id null, to_hash, kind, status in
    ('sent','failed'), error null, at)`.
  - Conexão `smtp`: config `{ host, port, secure, user, from }`, segredo = senha. Ação `connections.saveSmtp` testa com
    `transporter.verify()` antes de salvar. Ação `connections.testSmtp({ to })` envia e-mail de teste.
  - `sendMail(storeId, { to, subject, html, text }): Promise<void>` — nodemailer com a conexão da loja; sem conexão →
    erro `provider_error("E-mail não configurado")`.
  - `issueDownloadLinks(tx, order): Promise<Array<{ productName; url }>>` — um link por item, token `randomToken()`,
    guarda só `sha256(token)`, validade 30 dias.
  - Handler `deliver_order`: emite links (reaproveita se já existirem e não revogados) e envia e-mail "Seu acesso:
    <produto>" com os links; falha lança erro (a fila re-tenta) e grava `email_log` `failed`.
  - Handler `notify_seller`: e-mail para `store.notify_email` com produto, valor e método.
  - Handler `revoke_downloads`: `revoked_at = now()` nos links do pedido.
  - `watermarkPdf(pdf: Uint8Array, text: string): Promise<Uint8Array>` — rodapé em todas as páginas, fonte Helvetica 7 pt,
    cinza 50%, centralizado a 12 pt da borda inferior. Texto: `Licenciado para <nome> — <email>`.
  - `GET /d/[token]`: valida hash, loja, validade, revogação e limite; incrementa `downloads` atomicamente; serve o PDF
    personalizado (cache em `storage` em `wm/<orderId>/<productId>.pdf`), `Content-Disposition: attachment`; inválido
    → página "Link expirado, peça um novo ao vendedor" (410).
  - Ação `orders.resend({ orderId, renew?: boolean })` (`orders.resend`): `renew` revoga e emite novos; enfileira
    `deliver_order`.

- [ ] **Step 1: Testes que falham** — pedido pago → e-mail capturado (transporte fake) com 2 links quando há bump;
  6º download → 410; link revogado após reembolso → 410; token de outra loja → 410; PDF resultante tem o mesmo número
  de páginas e o texto do rodapé extraível; SMTP fake falhando → pedido continua `paid`, job reagendado,
  `email_log.failed` gravado (Review Focus 5b); `support` consegue `orders.resend`.
- [ ] **Step 2–4:** FAIL → implementar → passa.
- [ ] **Step 5:** Medir `watermarkPdf` no PDF real do dono (anotar tempo e memória no PR; aceitável < 2 s e < 200 MB).
- [ ] **Step 6:** Commit `feat: entrega com link pessoal e PDF personalizado`.

---

### Task 13: Rastreamento — script da página de vendas, Pixel e API de Conversões

**Files:**
- Create: `public/t.js`, `src/lib/tracking/touch.ts`, `src/lib/tracking/meta.ts`, `src/app/c/[slug]/pixel.tsx`,
  `src/app/o/[publicId]/pixel.tsx`
- Test: `tests/touch.test.ts`, `tests/meta.test.ts`, `tests/t-script.test.ts`

**Interfaces:**
- Consumes: `getIntegration`, tipo de job `meta_event` da fila, `createOrder` (campos `touch`, `fbc`, `fbp`, `ref`).
- Produces:
  - `public/t.js` (vanilla, < 3 KB, sem dependências), incluído na página de vendas externa com
    `<script src="https://<checkout-host>/t.js" data-checkout="<checkout-host>" defer>`: lê `utm_source, utm_medium,
    utm_campaign, utm_content, utm_term, fbclid, ref` da URL; grava primeiro toque (se não existir) e último toque em
    `localStorage` (`funil_touch`); acrescenta esses parâmetros, mais `ft` (primeiro toque em base64url JSON), a todo
    link `<a>` cujo host é `data-checkout`.
  - `parseTouch(url: URL, cookies): Touch & { ref?; fbc?; fbp? }` — no checkout; `fbc` derivado de `fbclid`
    (`fb.1.<ms>.<fbclid>`) quando o cookie `_fbc` não existe.
  - Conexão `meta`: config `{ pixelId, testEventCode? }`, segredo = token da API de Conversões; `offer.pixel_id`
    sobrescreve o pixel. `META_GRAPH_VERSION` em constante, com a versão atual da documentação do Meta no dia da
    implementação.
  - `buildMetaUserData(c: { email; phone; name; ip; ua; fbc?; fbp? })` — e-mail minúsculo e sem espaços, telefone só
    dígitos com `55`, primeiro/último nome minúsculos; todos em SHA-256; `client_ip_address` e `client_user_agent` sem
    hash.
  - Event ids: `InitiateCheckout` = `eventId` gerado na página do checkout e enviado em `checkout.start`;
    `Purchase` = `purchase:<order.id>`. Browser e servidor usam o mesmo id.
  - Handler `meta_event` (payload `{ event: "Purchase" | "InitiateCheckout"; orderId; eventId? }`): `POST https://graph.facebook.com/<META_GRAPH_VERSION>/<pixelId>/events` com
    `event_name: "Purchase"`, `event_time` = `paid_at` em segundos, `action_source: "website"`, `event_source_url`,
    `custom_data: { currency: "BRL", value: total_cents / 100, content_ids: [productIds], content_type: "product" }`.
    `checkout.start` também enfileira `meta_event` com `event: "InitiateCheckout"` e o `eventId` da página.
  - Pixel no navegador: `/c/[slug]` dispara `PageView` + `InitiateCheckout` (com `eventID`); ao escolher pagamento,
    `AddPaymentInfo`; `/o/[publicId]` dispara `Purchase` com `eventID: "purchase:<id>"` uma única vez quando o status
    vira `paid` (guardar em `sessionStorage`).

- [ ] **Step 1: Testes que falham** — `buildMetaUserData` com e-mail `" Ana@X.com "` gera o SHA-256 de `"ana@x.com"`;
  corpo enviado ao Meta fake tem `event_id` `purchase:<id>` e `value: 27` para o pedido de 2700; sem conexão Meta o job
  termina sem erro; `parseTouch` com `?utm_source=ig&ref=joao&fbclid=abc` preenche `last` e `ref`, e `fbc` começa com
  `fb.1.`; `t.js` (rodado com happy-dom ou JSDOM) decora só links do host do checkout e preserva o primeiro toque entre
  visitas.
- [ ] **Step 2–4:** FAIL → implementar → passa.
- [ ] **Step 5:** Commit `feat: rastreamento com UTM, indicação, Pixel e CAPI`.

---

### Task 14: Painel — visão geral, pedidos, catálogo e conexões

**Files:**
- Create: `src/lib/metrics.ts`, `src/app/admin/page.tsx`, `src/app/admin/orders/page.tsx`,
  `src/app/admin/orders/[id]/page.tsx`, `src/app/admin/orders.csv/route.ts`, `src/app/admin/products/page.tsx`,
  `src/app/admin/offers/page.tsx`, `src/app/admin/offers/[id]/page.tsx`, `src/app/admin/connections/page.tsx`,
  `src/app/admin/settings/page.tsx`, `src/app/admin/ui.tsx`
- Test: `tests/metrics.test.ts`, `tests/panel-actions.test.ts`

**Interfaces:**
- Consumes: todas as ações anteriores, `getPanelActor`.
- Produces:
  - Ação `metrics.summary({ from: Date; to: Date })` (`metrics.read`) → `{ views: number; orders: number;
    paid: number; revenueCents: number; byMethod: Record<Method, { orders; paid; revenueCents }>;
    bySource: Array<{ source: string; paid: number; revenueCents: number }>;
    byRef: Array<{ ref: string; paid: number; revenueCents: number }> }` — `source` = `last_touch.utm_source` ou
    `"direto"`; receita = soma de `total_cents` dos pedidos `paid` com `paid_at` no período (reembolsados ficam fora).
  - Ação `orders.list({ status?; method?; q?; page })` (`orders.read`, 50 por página, busca por e-mail ou nome) e
    `orders.get({ id })` com itens, pagamentos, links e e-mails enviados. Pedido Pix manual mostra o valor único em
    destaque e o aviso "Confira no extrato do banco. Nunca libere por comprovante enviado pelo comprador."
  - `GET /admin/orders.csv` (`orders.export`): data, status, método, produto(s), valor, nome, e-mail, telefone,
    utm_source, utm_campaign, ref. **Sem CPF.**
  - Ação `store.updateSettings({ name, notifyEmail })` (`connections.write`).
  - Telas: visão geral (período: hoje, 7 dias, 30 dias), pedidos com filtros e botões Liberar / Reenviar / Reembolsar
    (os dois sensíveis com diálogo de confirmação), produtos (upload de PDF), ofertas (preço, métodos, Pix manual ou
    Asaas, parcelas, bump, texto de obrigado, pixel próprio, link do checkout para copiar), conexões (Pix manual,
    Asaas com a URL e o token do webhook para colar no Asaas, SMTP, Meta; cada uma com Testar; segredos aparecem só
    como "configurado"), configurações (nome da loja, e-mail para aviso de venda, snippet `<script>` do `t.js` para
    copiar). Botões e menus aparecem conforme as permissões do papel.

- [ ] **Step 1: Testes que falham** — `metrics.summary` com pedidos semeados (2 pagos de 990 via `ig`, 1 pago de 2700
  com `ref=joao`, 1 reembolsado, 1 pendente) devolve `paid: 3`, `revenueCents: 4680`, `bySource` com `ig`, `byRef`
  com `joao`; CSV não contém CPF; `traffic` recebe `forbidden` em `orders.list`; `support` não vê Reembolsar.
- [ ] **Step 2–4:** FAIL → implementar → passa.
- [ ] **Step 5: Verificação manual** — percorrer o painel como `owner` e como `support` em 375 px e em desktop.
- [ ] **Step 6:** Commit `feat: painel de vendas, pedidos, catálogo e conexões`.

---

### Task 15: Empacotamento — Docker, Caddy e guia de instalação

**Files:**
- Create: `deploy/Dockerfile`, `compose.yaml`, `deploy/Caddyfile`, `deploy/entrypoint.sh`, `README.md`,
  `docs/instalacao.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `.github/workflows/ci.yml`

**Interfaces:**
- Produces:
  - Imagem multi-stage (Bun para build, runtime Node ou Bun com saída `standalone`), usuário não-root, `entrypoint.sh`
    roda `migrate.ts` (papel dono) e inicia o app (papel `app`).
  - `compose.yaml`: `app`, `postgres:17` (volume nomeado), `caddy` (portas 80/443, HTTPS automático para `DOMAIN`, e no
    modo `multi` também `*.PLATFORM_DOMAIN` via DNS challenge configurável). Limite de memória do app 512 MB.
  - `.env.example` completo e comentado: `MODE`, `BASE_URL`, `DOMAIN`, `PLATFORM_DOMAIN`, `SECRET`,
    `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `DATA_DIR`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET`.
  - `THIRD_PARTY_NOTICES.md` com o aviso MIT do LibreFunnel para os arquivos adaptados.
  - CI: Postgres 17 como serviço + `bun run check`.
  - `docs/instalacao.md`: subir em VPS, configurar `checkout.<domínio>` no DNS, primeiro acesso (`/admin/setup` no
    single; `store:create` no multi), conectar Asaas (onde colar URL e token do webhook), SMTP, Meta, colar o `t.js`
    na página de vendas e o roteiro de migração da Cakto (spec §7.11).
  - Licença do projeto: **MIT provisório** em `LICENSE`, marcado no README como "a confirmar pelo dono" (AGPL é a
    alternativa comum para proteger a versão nuvem; decisão do dono antes de publicar).

- [ ] **Step 1:** Escrever um teste de fumaça `tests/smoke.sh`: `docker compose up -d --build`, esperar
  `GET /api/health` = 200, `docker compose down -v`.
- [ ] **Step 2:** Rodar → falha (arquivos não existem).
- [ ] **Step 3:** Implementar os arquivos.
- [ ] **Step 4:** `tests/smoke.sh` passa; confirmar `docker stats` com o app < 512 MB ocioso.
- [ ] **Step 5:** Commit `chore: empacotamento docker e guia de instalação`.

---

## Depois da fase 1

Compra de ponta a ponta em produção na loja do dono: um Pix manual de valor baixo liberado pelo painel, um Pix Asaas
e um cartão Asaas reais, com conferência do e-mail, do download personalizado e dos eventos no Gerenciador de Eventos
do Meta (aba "Testar eventos"). Só então trocar os links da página de vendas e dos anúncios. A fase 2 (MCP, fila de
aprovações, equipe e convites) ganha um plano próprio.
