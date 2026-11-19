# Isolamento do cartão: plano de implementação

> **Para agentes:** sub-skill obrigatória: superpowers:subagent-driven-development (recomendada) ou
> superpowers:executing-plans, tarefa por tarefa. Os passos usam checkbox (`- [ ]`).

**Objetivo:** tirar número, validade, CVV e nome impresso do cartão do app Next. Um serviço Node próprio passa a servir
o formulário do cartão num iframe (`pagar.<domínio>`) e a fazer a cobrança com a lógica atual de `card.ts`.

**Arquitetura:** o serviço `card` é um servidor `node:http` empacotado com `bun build` a partir de `src/card-service/`.
Ele reaproveita os módulos de `src/lib`, roda num container próprio, entra no Postgres com o papel `card` (mínimo
privilégio, RLS) e recebe só três chaves:
- a da conexão Asaas;
- a do bilhete;
- o segredo do Turnstile.

O app emite um bilhete HMAC por pedido e conversa com o iframe por `postMessage`. A entrega vai em três PRs, por causa
da regra de verificação separada; o primeiro deixa tudo atrás de `CARD_ISOLATED`, desligado por padrão.

**Stack:** Node 22 (`node:http`, `node:crypto`), Bun 1.4.4 para testes e empacotamento, Drizzle + postgres.js,
Zod 4, Next 16 no app, Caddy 2.11, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-11-19-isolamento-cartao-design.md`

## Restrições globais

- **Dados do cartão:** número, validade, CVV e nome impresso nunca são persistidos nem logados, nem chegam ao app Next
  (rede, URL, cabeçalho, `postMessage` ou bundle).
- **Isolamento do serviço `card`:**
  - não importa nada de `next`, `react`, `nodemailer` nem `pdf-lib`;
  - não recebe `SECRET`, `OWNER_DATABASE_URL` nem credenciais SMTP/Meta;
  - não serve outra rota além de `GET /form/<storeId>`, `GET /form.js`, `GET /form.css`, `POST /api/card` e
    `GET /healthz`.
- **Código em `src/`:** roda em Node em produção, então nada de API exclusiva do Bun (o Bun só empacota e testa).
- **Dinheiro:** sempre em centavos inteiros.
- **Banco:**
  - toda tabela nova tem `store_id` e chama `enable_store_rls`;
  - o papel `card` não tem `BYPASSRLS`;
  - novas tabelas não ganham permissão automática para `card`.
- **Rotas do app:** rota e página nova chamam só `runAction`.
- **PRs:** PR de produto nunca edita `.claude/`, `REVIEW.md`, `scripts/verify*`, `e2e/`, `.github/` nem
  `playwright.config.ts`. A ordem é PR 1 (produto, `CARD_ISOLATED=0` por padrão), PR 2 (verificação), PR 3 (produto,
  remove o caminho antigo).
- **Domínio do cartão:** `CARD_ORIGIN`, padrão `https://pagar.<DOMAIN>` no single e um único
  `https://pagar.<PLATFORM_DOMAIN>` no multi. O slug `pagar` fica reservado no multi.
- **Mensagens ao comprador:** em português, as mesmas de hoje (`card.ts`, `checkout-form.tsx`); sem texto novo, salvo
  o de iframe indisponível (Task 8).
- **Verificação:** `bash scripts/verify.sh` verde antes de cada PR; nunca pular, re-tentar nem pôr espera em teste.

## Foco de revisão

1. **Bump ligado ou desligado depois de o iframe carregar:** o seletor de parcelas no iframe mostra o total novo; o
   servidor valida parcelas contra o pedido de qualquer forma. Teste na Task 8.
2. **Bilhete vencido:** o comprador demora ou tenta de novo depois de uma recusa. O app emite um bilhete novo para o
   mesmo pedido sem criar outro pedido. Teste nas Tasks 6 e 8.
3. **Rede cai entre o `POST /api/card` e a resposta:** a próxima tentativa com os mesmos dados reaproveita a chave de
   idempotência, sem cobrança em dobro. Teste na Task 7.
