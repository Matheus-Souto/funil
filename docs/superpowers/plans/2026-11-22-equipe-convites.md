# Equipe e convites: plano de implementação

> **Para agentes:** sub-skill obrigatória: superpowers:subagent-driven-development (recomendada) ou
> superpowers:executing-plans, tarefa por tarefa. Os passos usam checkbox (`- [ ]`).

**Objetivo:** o dono convida pessoas para o painel por e-mail, com papel. Também troca o papel, remove membros e
revoga convites. A loja nunca fica sem dono, ninguém concede mais do que tem, e nada de equipe sai pelo MCP.

**Arquitetura:**
- **Tabela `team_invite`** (com `store_id` e RLS). Guarda o e-mail em claro só enquanto o convite está pendente, mais
  `email_hash`, `token_hash` (sha256), papel, validade e situação do envio.
- **Ações em `src/lib/team/`:**
  - `rules.ts`: `canGrant`, limites, lock por loja;
  - `invites.ts`: `team.invite`, `team.resendInvite`, `team.revokeInvite`, `team.inviteStatus`;
  - `accept.ts`: `team.inviteInfo` e `team.acceptInvite`, ambas públicas;
  - `members.ts`: `team.changeRole`, `team.remove`, `team.leave` e `account.stores`.

  `team.list` e `team.revokeSessions` continuam em `src/lib/auth/account.ts`. `team.list` passa a trazer os convites.
- **Envio:** o token nasce no `prepare`, a transação grava o hash, e o `afterCommit` chama `sendMail` e grava
  `send_status` e o `email_log` (`team_invite`). O token nunca sai da memória do processo.
- **Telas:** `/admin/equipe` (página nova, item da sidebar que hoje está "em breve") e `/admin/convite/[token]` (fora
  do grupo `(panel)`). A aba "equipe" de Configurações sai.

**Stack:** Next 16 (rotas em Node), Drizzle e Postgres 17 (RLS), Zod 4, nodemailer e Resend, testes em Bun.

**Spec:** `docs/superpowers/specs/2026-11-22-equipe-convites-design.md`. As perguntas P1 a P5 estão lá. Este plano
segue as recomendações. Se o dono decidir diferente, mudam só os pontos marcados com **(P1)**, **(P2)** e **(P3)**.

## O que encontrei no código e que muda o pedido

- **A sessão vale para uma loja, e o papel é relido a cada requisição** (`lookupSession` faz `inner join` com
  `membership`). Trocar papel e remover já valem no clique seguinte, sem mexer na sessão. Remover apaga as sessões
  mesmo assim, para não deixar linhas mortas.
- **No `MODE=multi`, o painel de cada loja fica no host dela** e o cookie é `__Host-`. "Trocar de loja" é um link para
  o painel da outra loja, com um login lá. Login único entre hosts fica fora (D11).
- **O token MCP não depende do papel de quem o criou** (`mcp_token.role` é escolhido na criação, por `team.manage`).
  Um dono rebaixado ou removido continuaria com um token de dono. Por isso existe o D7.
- **Já existe a aba "Equipe" em Configurações** (`team.list`, `team.revokeSessions`). A página nova reaproveita as duas
  ações e a aba sai.
- **Não há recuperação de senha.** Quem já tem conta e esqueceu a senha não consegue aceitar o convite. A spec deixa
  isso fora e a página explica o que fazer.

## Decisões

Já decidido pelo pedido: convite por e-mail pelo provedor da loja; link de uso único com validade; auditoria; nenhum
dado pessoal pelo MCP; E2E incluído. Cada linha traz a recomendação (**R**), a alternativa e o custo.

