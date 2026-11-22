# Equipe e convites: design

Data: 2026-11-22
Origem: item "Equipe e convites" da fase 2 da spec do MVP
(`docs/superpowers/specs/2026-11-18-plataforma-funil-mvp-design.md`, seções 7.2, 7.3, 7.9 e 10). É o único item da
fase 2 que ainda não foi feito: o MCP e a fila de aprovações já entraram nos PRs #12 e #13.
Plano: `docs/superpowers/plans/2026-11-22-equipe-convites.md`.

## 1. Intenção

Hoje só existe um jeito de pôr alguém no painel: a rota de teste do E2E ou o banco. O dono da loja precisa convidar
outras pessoas (sócio, atendimento, gestor de tráfego), cada uma com um papel. Também precisa trocar o papel de alguém,
tirar a pessoa da loja e cancelar um convite. Tudo isso sem abrir brecha para:
- tomar a loja;
- deixar a loja sem dono;
- usar o e-mail da loja para mandar spam;
- vazar dado pessoal pelo MCP.

## 2. O que já existe (e não muda)

- `users`, `membership(user_id, store_id, role)` e `session` são tabelas **globais**, sem RLS. Toda consulta filtra pela
  loja do ator. A conta (`users`) é uma só para a plataforma inteira, e a senha também. O vínculo com cada loja fica em
  `membership`.
- A sessão vale para **uma** loja (`session.store_id`). `lookupSession` lê o papel de `membership` a cada requisição,
  então uma troca de papel ou uma remoção vale já na requisição seguinte. A sessão de quem foi removido deixa de abrir
  porque o `inner join` com `membership` não acha mais nada.
- No `MODE=multi`, o painel de cada loja fica no host da loja (`store.domain` ou `<slug>.PLATFORM_DOMAIN`). O login
  resolve a loja pelo host (`resolveStore`) e o cookie é `__Host-`, ou seja, preso a esse host.
- Papéis e permissões ficam em `src/lib/actions/permissions.ts`. `team.manage` é só do dono e está em `TOKEN_DENIED`:
  nenhum token MCP chega a ações de equipe.
- O que já existe de equipe: `team.list` e `team.revokeSessions` (aba "Equipe" em Configurações, `settings/team.tsx`),
  e `account.changePassword`, que derruba as sessões do usuário em todas as lojas.
- O e-mail da loja sai por `sendMail` (SMTP ou Resend da própria loja). `emailProviderReady` diz se o provedor ativo
  tem conexão salva.

## 3. Papéis

| Papel | Rótulo | Pode | Não pode |
|---|---|---|---|
| `owner` | Dono | Tudo, inclusive equipe, tokens MCP e conexões de pagamento | — |
| `admin` | Administrador | Tudo, menos equipe (`team.manage`) e conexões (`connections.write`) | Convidar, trocar papel, remover, tokens MCP |
| `support` | Atendimento | Pedidos (ver e reenviar), contatos, catálogo só leitura, aprovar pela fila | Métricas, reembolso, liberar Pix, exportar, conexões |
| `traffic` | Tráfego | Métricas, relatório de vendas sem comprador, Pixel das ofertas, catálogo só leitura | Pedidos com dados do comprador, contatos, conexões |
| `reader` | Leitor | **Só token MCP.** O `membership_role_check` não aceita esse papel para uma pessoa | — |

**Falta algum papel?** Para o MVP, não. Um candidato óbvio é um "Editor de catálogo" (produtos e ofertas, sem pedidos
nem dado de comprador), para quem só faz copy ou página. Hoje esse trabalho exige `admin`, que vê os pedidos. Fica
como pergunta ao dono (P4). Como os papéis são conjuntos de permissões, entrar depois custa uma linha em
`ROLE_PERMISSIONS`, o check do banco e o rótulo.

**Quem gere a equipe:** só quem tem `team.manage`, hoje só o dono. Ver P3 (o admin convidar Atendimento e Tráfego).