4. **Iframe não carrega** (DNS do `pagar.` faltando ou serviço fora): em até 10 s o app mostra "Pagamento com cartão
   indisponível agora. Tente de novo em instantes ou pague com Pix." e não cria pedido. Teste na Task 8.
5. **`postMessage` de outra origem ou de outro frame:** ignorado dos dois lados, e o iframe só responde à origem da
   loja dona. Teste nas Tasks 7 e 8.

---

## PR 1: produto, com `CARD_ISOLATED=0` por padrão

### Task 1: variáveis de ambiente e modo `SERVICE=card`

**Arquivos:**
- Modificar: `src/lib/env.ts`, `.env.example`, `src/lib/crypto.ts` (só o acesso ao `SECRET`)
- Testes: `tests/env.test.ts`, `tests/deploy-config.test.ts` (lista de variáveis documentadas)

**Interfaces:**
- Produz:
  - `env.SERVICE: "app" | "card"`, padrão `"app"`;
  - `env.CARD_ISOLATED: boolean`, de `"0" | "1"`, padrão `"0"`;
  - `env.CARD_ORIGIN?: string`, origem https sem barra final;
  - `env.CARD_TICKET_KEY?: string` e `env.ASAAS_SEAL_KEY?: string`, cada um com mínimo de 32 caracteres;
  - `env.CARD_DB_PASSWORD?: string`;
  - `env.SECRET?: string`, que passa a opcional no tipo;
  - `requireSecret(): string` em `src/lib/env.ts`, que lança erro claro se `SECRET` faltar;
  - todos os usos atuais de `env.SECRET` passam a usar `requireSecret()`.

- [ ] **Passo 1: testes que falham**, em `tests/env.test.ts`:
  - `SERVICE=app` sem `SECRET` falha com "SECRET";
  - `SERVICE=card` com `SECRET` definido falha com "SECRET não pode ser passado ao serviço de cartão";
  - `SERVICE=card` sem `CARD_TICKET_KEY`, `ASAAS_SEAL_KEY` ou `CARD_ORIGIN` falha, com o nome da variável;
  - `CARD_ISOLATED=1` no app sem `CARD_ORIGIN`, `CARD_TICKET_KEY` ou `ASAAS_SEAL_KEY` falha;
  - `CARD_ORIGIN` com caminho, barra final ou `http:` fora de loopback falha;
  - os valores válidos dos dois modos passam.
- [ ] **Passo 2:** `bun test tests/env.test.ts`. Esperado: FAIL.
- [ ] **Passo 3:** implementar no `superRefine` do schema, documentar no `.env.example` e trocar os usos de
  `env.SECRET` por `requireSecret()`.
- [ ] **Passo 4:** `bun test tests/env.test.ts tests/deploy-config.test.ts && bun run typecheck`. Esperado: PASS.
- [ ] **Passo 5:** commit `feat(cartão): variáveis do serviço de cartão isolado`.

### Task 2: chave própria para a conexão Asaas

**Arquivos:**
- Modificar: `src/lib/crypto.ts`, `src/lib/integrations.ts`, `src/instrumentation.ts` (re-selagem no boot do app)
- Teste: `tests/crypto.test.ts`, `tests/integrations-seal.test.ts` (novo)

**Interfaces:**
- **Produz:**
  - `createSealer(secret: string, opts?: { info?: string; version?: string })`. O padrão continua
    `info="funil:seal:v1"` e `version="v1"`.
  - `asaasSealer()`: usa `ASAAS_SEAL_KEY`, com `info="funil:seal:asaas:v1"` e `version="a1"`.
  - `openIntegrationSecret(kind: string, sealed: string): string` em `src/lib/integrations.ts`:
    - prefixo `a1.`: `asaasSealer`;
    - prefixo `v1.`: sealer do `SECRET`;
    - `kind` diferente de `asaas` com `a1.`: lança erro.
  - `resealAsaasSecrets(): Promise<number>`: re-sela as conexões `asaas` em `v1.` para `a1.` quando `ASAAS_SEAL_KEY`
    existe. Idempotente, devolve quantas linhas mudou.