| # | Assunto | Recomendação | Alternativa | Custo da recomendação |
|---|---------|--------------|-------------|-----------------------|
| D1 | "Papel acima do próprio" | **R:** `canGrant(a, b)` = permissões de `b` ⊆ permissões de `a`. Vale para convidar, trocar (papel atual e novo) e remover | Ordem fixa owner > admin > support = traffic | Nenhum: Atendimento e Tráfego não se comparam, e o subconjunto trata isso sem caso especial |
| D2 | Dono **(P1)** | **R:** convite só para `admin`, `support` ou `traffic`. Dono só por promoção (`team.changeRole`). Um dono não rebaixa nem remove outro dono: só a si mesmo, com outro dono restando | Convite para dono; donos iguais que se removem entre si | Se um dono sumir, só o operador resolve (CLI ou banco) |
| D3 | Nunca sem dono | **R:** toda mutação de equipe (convidar, aceitar, trocar, remover, sair) pega `pg_advisory_xact_lock(hashtext('team:' \|\| store_id))` e confere o número de donos dentro da transação | Gatilho no banco | As mutações de equipe de uma loja ficam em fila (são raras). Sem gatilho: um `update` manual no banco ainda pode deixar a loja sem dono |
| D4 | Validade e uso único | **R:** 7 dias. A reivindicação `pending → accepted` acontece por `update … returning` na transação que cria o vínculo. Reenviar troca o token | 48 h | Um link vazado vale até 7 dias, mas só serve para entrar com o papel do convite e no e-mail convidado |
| D5 | Envio e falha | **R:** `afterCommit` com `sendMail`. O resultado vai para `send_status`/`send_error`/`last_sent_at` e para o `email_log` (`team_invite`, `to_hash`). Sem nova tentativa automática: o painel mostra "Não enviado" e o botão "Reenviar" | Job `team_invite_send` com o token selado no payload | Uma queda do SMTP pede um clique do dono. Em troca, o token nunca vai para o banco, nem selado |
| D6 | Loja sem e-mail **(P2)** | **R:** convidar exige `emailProviderReady`. O botão fica desabilitado com o aviso, e a ação recusa com `invalid_input` | "Copiar link" no `MODE=single` | Sem e-mail conectado, ninguém entra. O dono precisa conectar SMTP ou Resend antes |
| D7 | Tokens MCP de ex-dono | **R:** quando um dono deixa de ser dono (rebaixado, removido ou saiu), `mcp_token` com `created_by = user` nesta loja recebe `revoked_at = now()`, pelo mesmo caminho de `mcpTokens.revoke`, que cancela os pedidos pendentes. O Dialog avisa quantos tokens são | Manter os tokens | Os agentes daqueles tokens param até alguém criar outro |
| D8 | Limites | **R:** 20 pendentes, 50 membros (membros + pendentes), 30 e-mails de convite por loja em 24 h (`checkRateLimit`), reenvio a cada 2 min com no máximo 5 envios, aceite com 10 por IP e 10 por convite em 15 min, e a senha da conta que já existe também passa pelo bloqueio do login | Sem limites | Uma loja grande (mais de 50) precisa mudar a constante |
| D9 | Aceite com conta que já existe | **R:** pede a senha da conta. `verifyCredentials(email, password)` sai de `session.ts`, com o mesmo bloqueio e o mesmo tempo constante do login | Aceitar sem senha, só pelo link | Quem esqueceu a senha não aceita (não há recuperação). Sem senha, quem tivesse o link entraria na conta de outra loja |
| D10 | O que a página do link mostra | **R:** loja, papel, e-mail convidado, se já tem conta, validade. Token ruim de qualquer tipo mostra a mesma mensagem. GET não consome | Mascarar o e-mail | O link vazado revela o e-mail convidado e a loja |
| D11 | Trocar de loja | **R:** `account.stores` e "Suas lojas" no menu do usuário, só no `MODE=multi` com mais de uma loja. Cada item é um link para o `/admin` da outra loja, com login lá | Login único com bilhete assinado entre hosts | Um login por loja. Login único fica para depois |
| D12 | Onde fica a tela | **R:** página `/admin/equipe`, com o item da sidebar (seção Loja, `team.manage`) ativado. A aba "equipe" de Configurações sai, e `?aba=equipe` redireciona | Manter a aba em Configurações | Um item a mais no menu "Mais" do celular (risco do smoke 390, ver "Foco de revisão") |
| D13 | Retenção | **R:** ao aceitar, revogar ou vencer, `email` vira `null` e fica só o `email_hash`. A linha é apagada 30 dias depois pelo handler do `sweep_mcp` (`sweepInvites`). Sem job novo | Manter o histórico para sempre | Sem lista de "convites antigos" depois de 30 dias. A auditoria continua com `inviteId` e hash |
| D14 | Auditoria | **R:** projeções sem e-mail nem token (tabela 4.5 da spec). O aceite fica com ator `public`. Falha pública vai só para log | Gravar o e-mail convidado | Para saber quem foi convidado depois de 30 dias, é preciso comparar o hash |
| D15 | MCP | **R:** nada novo no catálogo. As ações novas ficam fora por `TOKEN_DENIED` (`team.manage`, `account.self`) ou por serem públicas. O teste de nomes proibidos ganha as novas | — | Nenhum |
| D16 | Admin gere a equipe? **(P3)** | **R:** não. `team.manage` continua só do dono | Uma permissão `team.invite` para o admin, limitada por `canGrant` | O dono faz todos os convites |
| D17 | Divisão em PRs | **R:** PR de produto (Tasks 1 a 8) e PR de verificação (Task 9, E2E e higiene), pela regra do repo | Um PR só | Dois ciclos de verify. O PR de verificação vai depois do de produto |