## 4. Regras de segurança

### 4.1 Ninguém concede um papel acima do próprio
"Acima" aqui quer dizer "com alguma permissão que eu não tenho". A regra fica numa função só:

`canGrant(actorRole, targetRole) = ROLE_PERMISSIONS[targetRole] ⊆ ROLE_PERMISSIONS[actorRole]`

Ela vale ao convidar, ao trocar papel (o papel atual da pessoa **e** o novo precisam caber no de quem troca) e ao
remover (o papel da pessoa precisa caber). Hoje só o dono gere a equipe, então a regra quase não bloqueia nada. Ela
existe para que dar `team.manage` a outro papel no futuro (P3) não abra uma escalada: um admin nunca conseguiria criar
um dono.

### 4.2 Dono
- **A loja nunca fica sem dono.** Toda mutação de equipe roda com `pg_advisory_xact_lock` por loja e confere, dentro
  da transação, que sobra pelo menos um `owner`. Isso vale para rebaixar, remover e sair. Duas pessoas rebaixando ao
  mesmo tempo os dois únicos donos: a segunda espera a primeira e recebe `conflict`.
- **Recomendação (P1):**
  - um convite nunca é para dono;
  - alguém vira dono por **promoção** de um membro que já aceitou o convite;
  - um dono **não rebaixa nem remove outro dono**: só a si mesmo, e só se outro dono continuar na loja.

  Isso impede que um sócio expulse o outro, ou que uma sessão roubada promova um cúmplice e depois tire o dono
  original. Transferir a loja fica assim: promover B a dono, depois "Deixar de ser dono" (ou "Sair da loja"). Se um
  dono sumir, o operador da instalação resolve pela CLI.