- **Regra de gravação:** com `ASAAS_SEAL_KEY` definido, `saveIntegration` sela `asaas` com `asaasSealer`; as demais
  sempre com o `SECRET`.

- [ ] **Passo 1: testes que falham.**
  - Ida e volta `a1`.
  - Um `a1.` aberto com outra chave lança erro.
  - `openIntegrationSecret("smtp", "a1....")` lança erro.
  - `resealAsaasSecrets()`:
    - converte uma linha `v1.` de `asaas`;
    - não toca em `smtp`;
    - na segunda chamada, devolve 0.
  - Com `env` de `SERVICE=card` (sem `SECRET`):
    - abrir `a1.` funciona;
    - abrir `v1.` lança o erro do `requireSecret`.
- [ ] **Passo 2:** rodar os testes. Esperado: FAIL.
- [ ] **Passo 3:** implementar e chamar `resealAsaasSecrets()` no `register()` do app, antes de `startWorker`, só com
  `SERVICE=app`.
- [ ] **Passo 4:** `bun test tests/crypto.test.ts tests/integrations-seal.test.ts tests/asaas.test.ts`. Esperado:
  PASS.
- [ ] **Passo 5:** commit `feat(cartão): chave própria para o segredo da conexão Asaas`.

### Task 3: papel `card` no Postgres

**Arquivos:**
- Modificar: `src/lib/db/migrate.ts`, `src/lib/db/rls.sql`
- Teste: `tests/card-role.test.ts` (novo), usando `tests/db.ts`

**Interfaces:**
- **Produz:**
  - `migrate(ownerUrl, appPassword, cardPassword?: string)` cria ou altera o papel `card` (login, `nosuperuser`,
    `nobypassrls`) quando `cardPassword` é passado;
  - `createTestDb()` passa a expor `cardUrl` (em `tests/db.ts`).
- **Regras de permissão:**
  - só `grant` explícitos, nunca `default privileges`;
  - conexões: além do `store_isolation`, uma política `as restrictive for select to card using (kind = 'asaas')`;
  - lista inicial do que conceder:
    - `select`: `orders`, `order_item`, `offer`, `customer`, `integration`, `store`;
    - `select, insert, update`: `card_attempt` e `payment`;
    - `select, insert, update, delete`: `rate_limit`;
    - `update (status, paid_at, updated_at)`: `orders`;
    - `insert`: `job`, `store_alert` e `audit_log`.
  - Ajustar rodando a suíte de cartão com o papel `card` e concedendo só o que falhar. A lista final fica comentada
    no `rls.sql`.

- [ ] **Passo 1: testes que falham.** Com o papel `card`:
  - `select` em `users`, `session`, `membership`, `login_attempt`, `product` e `download_token` dá "permission
    denied";
  - a conexão `smtp` da loja não aparece, a `asaas` aparece;
  - `insert` em `orders` dá "permission denied";
  - uma tabela criada depois da migração não é legível pelo papel `card`.
- [ ] **Passo 2:** rodar. Esperado: FAIL.
- [ ] **Passo 3:** implementar.
- [ ] **Passo 4:** rodar os testes de pagamento com cartão (`tests/card.test.ts`, os casos de `payWithCard`) com o
  `db` do app apontado para o `cardUrl`, por meio de um `describe` parametrizado em `tests/card-role.test.ts`.
  Esperado: PASS com a lista final de permissões.
- [ ] **Passo 5:** commit `feat(cartão): papel card no Postgres com o mínimo para cobrar`.

### Task 4: bilhete do pedido e origens da loja

**Arquivos:**
- Criar: `src/lib/payments/card-ticket.ts`
- Modificar: `src/lib/stores.ts` (origens e slug reservado)
- Teste: `tests/card-ticket.test.ts`, `tests/stores.test.ts` (ou o arquivo que já testa `resolveStore`)

**Interfaces:**
- **Bilhete:**
  - `CARD_TICKET_TTL_MS = 30 * 60 * 1000`;
  - `issueCardTicket(t: { storeId: string; orderId: string; publicId: string }, key: string, now?: Date): string`,
    no formato `base64url(JSON {s,o,p,e}) + "." + base64url(HMAC-SHA256)`;
  - `verifyCardTicket(token: string, key: string, now?: Date): { storeId: string; orderId: string; publicId: string } | null`,
    que compara em tempo constante e devolve `null` para qualquer defeito.