Decidido sem escolha (regra do dono, da spec ou do repo):
- **Nenhum dado pessoal sai pelo MCP.** Nenhuma ação de equipe entra no catálogo. Log e auditoria levam só ids,
  papéis e hashes. O token nunca vai para log, auditoria, resposta de ação ou `job.payload`.
- `team_invite` com `store_id` e `enable_store_rls`. O papel `card` não lê nem escreve nela.
- Rotas e server actions só chamam `runAction`. A única exceção é `createSession`/`setSessionCookie` depois do aceite,
  igual a `loginAction` e ao setup.
- Toda ação nova é classificada no catálogo do MCP (Task 7).

## Restrições globais

- **Constantes** (`TEAM` em `src/lib/team/rules.ts`): `inviteDays: 7`, `maxPending: 20`, `maxSeats: 50`,
  `invitesPerDay: 30`, `resendGapSec: 120`, `maxSends: 5`, `acceptPerIp: 10`, `acceptPerInvite: 10`,
  `acceptWindowSec: 900`, `retentionDays: 30`.
- **Token:** `inv_` + `randomToken(32)`. Guardar só `sha256(token)`. Nos testes, montar o prefixo em tempo de execução
  (nada de literal `inv_…` com formato de segredo).
- **Hash do e-mail:** `sha256(email.trim().toLowerCase())`, o mesmo do `email_log.to_hash`.
- **Log:** nunca e-mail, token nem URL do convite. Só `inviteId`, `storeId` e motivo.
- **Testes:** nada de skip, only, retry ou espera fixa. O relógio é injetado ou as datas mudam no banco.
- **Escopo do PR de produto:** não edita `e2e/`, `scripts/verify*`, `.github/`, `.claude/` nem `REVIEW.md`.
- **Processo:** `bun run check` antes de cada commit. `bash scripts/verify.sh` (≈8 a 13 min, em segundo plano, sem
  interromper) antes do PR. Implementadores não usam `git stash`.

## Foco de revisão

1. **Tomar a loja:** um admin ou um token criando dono; um dono tirando outro (P1); um link reusado ou de outra loja;
   aceitar sem a senha da conta que já existe. Testes nas Tasks 3, 4 e 5.
2. **Loja sem dono:** dois donos se rebaixando ao mesmo tempo; o último dono saindo. Teste concorrente na Task 5.
3. **Spam pelo e-mail da loja:** convites e reenvios em massa. Testes na Task 3.
4. **Dado pessoal saindo:** e-mail ou token em `log`, `audit_log`, resposta de ação, MCP ou URL fora do link do
   e-mail. Testes nas Tasks 3, 4 e 7.
5. **Acesso que sobra:** sessão ou token MCP de quem saiu. Testes na Task 5.
6. **Smoke `painel 390`:** um item a mais no "Mais". Rode o E2E existente na Task 8. Se quebrar, pare e pergunte: a
   correção do E2E não pode ir no PR de produto.

---

### Task 1: tabela `team_invite` e o kind `team_invite` no `email_log`

**Files:**
- Create: `src/lib/db/schema/team.ts` (exportado em `src/lib/db/schema/index.ts`) e `drizzle/0036_team_invite.sql`
  (via `bun run migration --name team_invite`; acrescentar à mão `select enable_store_rls('team_invite');`)
- Modify: `src/lib/db/schema/delivery.ts` (check do `email_log.kind`), `src/lib/delivery/email-log.ts` (`EmailKind`)
- Test: `tests/team.test.ts` (novo), `tests/card-role.test.ts`, `tests/rls.test.ts`/`tests/migrate.test.ts` (se listam
  tabelas)