- **Senha para dar muito poder** (decidido pelo dono depois do PR #22). Promover alguém a Dono ou a Administrador, e
  convidar como Administrador, pede a senha de quem dá o papel. Sem isso, uma sessão roubada bastaria para convidar um
  cúmplice como Administrador e promovê-lo a dono, que nenhum outro dono consegue remover. A senha é conferida fora da
  transação e conta no mesmo limite da troca de senha (5 tentativas por usuário em 15 minutos); nunca vai para a
  auditoria. Rebaixar (inclusive deixar de ser dono) e trocar entre Atendimento e Tráfego não pedem senha.
- **Tokens MCP de quem deixa de ser dono.** Só o dono cria tokens, e o token pode ter papel `owner`. Quando um dono é
  rebaixado, sai ou é removido, os tokens que ele criou **nesta loja** são revogados
  (`mcp_token.created_by = user`), e também os convites pendentes que ele mandou aqui (`team_invite.invited_by = user`). A revogação já cancela os pedidos pendentes desses tokens na fila. Custo: o agente
  que usava esses tokens para de funcionar até alguém criar outro. Sem isso, um dono afastado continuaria com acesso de
  dono pelo MCP.

### 4.3 Limites (constantes em `src/lib/team/rules.ts`)
| Limite | Valor | Por quê |
|---|---|---|
| Validade do convite | 7 dias | Tempo para a pessoa ver o e-mail. Depois disso, "Reenviar" |
| Convites pendentes por loja | 20 | Contam também os que falharam no envio |
| Membros por loja | 50 | Membros mais pendentes não passam de 50 |
| E-mails de convite por loja | 30 a cada 24 h (envios e reenvios) | O e-mail da loja não vira canal de spam |
| Reenvio do mesmo convite | 1 a cada 2 min, no máximo 5 envios | Evita martelar a caixa de alguém |
| Tentativas no aceite | 10 por IP a cada 15 min e 10 por convite | Senha errada da conta que já existe também conta no bloqueio do login (5 por e-mail em 15 min) |

### 4.4 Link de convite
- Token aleatório `inv_` + 32 bytes em base64url. No banco fica **só o sha256**. O token aparece uma única vez, no
  e-mail. Nunca vai para o painel, para a resposta de uma ação, para log, para auditoria ou para `job.payload`.
- **Uso único:** o aceite reivindica a linha (`pending → accepted`) com `update … where status='pending' and
  expires_at > now() returning`, na mesma transação que cria o vínculo. Dois cliques ao mesmo tempo: só um passa.
- "Reenviar" gera um token novo e o link antigo morre na hora. "Revogar" mata o link.
- Abrir o link (GET) **não consome nada**. Leitores de link e antivírus abrem por GET, e só o POST do formulário aceita.
- Token de outra loja, inventado, vencido, revogado ou já usado mostram a **mesma** mensagem. Assim a página não
  responde se um token existe.
- A página do convite manda `Referrer-Policy: no-referrer` e `Cache-Control: no-store`. `/admin/convite/` entra na
  lista de caminhos que o proxy e a CDN não podem registrar, ao lado de `/sair/` e `/api/mcp/upload/`.

### 4.5 Auditoria (`audit_log`)
Todas as ações novas são auditadas pelo `runAction`. A entrada auditada é uma projeção (`auditInput`/`auditResult`),
sem e-mail nem token:

| Ação | Gravado |
|---|---|
| `team.invite` | `role`, `emailHash`; resultado `inviteId` |
| `team.resendInvite` / `team.revokeInvite` | `inviteId` |
| `team.acceptInvite` | `inviteId`; resultado `userId`, `role`, `newAccount` (ator `public`, origem `public`) |
| `team.changeRole` | `userId`, `from`, `to`; resultado `tokensRevoked` |
| `team.remove` / `team.leave` | `userId`, `role`; resultado `sessionsEnded`, `tokensRevoked` |

Falha de ator público (aceite com token ruim) não vai para o `audit_log`, como as demais ações públicas: fica só o
código em log. Assim um robô não enche a tabela.

## 5. Convite por e-mail

- **Quem convida:** quem tem `team.manage`. Informa o e-mail e o papel (Administrador, Atendimento ou Tráfego). O
  e-mail é normalizado (`trim`, minúsculas, `z.email`, até 254 caracteres).
- **Recusado com mensagem clara:**
  - já é membro: "Essa pessoa já faz parte da equipe";
  - já há convite pendente para esse e-mail: "Já existe um convite para esse e-mail. Use Reenviar";
  - passou de um limite da seção 4.3;
  - papel fora de `canGrant`.
- **Envio:**
  - o token é gerado no `prepare`;
  - a transação grava o convite;
  - o e-mail sai no `afterCommit`, pelo `sendMail` da loja, fora da transação;
  - o resultado fica no convite (`send_status = sent | failed`, `last_sent_at`, motivo curto) e no `email_log`, com
    kind novo `team_invite` e destinatário só em sha256.

  O token vive só na memória do processo durante o envio. Se o envio falhar, o convite aparece como "Não enviado", com
  "Reenviar". Não há nova tentativa automática, porque um job precisaria guardar o token.
- **Texto (fixo, escapado no HTML, `oneLine` no texto):**
  - assunto: `{convidante} convidou você para a equipe da {loja}`;
  - corpo: "{convidante} convidou você para ajudar na {loja} como {papel}. O convite vale até {data e hora de São
    Paulo}.";
  - botão: "Aceitar convite";
  - rodapé: "Se você não esperava este convite, ignore este e-mail. Ninguém entra na loja sem abrir este link."
- **Loja sem e-mail conectado:** o botão "Convidar" fica desabilitado, com o aviso "Para convidar alguém, conecte o
  e-mail da loja em Conexões" e um link para lá. A ação recusa com `invalid_input` (mesma mensagem). **Recomendação
  (P2): sem plano B por link copiado.** Mostrar o link ao dono deixaria ele aceitar no lugar do convidado e criar uma
  conta global com o e-mail de outra pessoa. No `MODE=multi`, isso trava aquele e-mail em todas as lojas. Alternativa
  para o dono decidir: "Copiar link" só no `MODE=single`, onde o dono já é o operador da instalação.