- **Origens:** `storeCheckoutOrigins(storeId: string): Promise<string[]>`:
  - no single, `[new URL(BASE_URL).origin]`;
  - no multi, `https://<domain>` (se houver) e `https://<slug>.<PLATFORM_DOMAIN>`;
  - loja inexistente devolve `[]`.
- **Slug reservado:** `RESERVED_SLUGS` inclui `"pagar"`, e a criação de loja recusa esse slug.

- [ ] **Passo 1: testes que falham.**
  - Ida e volta do bilhete.
  - Recusa do bilhete:
    - expirado em `now + TTL + 1`;
    - um byte trocado no corpo ou na assinatura;
    - outra chave;
    - string vazia, sem ponto, ou JSON inválido;
    - `s`/`o` que não são UUID.
  - Origens nos dois modos.
  - Slug `pagar` recusado.
- [ ] **Passo 2:** rodar. Esperado: FAIL.
- [ ] **Passo 3:** implementar.
- [ ] **Passo 4:** rodar. Esperado: PASS.
- [ ] **Passo 5:** commit `feat(cartão): bilhete assinado do pedido e origens do checkout da loja`.

### Task 5: protocolo de mensagens entre checkout e iframe

**Arquivos:**
- Criar: `src/lib/card-frame/protocol.ts`, um módulo puro sem dependências, usado pelo app e pelo iframe
- Teste: `tests/card-frame-protocol.test.ts`

**Interfaces:**
- **Do app para o iframe (`ParentMsg`):**
  - `{ t: "funil-card:config"; totalCents: number; maxInstallments: number }`;
  - `{ t: "funil-card:validate"; id: string }`;
  - `{ t: "funil-card:pay"; id: string; orderPublicId: string; ticket: string; buyerCpf: string }`.
- **Do iframe para o app (`FrameMsg`):**
  - `{ t: "funil-card:ready" }`;
  - `{ t: "funil-card:height"; px: number }`;
  - `{ t: "funil-card:validated"; id: string; ok: boolean; fields: string[] }`;
  - `{ t: "funil-card:result"; id: string; status: "approved" | "declined" | "unknown" | "unavailable" | "error"; message?: string; last4?: string; fields?: string[][]; captcha?: boolean; ticketExpired?: boolean }`.
- **Validação das mensagens:**
  - `parseParentMsg(data: unknown): ParentMsg | null` e `parseFrameMsg(data: unknown): FrameMsg | null` validam
    formato e limites: `px` de 0 a 4000, strings com no máximo 4096 caracteres, `last4` com exatamente 4 dígitos;
  - qualquer chave extra é descartada.

- [ ] **Passo 1: testes que falham.**
  - Cada tipo válido passa.
  - Tipo desconhecido, campo faltando, `px` negativo ou `last4` com mais de 4 dígitos dão `null`.
  - Uma mensagem com campo extra `number` sai sem esse campo.
- [ ] **Passos 2 a 5:** rodar (FAIL), implementar, rodar (PASS) e fazer commit
  `feat(cartão): protocolo postMessage entre checkout e iframe`.

### Task 6: servidor do serviço de cartão

**Arquivos:**
- Criar: `src/card-service/server.ts`, `src/card-service/main.ts`, `src/card-service/page.ts`
- Modificar: `src/lib/payments/asaas/card-http.ts`, para extrair o mapeamento de erros para
  `cardErrorResponse(e: unknown): { status: number; body: object }` e o `clientIpFrom`, usados pelos dois lados
- Teste: `tests/card-service.test.ts`

**Interfaces:**
- **Consome:**
  - `verifyCardTicket` e `storeCheckoutOrigins` (Task 4);
  - `payWithCard` e `CardPaymentInput` (`card.ts`);
  - `cardErrorResponse` e `clientIpFrom`.