**Interfaces:**
- Produces:
  - `team_invite`:
    - `id uuid pk`;
    - `store_id → store (cascade)`;
    - `email text` (nulo depois do estado final);
    - `email_hash text not null`;
    - `role text not null` (check `admin | support | traffic`, **(P1)**: sem `owner`);
    - `token_hash text not null unique`;
    - `invited_by uuid → users (set null)`;
    - `status text not null default 'pending'` (check `pending | accepted | revoked | expired`);
    - `send_status text` (check `sent | failed`), `send_error text`, `send_count int not null default 0`,
      `last_sent_at timestamptz`;
    - `expires_at timestamptz not null`, `accepted_by uuid → users (set null)`, `accepted_at`, `ended_at`
      (aceito, revogado ou vencido), `created_at`.

    Restrições:
    - único parcial `(store_id, email_hash) where status = 'pending'`;
    - check `(status = 'pending') = (email is not null)`;
    - índices `(store_id, status, created_at desc)` e `(ended_at)`.
  - `EmailKind` ganha `"team_invite"` e o check do `email_log.kind` também.

- [ ] **Step 1: testes que falham:**
  - `tests/team.test.ts`:
    - `RLS: convite de outra loja não aparece`;
    - `segundo convite pendente para o mesmo e-mail na loja recusado (único)`;
    - `pendente sem e-mail recusado; aceito com e-mail recusado`;
    - `role owner recusado pelo check`.
  - `tests/card-role.test.ts`: o papel `card` não lê `team_invite`.
- [ ] **Step 2:** `bun test tests/team.test.ts tests/card-role.test.ts` → FAIL.
- [ ] **Step 3: implementar** (schema, migração, `EmailKind`).
- [ ] **Step 4:** os do Step 2 + `tests/migrate.test.ts tests/rls.test.ts tests/delivery.test.ts` → PASS.
- [ ] **Step 5:** `bun run check` e commit `feat(equipe): tabela team_invite`.

### Task 2: regras (`canGrant`, limites, lock e donos)

**Files:**
- Create: `src/lib/team/rules.ts`
- Test: `tests/team-rules.test.ts` (novo)

**Interfaces:**
- Produces:
  - `TEAM` (constantes da seção "Restrições globais");
  - `INVITE_ROLES = ["admin", "support", "traffic"] as const` **(P1)**;
  - `canGrant(actor: Role, target: Role): boolean` (D1);
  - `lockTeam(tx: Tx, storeId: string): Promise<void>` (advisory lock da transação, D3);
  - `ownerCount(tx, storeId): Promise<number>`;
  - `seatsUsed(tx, storeId): Promise<number>` (membros + convites `pending` no prazo);
  - `revokeTokensCreatedBy(tx, storeId, userId): Promise<number>` (reaproveita a lógica de `mcpTokens.revoke`
    extraída para uma função, inclusive o cancelamento dos pedidos pendentes);
  - `inviteTokenHash(token: string): string`.

- [ ] **Step 1: testes que falham:**
  - `canGrant` para os 16 pares (owner concede tudo; admin concede support e traffic e não concede owner nem admin
    sem `team.manage`; support e traffic não concedem um ao outro);
  - `revokeTokensCreatedBy` revoga só os tokens daquele usuário naquela loja e cancela os pedidos pendentes deles;
  - `seatsUsed` não conta convite vencido.
- [ ] **Step 2:** `bun test tests/team-rules.test.ts` → FAIL.
- [ ] **Step 3: implementar** e trocar `mcpTokens.revoke` para usar a função extraída, sem mudar o comportamento
  (`tests/mcp-tokens.test.ts` continua verde).
- [ ] **Step 4:** `bun test tests/team-rules.test.ts tests/mcp-tokens.test.ts tests/approvals.test.ts` → PASS.
- [ ] **Step 5:** `bun run check` e commit `feat(equipe): regras de papel, limites e lock por loja`.

### Task 3: convidar, reenviar, revogar e o e-mail

**Files:**
- Create: `src/lib/team/invites.ts`
- Modify: `src/lib/delivery/templates.ts` (`teamInviteEmail`), `src/lib/auth/account.ts` (`team.list` com convites),
  `src/lib/actions/all.ts`
- Test: `tests/team.test.ts`, `tests/team-templates.test.ts` (novo)

**Interfaces:**
- Consumes: Tasks 1 e 2, `sendMail`, `emailProviderReady`, `checkRateLimit`, `writeEmailLog` (ou equivalente de
  `email-log.ts`).