## 6. Aceitar o convite

Página `/admin/convite/<token>`, fora do grupo `(panel)` (como `/admin/login`), no host da loja que convidou.

- **GET:** a ação pública `team.inviteInfo` devolve só o nome da loja, o papel, o e-mail convidado, se esse e-mail já
  tem conta e a validade. Com token inválido, mostra "Este convite não vale mais. Peça um novo a quem convidou você."
  O e-mail aparece inteiro porque é a conta que vai ser usada, e quem tem o link é o dono da caixa (o link só chega por
  esse e-mail).
- **Sem conta com esse e-mail:** formulário com nome (1 a 100), senha (10 a 256) e confirmação. O POST cria a conta
  com **aquele** e-mail (não dá para trocar no aceite), o vínculo com o papel do convite e uma sessão nesta loja, e
  leva ao painel. Abrir o link no e-mail já prova que a pessoa controla a caixa. Por isso a conta nasce sem senha
  temporária.
- **Com conta:** "Você já tem conta na plataforma. Entre com a sua senha para aceitar." O POST confere a senha pelo
  mesmo caminho do login (bloqueio por e-mail e tempo constante), cria o vínculo e a sessão. A página não diz em que
  outras lojas a pessoa está.
- **Esqueceu a senha:** não há recuperação de senha na plataforma (fora do escopo, seção 11). A página diz "Esqueceu a
  senha? Fale com quem convidou você."
- **Já logado como outra pessoa neste host:** o aceite troca o cookie. A sessão antiga é apagada e a nova pertence a
  quem aceitou.
- **Corridas:** se uma conta com o mesmo e-mail nasceu entre o GET e o POST, o aceite recusa e a página recarrega no
  modo "Com conta". Se a pessoa virou membro por outro caminho, o convite é marcado como aceito sem duplicar o
  vínculo. Os limites de membros são conferidos de novo sob o lock da loja.
- **Depois do aceite:** o convite guarda só o `email_hash`, e o e-mail em claro é apagado (o mesmo vale ao revogar e
  ao vencer). A linha some 30 dias depois do estado final, apagada pela varredura `sweep_mcp`, que já roda.
- **Criar a sessão:** a server action chama `runAction(acceptInvite)` e depois `createSession` + `setSessionCookie`,
  exatamente como `loginAction` e o setup já fazem. A regra de negócio fica toda na ação.

## 7. Gerir a equipe

| Ação | Permissão | Regras |
|---|---|---|
| `team.list` (amplia a atual) | `team.manage` | Membros como hoje (nome, e-mail, papel, sessões) e também os convites pendentes (e-mail, papel, validade, situação do envio) |
| `team.changeRole` | `team.manage`, sensível | `canGrant` nos dois papéis; P1 (não mexe em outro dono); nunca deixa a loja sem dono; rebaixar um dono revoga os tokens dele |
| `team.remove` | `team.manage`, sensível | Não remove a si mesmo (use "Sair da loja"); P1; apaga o vínculo e as sessões da pessoa **nesta** loja; revoga os tokens que ela criou aqui. A conta global continua (ela pode estar em outra loja) |
| `team.leave` | `account.self` | Qualquer membro sai da loja. Um dono só sai se outro dono continuar. Apaga as próprias sessões desta loja e manda para o login |
| `team.resendInvite` | `team.manage` | Só convite pendente e no prazo; token novo, validade reiniciada, limites de reenvio. Vencido: convidar de novo |
| `team.revokeInvite` | `team.manage` | `pending → revoked`, link morto |
| `team.revokeSessions` (existe) | `team.manage` | P1: não encerra as sessões de outro dono |

Trocar o papel de alguém não derruba a sessão dessa pessoa. O papel novo vale já no próximo clique, porque
`lookupSession` lê `membership` a cada requisição.

## 8. Uma pessoa em várias lojas