- **Produz:** `createCardServer(opts: { cardOrigin: string; ticketKey: string; trustProxy: number; turnstileSiteKey?: string; payWithCard?: typeof payWithCard; origins?: (storeId: string) => Promise<string[]> }): http.Server`.
- **Rotas:**
  - **`GET /form/<storeId>`:**
    - `storeId` inválido ou loja sem origens: 404;
    - devolve o HTML de `page.ts` com o `<link>` de `/form.css` e o `<script src="/form.js">`;
    - os dados de configuração vão num `<script type="application/json" id="cfg">` com `allowedOrigins` e
      `turnstileSiteKey`;
    - CSP: `default-src 'none'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; connect-src 'self'; frame-src https://challenges.cloudflare.com; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors <origens da loja>`;
    - `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
  - **`GET /form.js` e `GET /form.css`:** o artefato da Task 7, com cache curto e `nosniff`.
  - **`POST /api/card`:**
    - checagens na ordem, antes de qualquer outra coisa:
      - `Content-Type: application/json`;
      - `Origin` igual a `cardOrigin`;
      - HTTPS pelo `X-Forwarded-Proto` com proxy confiável, salvo loopback.
    - corpo com teto de 16 KiB;
    - bilhete:
      - `verifyCardTicket(body.ticket)` nulo dá 403 com `{ error: "ticket", ticketExpired: <venceu?> }`;
      - `body.orderPublicId` diferente de `ticket.publicId` dá 403.
    - `payWithCard({ storeId: ticket.storeId }, { ...body, clientIp })`;
    - erros por `cardErrorResponse`.
  - **`GET /healthz`:** 200 `ok` quando o banco responde.
  - **Qualquer outra rota ou método:** 404 sem corpo.
- **`main.ts`:**
  - lê o `env` (`SERVICE=card`) e escuta em `0.0.0.0:3100`;
  - no SIGTERM, fecha o servidor e o pool.

- [ ] **Passo 1: testes que falham.** O servidor roda numa porta efêmera, com o `payWithCard` real, o banco de
  teste e o Asaas falso de `tests/fakes/asaas.ts`.
  - Bilhete ausente, inválido ou vencido dá 403, e o `payWithCard` (espião) nunca é chamado.
  - Bilhete de outra loja para o pedido dá 403.
  - `Origin` de outro site ou do app dá 403.
  - `Content-Type: text/plain` dá 403.
  - Corpo maior que 16 KiB dá 413.
  - Aprovação retorna `{ status: "approved" }`, com o pedido pago.
  - Cartão de recusa retorna `declined`.
  - `GET /form/<loja>`:
    - `frame-ancestors` contém exatamente as origens da loja;
    - o HTML não tem script inline executável.
  - `GET /admin`, `GET /api/checkout/card` e `PUT /api/card` dão 404.
  - Nenhuma linha de log (captureOutput) contém o número do cartão de teste.
- [ ] **Passo 2:** rodar. Esperado: FAIL.
- [ ] **Passo 3:** implementar. Os testes atuais de `handleCardCheckout` em `tests/card.test.ts` continuam passando
  com o mapeamento extraído.
- [ ] **Passo 4:** `bun test tests/card-service.test.ts tests/card.test.ts`. Esperado: PASS.
- [ ] **Passo 5:** commit `feat(cartão): servidor isolado do cartão (form, api, healthz)`.

### Task 7: formulário do iframe

**Arquivos:**
- Criar: `src/card-service/form/form.ts` (navegador), `src/card-service/form/logic.ts` (puro),
  `src/card-service/form/form.css`
- Modificar: `package.json` (scripts `card:build` e `card:dev`)
- Teste: `tests/card-form-logic.test.ts`, `tests/card-bundle.test.ts`

**Interfaces:**
- **Consome:**
  - `parseParentMsg` e `FrameMsg` (Task 5);
  - `cardExpiryValid`, `validCpf` e `onlyDigits` (`src/lib/validation/br.ts`).
- **Funções puras em `logic.ts`:**
  - `validateCardFields(v: CardFields, holderOther: boolean): string[]`, com os nomes dos campos com erro:
    `cardNumber`, `holderName`, `expiry`, `cvv`, `holderCpf`, `cep`, `addressNumber`;
  - `attemptKey(prev: { key: string; sig: string } | null, sig: string, newKey: () => string): { key: string; sig: string }`
    reaproveita a chave quando `sig` é igual;
  - `buildCardBody(v, holderOther, buyerCpf: string | null, installments, ticket, orderPublicId, key, turnstileToken?)`
    monta o corpo de `POST /api/card`;
  - `installmentOptions(totalCents: number, max: number): { n: number; label: string }[]`, com rótulos iguais aos de
    hoje no checkout.
- **CPF do titular:** quando "titular é outra pessoa" está desligado, o CPF do titular é o `buyerCpf` que chega em
  `funil-card:pay`.
- **`form.ts`:**
  - renderiza os campos com os mesmos rótulos e máscaras do checkout atual;
  - aceita mensagens só de `cfg.allowedOrigins` e responde à origem que mandou;
  - envia `ready` a cada origem permitida;
  - envia `height` sempre que o tamanho muda (ResizeObserver);
  - o Turnstile aparece quando a resposta pede `captcha`;
  - limpa número, validade e CVV da memória depois da resposta, mantendo os campos na tela para quem quiser corrigir;
  - os inputs não têm atributo `name`, e o `<form>` sem JS não envia nada (`action` ausente,
    `onsubmit = preventDefault`).
- **Empacotamento:**
  - `card:build` = `bun build src/card-service/main.ts --target=node --outfile=dist/card/server.js` mais
    `bun build src/card-service/form/form.ts --target=browser --minify --outfile=dist/card/form.js` e a cópia do CSS;
  - `card:dev` sobe o serviço local na porta 3100 com o `.env` de desenvolvimento.

- [ ] **Passo 1: testes que falham.**
  - `validateCardFields`:
    - cartão vencido dá `expiry`;
    - Luhn inválido dá `cardNumber`;
    - CPF do titular inválido só quando `holderOther` está ligado.
  - `attemptKey` mantém a chave para a mesma assinatura e troca quando o CVV muda.
  - `installmentOptions(2700, 3)` gera os rótulos atuais.
  - `card-bundle.test.ts` roda `card:build`:
    - `dist/card/server.js` não contém `nodemailer`, `pdf-lib`, `next/` nem `react`;
    - `dist/card/form.js` não contém `fetch(` para nenhum host além de caminho relativo `/api/card`.
- [ ] **Passos 2 a 5:** rodar (FAIL), implementar, rodar (PASS) e fazer commit
  `feat(cartão): formulário do cartão no iframe`.

### Task 8: checkout do app com o iframe (atrás de `CARD_ISOLATED`)

**Arquivos:**
- Modificar:
  - `src/app/c/[slug]/actions.ts`: `startCheckoutAction` devolve `cardTicket` para cartão isolado, e há uma ação nova
    `renewCardTicketAction`;
  - `src/app/c/[slug]/checkout-form.tsx` e a página que o monta, passando `cardFrame: { origin, src } | null`;
  - `src/proxy.ts`: `buyerCsp` ganha `cardOrigin?: string`, que entra em `frame-src`.
- Criar: `src/app/c/[slug]/card-frame.ts`, com a lógica pura do lado do app
- Teste: `tests/checkout.test.ts`, `tests/csp.test.ts`, `tests/card-frame-parent.test.ts`

**Interfaces:**
- **Consome:** Tasks 4 e 5.
- **Produz:**
  - `StartResult` ok ganha `cardTicket?: string`, presente só com `CARD_ISOLATED` ligado e método `card_asaas`;
  - `renewCardTicketAction(input: { publicId: string }): Promise<{ ok: true; ticket: string } | { ok: false; message: string }>`,
    via `runAction`, só para pedido `card_asaas` pendente da loja do host;
  - `acceptFrameMessage(ev: { origin: string; source: unknown; data: unknown }, frame: { origin: string; window: unknown }): FrameMsg | null`;
  - `FRAME_READY_TIMEOUT_MS = 10_000`.
- **Comportamento com `CARD_ISOLATED` ligado:**
  - os campos de cartão e titular saem do formulário do app;
  - o bloco do cartão vira o iframe `${CARD_ORIGIN}/form/${storeId}`;
  - o app manda `config` no `ready` e de novo sempre que o bump muda;
  - "Pagar":
    1. valida os dados pessoais;
    2. manda `validate` ao iframe, com resposta em `validated` (com erros, mostra e para);
    3. chama `startCheckoutAction` (ou reaproveita o pedido, como hoje);
    4. manda `pay`;
    5. no `result`: aprovado ou desconhecido vai para `/o/<id>`; recusa e erros como hoje; `ticketExpired` chama
       `renewCardTicketAction` e reenvia `pay` uma vez.
  - sem `ready` em `FRAME_READY_TIMEOUT_MS`: mostra o texto do Foco de revisão 4, deixa o "Pagar" do cartão
    desabilitado e não cria pedido.
- **Com `CARD_ISOLATED` desligado:** tudo exatamente como hoje.

- [ ] **Passo 1: testes que falham.**
  - **`buyerCsp`:** com `cardOrigin`, contém `frame-src ... https://pagar.loja.test`; sem ele, fica igual ao de hoje.
  - **`startCheckoutAction` com cartão e `CARD_ISOLATED` ligado:**
    - devolve um `cardTicket` que `verifyCardTicket` aceita para aquele pedido;
    - com Pix, não devolve.
  - **`renewCardTicketAction`:**
    - pedido de outra loja: falha;
    - pedido pago: falha;
    - Pix: falha.
  - **`acceptFrameMessage`:**
    - origem diferente: `null`;
    - `source` diferente da janela do iframe: `null`;
    - mensagem válida passa.
- [ ] **Passos 2 a 5:** rodar (FAIL), implementar, rodar (PASS) e fazer commit
  `feat(cartão): checkout com o cartão em iframe (CARD_ISOLATED)`.

### Task 9: container, Caddy, monitor PCI e documentação

**Arquivos:**
- **Modificar:**
  - `deploy/Dockerfile`: novo estágio `card` a partir do `NODE_IMAGE`, copiando só `dist/card` (sem
    `node_modules`, sem o `.next`), com tini, usuário não-root e `HEALTHCHECK` em `/healthz`;
  - `compose.yaml`:
    - serviço `card` em `profiles: ["card"]`;
    - `mem_limit: 192m` e `memswap_limit: 192m`;
    - `ulimits core 0`, `read_only: true`, `tmpfs /tmp`;
    - env só com `SERVICE=card`, `DATABASE_URL` do papel `card`, `CARD_ORIGIN`, `CARD_TICKET_KEY`, `ASAAS_SEAL_KEY`,
      `TRUST_PROXY`, `TURNSTILE_*`, `MODE`, `PLATFORM_DOMAIN` e `BASE_URL`;
  - `compose.yaml`, serviço `app`: passa `CARD_ISOLATED`, `CARD_ORIGIN`, `CARD_TICKET_KEY`, `ASAAS_SEAL_KEY` e
    `CARD_DB_PASSWORD`;
  - `deploy/entrypoint.sh`: a migração cria o papel `card` quando `CARD_DB_PASSWORD` existe;
  - `deploy/Caddyfile` e `deploy/Caddyfile.multi`: site `{$CARD_DOMAIN}` com `reverse_proxy card:3100`, HSTS, e
    nada do app nele. Sem `CARD_DOMAIN`, o site não é declarado (usar `import` condicional ou um arquivo separado
    `Caddyfile.card` incluído por `CADDYFILE`; a escolha fica com o construtor, desde que o padrão continue subindo
    sem o cartão);
  - `src/lib/security/page-monitor.ts`: com `CARD_ISOLATED` ligado, também busca `${CARD_ORIGIN}/form/<loja>` e
    confere a CSP exata da Task 6 e o inventário de scripts (só `/form.js` do domínio do cartão e Turnstile);
  - `docs/seguranca-pagamento.md`, com o escopo novo e a regra de firewall de saída do container `card` (só Asaas,
    Turnstile e Postgres), caso o compose não consiga impor isso;
  - `docs/instalacao.md` (DNS `pagar.`, as variáveis, `COMPOSE_PROFILES=card`) e `.env.example`.
- **Testes:** `tests/deploy-config.test.ts`, `tests/page-monitor.test.ts`

- [ ] **Passo 1: testes que falham.**
  - **`deploy-config`:**
    - o serviço `card` não tem `SECRET`, `OWNER_DATABASE_URL`, `SMTP*` nem volume;
    - tem os limites de memória e o `ulimits`;
    - o Caddy nunca manda o domínio do cartão para `app:3000`.
  - **`page-monitor`:**
    - página do iframe com script de outro host: alerta `monitor_pagina_pagamento` com `page: "/form"`;
    - página igual à esperada: sem alerta.
- [ ] **Passos 2 a 4:** rodar (FAIL), implementar e rodar (PASS). Depois rodar
  `docker compose --profile card config` com um `.env` de exemplo: deve validar sem erro.
- [ ] **Passo 5:** commit `feat(cartão): container, Caddy, monitor e docs do serviço de cartão`.

### Task 10: fechar o PR 1

- [ ] **Passo 1:** `bun run check`. Esperado: tudo verde (com `CARD_ISOLATED` desligado, o E2E atual passa sem
  mudança).
- [ ] **Passo 2:** sandbox real do Asaas: `CARD_ISOLATED=1`, app e `card:dev` locais. Fazer um pagamento à vista e um
  parcelado pelo iframe, e conferir o pedido pago e o webhook. Anotar o resultado no PR.
- [ ] **Passo 3:** `bash scripts/verify.sh`. Esperado: `VERIFY OK`. Depois, abrir o PR 1 para o `main`.

## PR 2: verificação (só `e2e/`, `scripts/verify*`, `playwright.config.ts`, `.github/`)

### Task 11: E2E e verify com o cartão isolado

**Arquivos:**
- Modificar: `e2e/smoke.spec.ts`, `scripts/verify.sh` (sobe `card:dev`/`dist/card/server.js` na etapa app-start com
  `CARD_ISOLATED=1`), `playwright.config.ts` (se precisar de um segundo `webServer`), `.github/workflows/verify.yml`
  (se precisar)

- [ ] **Passo 1:** o fluxo de cartão do E2E passa a preencher os campos dentro do iframe (`frameLocator`).
- [ ] **Passo 2:** teste novo "app principal não recebe o cartão":
  - registrar todas as requisições ao origin do app (`page.on("request")`) durante um pagamento com o cartão de teste;
  - conferir que nenhuma URL, cabeçalho ou `postData` contém o número, o CVV ou a validade;
  - conferir que `page.mainFrame()` não tem nenhum `input` de cartão.
- [ ] **Passo 3:** o smoke de deploy sobe com `COMPOSE_PROFILES=card` e paga pelo iframe.
- [ ] **Passo 4:** `bash scripts/verify.sh`, que precisa passar, e abrir o PR 2 (base: `main`, depois do merge do PR 1).

## PR 3: produto, removendo o caminho antigo

### Task 12: cartão isolado sempre

**Arquivos:**
- Remover: `src/app/api/checkout/card/route.ts` e o fluxo antigo de cartão em `checkout-form.tsx`
- Modificar:
  - `src/lib/env.ts`: `CARD_ISOLATED` some, e `CARD_ORIGIN`, `CARD_TICKET_KEY` e `ASAAS_SEAL_KEY` ficam
    obrigatórios no app;
  - `compose.yaml`: `card` sem `profiles`;
  - `src/lib/payments/asaas/card-http.ts`: só o que o serviço usa;
  - docs.
- Teste: `tests/card-bundle.test.ts` (lado do Next)

- [ ] **Passo 1: teste que falha.** Depois de `bun run build`, nenhum arquivo em `.next/server` contém
  `api/checkout/card`, `payWithCard` nem `tokenizeCreditCard|creditCard":` (corpo de cobrança).
- [ ] **Passos 2 a 4:** rodar (FAIL), remover e ajustar, rodar `bun run check` (PASS).
- [ ] **Passo 5:** `bash scripts/verify.sh`, que precisa passar, e abrir o PR 3.