- Produces:
  - `team.invite`: input `{ email: string; role: (typeof INVITE_ROLES)[number] }`, permission `team.manage`, não
    sensível (um token nunca chega aqui). Saída `{ inviteId }`. `auditInput: { role, emailHash }`. Ordem das
    conferências:
    1. permissão;
    2. `canGrant`;
    3. no `prepare`: e-mail conectado (`invalid_input` "Para convidar alguém, conecte o e-mail da loja em Conexões",
       caminho `["email"]`), `checkRateLimit("team:invite:<storeId>", 30, 86400)` e o token gerado;
    4. no `run` (com `lockTeam`): antes de tudo, marca como `expired` (com `email = null`) os `pending` vencidos
       desta loja, para o índice único não barrar um convite novo para o mesmo e-mail; já é membro (`conflict` "Essa pessoa já faz parte da equipe"), pendente
       (`conflict` "Já existe um convite para esse e-mail. Use Reenviar"), `maxPending` e `maxSeats` (`conflict`
       com o número), grava a linha;
    5. no `afterCommit`: `sendMail`, depois `send_status`, `send_error` curto, `send_count + 1`, `last_sent_at` e
       `email_log`.
  - `team.resendInvite {inviteId}`: só `pending` e no prazo (vencido → `conflict` "Este convite venceu. Convide de
    novo"; o convite vencido não guarda mais o e-mail), `send_count < 5`, `last_sent_at` com mais de 2 min, conta no mesmo limite diário. Gera o token novo no `prepare`
    e troca `token_hash` e `expires_at`.
  - `team.revokeInvite {inviteId}`: `pending → revoked`, `email = null`, `ended_at = now()`.
  - `team.inviteStatus {inviteId}` (`audit: false`): `{ sendStatus, sendError }` para a server action dar a mensagem
    certa depois do `afterCommit`.
  - `team.list` passa a devolver `{ members, invites: { id, email, role, expiresAt, sendStatus, sendError, lastSentAt }[] }`
    (só os `pending`). Os convites com prazo vencido viram `expired` (e `email = null`) na leitura, sob o lock.
  - `teamInviteEmail(d: { storeName; brandColor; inviterName; roleLabel; acceptUrl; expiresAt }): { subject; html; text }`
    com os textos da spec (seção 5). `acceptUrl = <origem do painel da loja>/admin/convite/<token>`, usando o mesmo
    cálculo de origem do link de entrega.

- [ ] **Step 1: testes que falham:**
  - `tests/team-templates.test.ts`:
    - assunto, corpo e botão exatos;
    - nome do convidante com `<script>` sai escapado;
    - `\n` sai numa linha no texto;
    - validade em horário de São Paulo;
    - `href` do `acceptUrl`.
  - `tests/team.test.ts` (SMTP falso):
    - convite chega com o link, e o token do link bate com o `token_hash`;
    - a saída da ação, o `audit_log` e o `log` não contêm o e-mail nem o token;
    - `email_log` com `team_invite` e `to_hash`;
    - sem e-mail conectado: `invalid_input`;
    - membro, pendente, 21º pendente, 51º assento e 31º envio do dia são recusados;
    - SMTP fora: `send_status = failed`, `inviteStatus` devolve o motivo e "Reenviar" depois de 2 min envia;
    - reenviar antes de 2 min dá `rate_limited`;
    - reenviar mata o link antigo (o hash antigo some);
    - revogar apaga o e-mail;
    - `role: "owner"` dá `invalid_input` **(P1)**;
    - papel `admin` chamando: `forbidden`;
    - token MCP chamando: `forbidden`.
- [ ] **Step 2:** `bun test tests/team.test.ts tests/team-templates.test.ts` → FAIL.
- [ ] **Step 3: implementar.**
- [ ] **Step 4:** os mesmos + `tests/account.test.ts tests/mcp-tools.test.ts` → PASS.
- [ ] **Step 5:** `bun run check` e commit `feat(equipe): convite por e-mail, reenvio e revogação`.

### Task 4: aceitar o convite

**Files:**
- Create: `src/lib/team/accept.ts`
- Modify: `src/lib/auth/session.ts` (extrair `verifyCredentials` de `login`, sem mudar o comportamento do login),
  `src/lib/actions/all.ts`
- Test: `tests/team-accept.test.ts` (novo), `tests/auth.test.ts`

**Interfaces:**
- Consumes: Tasks 1 a 3, `hashPassword`, `checkRateLimit`.
- Produces:
  - `verifyCredentials(email: string, password: string): Promise<{ userId: string } | null>`: o mesmo bloqueio de 5
    tentativas em 15 min por e-mail e o mesmo hash de mentira. `login` passa a usar essa função.
  - `team.inviteInfo` (`permission: "public"`, `audit: false`): input `{ token }`; saída
    `{ storeName, roleLabel, email, hasAccount, expiresAt } | null`. Sempre `null` para token inválido de qualquer
    tipo.
  - `team.acceptInvite` (`permission: "public"`): input
    `{ token; mode: "new"; name; password } | { token; mode: "existing"; password }`, chamada com `ip` em
    `call.server`.
    - `prepare`: limites por IP e por convite (`rate_limited`); acha o convite pelo hash (fora de transação, só para
      decidir o caminho); `mode: "existing"` → `verifyCredentials` (`forbidden` "Senha incorreta"); `mode: "new"` →
      `hashPassword`.
    - `run` (com `lockTeam`):
      1. reivindica `pending → accepted` no prazo (senão `not_found` "Este convite não vale mais");
      2. `mode: "new"` com conta criada nesse meio-tempo → `conflict` com `details.hasAccount = true`;
      3. confere `maxSeats`;
      4. cria `users` (se novo, `mustChangePassword: false`) e `membership`. Se a pessoa já é membro, não duplica;
      5. grava `email = null`, `accepted_by`, `accepted_at` e `ended_at`.
    - Saída `{ userId, storeId, role, newAccount }`. `auditInput: { inviteId }`, `auditResult: { userId, role, newAccount }`.

- [ ] **Step 1: testes que falham** (`tests/team-accept.test.ts`):
  - conta nova: cria usuário, vínculo com o papel, convite `accepted` sem e-mail;
  - conta que já existe com a senha certa: só o vínculo;
  - senha errada: `forbidden`, e a 6ª tentativa bloqueia como o login;
  - mesmo token duas vezes: o segundo dá `not_found`;
  - dois aceites em paralelo: um passa e o outro dá `not_found`;
  - vencido, revogado, inventado, token de outra loja: `inviteInfo` devolve `null` e o aceite dá `not_found`;
  - 11 tentativas do mesmo IP: `rate_limited`;
  - loja com 50 assentos ocupados: `conflict`;
  - nada de token ou e-mail em `log` nem `audit_log`;
  - `inviteInfo` não diz em que outras lojas a conta está.
  - `tests/auth.test.ts`: o login continua com o mesmo bloqueio depois da extração.
- [ ] **Step 2:** `bun test tests/team-accept.test.ts tests/auth.test.ts` → FAIL.
- [ ] **Step 3: implementar.**
- [ ] **Step 4:** os mesmos + `tests/panel-auth.test.ts` → PASS.
- [ ] **Step 5:** `bun run check` e commit `feat(equipe): aceite do convite com conta nova ou existente`.

### Task 5: trocar papel, remover e sair

**Files:**
- Create: `src/lib/team/members.ts`
- Modify: `src/lib/actions/all.ts`
- Test: `tests/team-members.test.ts` (novo)

**Interfaces:**
- Consumes: Task 2.
- Produces (todas com `lockTeam`):
  - `team.changeRole {userId, role}`: `team.manage`, `sensitive: true`.
    - `canGrant(ator, atual)` e `canGrant(ator, novo)`;
    - alvo dono que não seja o próprio ator: `forbidden` "Um dono não muda o papel de outro dono" **(P1)**;
    - rebaixar a si mesmo só com outro dono restando: `conflict` "A loja precisa de pelo menos um dono";
    - se o alvo deixa de ser dono: `revokeTokensCreatedBy`;
    - saída `{ tokensRevoked }`; `auditInput: { userId, from, to }`.
  - `team.remove {userId}`: `team.manage`, `sensitive: true`.
    - não remove a si mesmo (`conflict` "Use Sair da loja");
    - alvo dono: `forbidden` **(P1)**;
    - apaga `membership` e as `session` da pessoa nesta loja e chama `revokeTokensCreatedBy`;
    - saída `{ sessionsEnded, tokensRevoked }`.
  - `team.leave {}`: `account.self`, `sensitive: true` (um token nunca chega: `TOKEN_DENIED`).
    - dono só sai com outro dono restando;
    - apaga o vínculo, as sessões desta loja e (se dono) os tokens que criou.
  - `account.stores {}`: `account.self`, `audit: false`. Devolve `{ storeId, name, panelUrl, current }[]` só das lojas
    da própria pessoa. `panelUrl` usa `store.domain` ou `<slug>.PLATFORM_DOMAIN`. No `MODE=single`, devolve só a
    atual.
  - `team.list.members[*]` ganha `tokensCreated: number` (para o Dialog avisar quantos tokens vão ser revogados).

- [ ] **Step 1: testes que falham** (`tests/team-members.test.ts`):
  - dono promove admin a dono;
  - dono tenta rebaixar ou remover outro dono: `forbidden`;
  - único dono se rebaixa: `conflict`;
  - dois donos se rebaixam em paralelo: um passa e o outro dá `conflict`, e sobra um dono;
  - rebaixar a si mesmo com outro dono restando revoga os tokens que criou e cancela os pedidos pendentes deles;
  - remover apaga só as sessões desta loja (a sessão da pessoa em outra loja continua) e a sessão removida não abre
    mais em `lookupSession`;
  - trocar papel não apaga a sessão, e `lookupSession` devolve o papel novo;
  - `team.leave` de um suporte;
  - `team.leave` do único dono: `conflict`;
  - `account.stores` não lista loja sem vínculo;
  - pelo MCP (ator token, qualquer papel): todas `forbidden`.
- [ ] **Step 2:** `bun test tests/team-members.test.ts` → FAIL.
- [ ] **Step 3: implementar.**
- [ ] **Step 4:** os mesmos + `tests/account.test.ts tests/mcp-tokens.test.ts` → PASS.
- [ ] **Step 5:** `bun run check` e commit `feat(equipe): trocar papel, remover, sair e lojas da conta`.

### Task 6: retenção dos convites

**Files:**
- Modify: `src/lib/team/invites.ts` (`sweepInvites`), handler do `sweep_mcp` em `src/lib/jobs/handlers.ts`
- Test: `tests/team.test.ts`

**Interfaces:**
- Produces:
  - `sweepInvites(storeId, now)`: `pending` vencido → `expired` com `email = null`; apaga linhas com
    `ended_at < now - 30 d`.
  - O `sweep_mcp` chama `sweepInvites` por loja (padrão "um teste por loja", para não ficar O(n²) no arquivo de testes).

- [ ] **Step 1: teste que falha:**
  - convite vencido vira `expired` sem e-mail;
  - convite encerrado há 31 dias some;
  - convite encerrado há 29 dias fica.
- [ ] **Step 2:** `bun test tests/team.test.ts` → FAIL.
- [ ] **Step 3: implementar.**
- [ ] **Step 4:** `bun test tests/team.test.ts tests/jobs.test.ts tests/approvals.test.ts` → PASS.
- [ ] **Step 5:** `bun run check` e commit `feat(equipe): limpeza dos convites encerrados`.

### Task 7: catálogo do MCP

**Files:**
- Test: `tests/mcp-tools.test.ts`, `tests/mcp-matrix.test.ts`

- [ ] **Step 1: testes** (devem passar sem mudar `src/lib/mcp/tools.ts`; se algum falhar, a ação foi classificada
  errado e a correção é na ação):
  - a lista de nomes que nunca aparecem (linha ~157) ganha `team.invite`, `team.resendInvite`, `team.revokeInvite`,
    `team.inviteStatus`, `team.changeRole`, `team.remove`, `team.leave`, `team.inviteInfo`, `team.acceptInvite` e
    `account.stores`, para todos os papéis;
  - `MCP_EXCLUDED` continua igual;
  - em `mcp-matrix`: um token `owner` chamando `team_invite` pelo endpoint recebe "ferramenta indisponível", e nenhuma
    resposta de ferramenta, em nenhum papel, contém o e-mail de um membro ou de um convite criados no teste.
- [ ] **Step 2:** `bun test tests/mcp-tools.test.ts tests/mcp-matrix.test.ts` → PASS.
- [ ] **Step 3:** commit `test(equipe): ações de equipe fora do MCP`.

### Task 8: telas, sidebar e documentação

**Files:**
- Create:
  - `src/app/admin/(panel)/equipe/page.tsx` e `equipe/team-panel.tsx` (`"use client"`; move o que serve de
    `settings/team.tsx`);
  - `src/app/admin/convite/[token]/page.tsx` e `convite/[token]/accept-form.tsx`.
- Modify:
  - `src/app/admin/(panel)/actions.ts` (server actions `inviteAction`, `resendInviteAction`, `revokeInviteAction`,
    `changeRoleAction`, `removeMemberAction`, `leaveStoreAction`);
  - `src/app/admin/actions.ts` (`acceptInviteAction`: `runAction` e depois `destroySession`, `createSession` e
    `setSessionCookie`);
  - `src/app/admin/(panel)/layout.tsx` (item `{ href: "/admin/equipe", label: "Equipe", icon: "users", section: "loja" }`
    com `team.manage`);
  - `src/app/admin/(panel)/sidebar.tsx` (tira o item "em breve" e põe "Suas lojas" no rodapé quando `account.stores`
    tem mais de uma);
  - `settings/tabs.ts`, `settings/form.tsx` e `settings/page.tsx` (tira a aba; `?aba=equipe` redireciona para
    `/admin/equipe`); apagar `settings/team.tsx`;
  - cabeçalhos da rota `/admin/convite/` (`Referrer-Policy: no-referrer`, `Cache-Control: no-store`) onde ficam os
    outros por rota;
  - `docs/instalacao.md` (seção "Equipe e convites": exige o e-mail da loja, validade, papéis, como transferir a loja,
    o caminho que não pode ir para o log do proxy);
  - `docs/painel-pendencias.md` (tira "Equipe em breve").
- Test: `tests/panel-actions.test.ts`, `tests/panel-auth.test.ts`, `tests/next-config-headers.test.ts`

**Interfaces:**
- Consumes: Tasks 3 a 5.
- Produces:
  - as telas da seção 10 da spec;
  - textos: "Convidar pessoa", "Convite enviado para {e-mail}", "Convite criado, mas o e-mail não saiu: {motivo}.
    Confira Conexões e clique em Reenviar.", "Trocar papel", "Remover da equipe", "Deixar de ser dono",
    "Sair da loja", "Este convite não vale mais. Peça um novo a quem convidou você.", "Esqueceu a senha? Fale com quem
    convidou você.";
  - a descrição de cada papel no Dialog (tabela 3 da spec).

- [ ] **Step 1: testes que falham:**
  - `panel-auth`:
    - `/admin/equipe` dá `notFound` para admin, suporte e tráfego;
    - `/admin/convite/x` abre sem sessão;
    - `?aba=equipe` redireciona.
  - `next-config-headers`: `/admin/convite/abc` com `no-referrer` e `no-store`.
  - `panel-actions`:
    - `inviteAction` devolve a mensagem de enviado ou de falha conforme `inviteStatus`;
    - `acceptInviteAction` grava o cookie e apaga a sessão anterior.
- [ ] **Step 2:** `bun test tests/panel-actions.test.ts tests/panel-auth.test.ts tests/next-config-headers.test.ts` → FAIL.
- [ ] **Step 3: implementar** seguindo `docs/padrao-de-paginas.md`. Conferir as telas nos dois temas e no celular
  (390).
- [ ] **Step 4:** os mesmos → PASS, `bun run build` sem erro e `bunx playwright test` (o E2E de hoje, sem editar)
  verde, inclusive `painel 390`. Se quebrar por causa do item novo no "Mais", pare e pergunte ao dono (D17).
- [ ] **Step 5:** `bun run check` e commit `feat(equipe): página Equipe, aceite do convite e documentação`.

### Task 9 (PR de verificação, depois do merge do de produto): E2E e higiene

**Files:**
- Modify: `e2e/smoke.spec.ts` e, se a higiene listar prefixos de segredo, o arquivo dela em `scripts/verify*` ou
  `tests/verify/` (prefixo `inv_`)

- [ ] **Step 1:** teste `painel: equipe e convites`:
  1. o dono abre Equipe e convida `support` (e-mail único do teste);
  2. o Mailpit recebe "{dono} convidou você para a equipe da {loja}", e o link sai do texto;
  3. num contexto novo, o convidado abre o link, cria a conta e cai em `/admin/orders` sem o link "Conexões";
  4. o mesmo link aberto de novo mostra "Este convite não vale mais";
  5. o dono troca o papel para `traffic` e, no clique seguinte, o membro vê o Dashboard;
  6. o dono remove o membro e o próximo clique dele leva a `/admin/login`;
  7. um segundo convite revogado mostra "não vale mais";
  8. no celular (390), "Equipe" aparece no menu "Mais".
- [ ] **Step 2:** acrescentar `inv_` à higiene (se ela listar prefixos) com um teste da própria higiene.
- [ ] **Step 3:** `bash scripts/verify.sh` em segundo plano → verde. Commit `test(e2e): equipe e convites`.

## Fora deste plano

Verificação em duas etapas (2FA) e reconfirmação de senha; recuperação de senha; login único entre lojas (D11);
apagar a conta global; papel "Editor de catálogo" (P4); tela de histórico da equipe; avisos no Telegram ou por e-mail
de aceite e remoção; convite pela CLI; admin gerindo a equipe (P3/D16).