- A conta é uma só (e-mail e senha). Cada loja tem o seu vínculo e o seu papel. Trocar a senha vale para todas as
  lojas e derruba todas as sessões, como já acontece hoje.
- **Trocar de loja:** no `MODE=multi`, o menu do usuário, no rodapé da sidebar, ganha "Suas lojas", com as outras
  lojas onde a pessoa tem vínculo. Cada item é um link para `https://<host da loja>/admin`. A pessoa entra lá com a
  mesma senha e ganha uma sessão daquela loja. Dados vêm da ação `account.stores` (`account.self`), que devolve só
  nome e endereço das lojas da própria pessoa.
- **Sem login único entre lojas, por enquanto:** passar a sessão de um host para outro exige um bilhete assinado de
  uso único entre origens, e isso é superfície de ataque nova. Hoje há uma loja só no ar, então o ganho seria pequeno.
  Fica na seção 11.
- No `MODE=single` só existe uma loja, e o menu não muda.

## 9. MCP

Nada de equipe sai pelo MCP. É a regra do dono (nenhum dado pessoal pelo MCP), e o código já garante isso.

| Ação | Por que fica fora |
|---|---|
| `team.list`, `team.invite`, `team.resendInvite`, `team.revokeInvite`, `team.changeRole`, `team.remove`, `team.revokeSessions` | `team.manage` está em `TOKEN_DENIED` |
| `team.leave`, `account.stores` | `account.self` está em `TOKEN_DENIED` |
| `team.inviteInfo`, `team.acceptInvite` | Públicas: nunca entram no catálogo |

Nenhuma entra em `MCP_EXCLUDED`, porque essa lista é para ações que o papel permitiria mas que mesmo assim ficam de
fora. O teste "toda ação registrada está classificada" passa sozinho. O teste de nomes que nunca aparecem ganha as
ações novas. Contagem de membros, nomes e e-mails de membros e convidados não entram em nenhuma ferramenta. O teste
cobre também que nenhuma saída do MCP traz `@` vindo de `users` ou `team_invite`.

## 10. Telas

Seguem `docs/padrao-de-paginas.md`. Podem ser esboçadas no Doop antes de implementar, se o dono quiser (P5).

- **Página Equipe, `/admin/equipe`** (só `team.manage`; sem a permissão, `notFound()`):
  - **Sidebar:** o item "Equipe (em breve)" vira link na seção Loja. No celular, entra no menu "Mais". A aba "equipe"
    de Configurações sai, e `?aba=equipe` redireciona para a página nova.
  - **Cabeçalho:** `PageHead` com o botão "Convidar pessoa", desabilitado com o aviso da seção 5 quando a loja não tem
    e-mail.
  - **Membros:** tabela do Arc com `Avatar`, nome, e-mail, papel (`Badge`) e sessões. Menu por linha: "Trocar papel"
    (Dialog com Select), "Encerrar sessões" (o que já existe) e "Remover da equipe" (Dialog `tone="danger"`). O texto
    do Dialog diz quantos tokens MCP vão ser revogados. Na própria linha aparecem "Deixar de ser dono" ou "Sair da
    loja".
  - **Convites pendentes:** e-mail, papel, "vence em …", situação ("Enviado às …", "Não enviado: {motivo}"), e os
    botões "Reenviar" e "Revogar".
  - **Dialog "Convidar pessoa":** e-mail, papel (Select com só os papéis que `canGrant` permite) e uma linha
    explicando o papel escolhido (a tabela da seção 3). Ao confirmar, mostra "Convite enviado para {e-mail}" ou o erro
    do envio.
- **Aceite, `/admin/convite/<token>`:** visual das telas de login (`s.auth`), com "{loja} convidou você como {papel}",
  um dos dois formulários da seção 6 e os estados de convite inválido e de bloqueio por tentativas.
- **Sidebar, rodapé:** "Suas lojas" (seção 8), só no `MODE=multi` e só com mais de uma loja.
- **Menu do usuário (rodapé da sidebar e "Mais" no celular):** "Sair da loja" (Dialog `tone="danger"`, `team.leave`) para todos os papéis, escondido para a única dona.

## 11. Testes

- **Unitários e de integração (Bun, PR de produto):**
  - `canGrant` com todos os pares de papéis;
  - convite: limites, duplicados, loja sem e-mail, falha de envio que marca `failed`, token fora da saída, do log e da
    auditoria, `email_log` com hash;
  - aceite: conta nova, conta que já existe, senha errada com bloqueio, vencido, revogado, reusado, token de outra
    loja, dois aceites ao mesmo tempo, limite de membros;
  - gestão: nunca sem dono (também com dois rebaixamentos simultâneos), P1, revogação de tokens, sessões apagadas só
    nesta loja, `team.leave`;
  - RLS de `team_invite`, e o papel `card` sem acesso;
  - catálogo do MCP;
  - `account.stores` só com as lojas da própria pessoa;
  - página `/admin/equipe` com `notFound` para quem não é dono.
- **E2E (PR de verificação separado**, pela regra do repo de não mexer em `e2e/` num PR de produto):
  1. o dono convida `support`, e o e-mail chega no Mailpit;
  2. o convidado abre o link, cria a conta, cai em Pedidos e não vê Conexões;
  3. o mesmo link aberto de novo mostra "não vale mais";
  4. o dono troca o papel para `traffic`, e o membro passa a ver o Dashboard sem recarregar a sessão;
  5. o dono remove o membro, e o próximo clique dele leva ao login;
  6. um convite revogado mostra "não vale mais";
  7. no celular (390), Equipe aparece no menu "Mais".

  O mesmo PR acrescenta `inv_` aos prefixos da verificação de higiene, se ela listar prefixos.

## 12. Fora desta entrega

- Verificação em duas etapas (2FA). Reconfirmação de senha para as outras ações de equipe (remover, encerrar sessões,
  revogar convite): só dar o papel de Dono ou Administrador pede a senha (seção 4).
- Recuperar a senha por e-mail, e trocar o e-mail ou o nome da conta.
- Login único entre lojas (seção 8).
- Apagar a própria conta global (LGPD). Por enquanto, quem sai de todas as lojas mantém a conta, que fica sem acesso
  a nada.
- Papel "Editor de catálogo" ou papéis personalizados (P4).
- Tela de histórico de auditoria da equipe (o `audit_log` grava, mas não há tela).
- Aviso no Telegram ou por e-mail quando um convite é aceito ou alguém é removido.
- Convite pela CLI (`store:create` continua sendo o caminho do operador para criar o primeiro dono).

## 13. Perguntas ao dono

| # | Pergunta | Recomendação |
|---|---|---|
| P1 | Como alguém vira dono e se um dono pode tirar outro | Convite nunca para dono. Dono só por promoção de membro. Um dono não rebaixa nem remove outro, só a si mesmo |
| P2 | Loja sem e-mail conectado | Bloquear o convite até conectar. Alternativa: "Copiar link" só no `MODE=single` |
| P3 | O admin pode convidar e gerir Atendimento e Tráfego? | Não por enquanto (como na spec do MVP). O `canGrant` já deixa isso seguro se mudar |
| P4 | Criar o papel "Editor de catálogo"? | Não agora. Entra quando aparecer alguém que precise |
| P5 | Esboçar as telas no Doop antes? | Não precisa: as telas copiam padrões que já existem (Tokens, Configurações, Login) |

### Respostas do dono (22/11/2026)

O dono aprovou a spec e o plano com as recomendações acima:
- P1: convite nunca para dono; um membro vira dono só por promoção; um dono não rebaixa nem remove outro.
- P2: sem e-mail conectado, ninguém é convidado; não há "copiar link".
- P3: só o dono gere a equipe.
- P4: o papel "Editor de catálogo" não entra agora.
- P5: as telas não passam pelo Doop antes.
