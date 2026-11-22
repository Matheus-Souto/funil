// Aceite do convite da equipe (spec "Equipe e convites", seções 4.3, 4.4 e 6). Duas ações públicas, chamadas pela página
// `/admin/convite/<token>` no host da loja que convidou: `team.inviteInfo` (GET, não consome nada) e
// `team.acceptInvite` (POST, com conta nova ou com a conta que já existe). Token inválido de qualquer tipo (mal formado,
// inventado, de outra loja, vencido, revogado ou já usado) dá a mesma resposta, para a página não dizer se um token
// existe. Nunca token nem e-mail em log ou auditoria; a sessão é criada por quem chama, depois do commit.
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction } from "@/lib/actions/core";
import type { Role } from "@/lib/actions/permissions";
import { hashPassword } from "@/lib/auth/password";
import { MAX_PASSWORD_LENGTH, clearLoginAttempts, verifyCredentials } from "@/lib/auth/session";
import { db, withStore, type Tx } from "@/lib/db/client";
import { membership, store, teamInvite, users } from "@/lib/db/schema";
import { ROLE_LABEL } from "@/lib/orders/labels";
import { checkRateLimit, ipRateKey } from "@/lib/payments/ratelimit";
import { TEAM, inviteTokenHash, lockTeam } from "./rules";

const GONE = "Este convite não vale mais";
const gone = () => new ActionError("not_found", GONE);
const hasAccount = () => new ActionError("conflict", "Você já tem conta na plataforma. Entre com a sua senha para aceitar", { hasAccount: true });

/** Formato frouxo de propósito: qualquer texto curto vira só "não achei" (a validação não responde se o token existe). */
const TOKEN = z.string().max(200);

/** Dados do servidor (fora da entrada): o IP de quem chama e, em testes, o relógio dos limites de tentativa. */
type Server = { ip?: string; now?: Date };

type PendingInvite = { id: string; email: string; role: Role; expiresAt: Date };

/** Convite `pending` e no prazo desta loja com o hash do token, ou `null`. Só leitura. */
async function findPending(tx: Tx, storeId: string, token: string): Promise<PendingInvite | null> {
  const [row] = await tx
    .select({ id: teamInvite.id, email: teamInvite.email, role: teamInvite.role, expiresAt: teamInvite.expiresAt })
    .from(teamInvite)
    .where(
      and(
        eq(teamInvite.storeId, storeId),
        eq(teamInvite.tokenHash, inviteTokenHash(token)),
        eq(teamInvite.status, "pending"),
        gt(teamInvite.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  return row?.email ? { id: row.id, email: row.email, role: row.role as Role, expiresAt: row.expiresAt } : null;
}

/** Conta global (tabela `users`, sem RLS) com esse e-mail. */
async function accountId(email: string): Promise<string | null> {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email.trim().toLowerCase())).limit(1);
  return u?.id ?? null;
}

export const inviteInfo = defineAction({
  name: "team.inviteInfo",
  description: "Dados do convite para a página de aceite: loja, papel, e-mail convidado, se já tem conta e a validade.",
  input: z.object({ token: TOKEN }),
  permission: "public",
  audit: false,
  async run(ctx, { token }): Promise<{ storeName: string; roleLabel: string; email: string; hasAccount: boolean; expiresAt: Date } | null> {
    const inv = await findPending(ctx.tx, ctx.storeId, token);
    if (!inv) return null;
    const [s] = await ctx.tx.select({ name: store.name }).from(store).where(eq(store.id, ctx.storeId)).limit(1);
    if (!s) return null;
    return {
      storeName: s.name,
      roleLabel: ROLE_LABEL[inv.role] ?? inv.role,
      email: inv.email,
      hasAccount: (await accountId(inv.email)) !== null,
      expiresAt: inv.expiresAt,
    };
  },
});

const acceptInput = z.discriminatedUnion("mode", [
  z.object({
    token: TOKEN,
    mode: z.literal("new"),
    name: z.string().trim().min(1).max(100),
    password: z.string().min(10).max(MAX_PASSWORD_LENGTH),
  }),
  z.object({ token: TOKEN, mode: z.literal("existing"), password: z.string().max(MAX_PASSWORD_LENGTH) }),
]);

type Prepared = { inviteId: string; email: string } & ({ mode: "new"; passwordHash: string } | { mode: "existing"; userId: string });

export const acceptInvite = defineAction({
  name: "team.acceptInvite",
  description: "Aceita o convite da equipe: cria a conta (ou confere a senha da conta que já existe) e o vínculo com o papel.",
  input: acceptInput,
  permission: "public",
  // Só o id do convite (achado pelo hash do token no prepare): nunca token, e-mail, nome ou senha.
  auditInput: (_input, prepared?: Prepared) => ({ inviteId: prepared?.inviteId ?? null }),
  auditResult: (o: { userId: string; role: Role; newAccount: boolean }) => ({ userId: o.userId, role: o.role, newAccount: o.newAccount }),
  async prepare(call, input): Promise<Prepared> {
    const server = call.server as Server | undefined;
    const now = server?.now ?? new Date();
    const ip = server?.ip?.trim();
    // Os limites contam fora da transação da ação: a recusa (que desfaz a transação) também gasta a tentativa.
    if (ip && !(await checkRateLimit(`team:accept:ip:${ipRateKey(ip)}`, TEAM.acceptPerIp, TEAM.acceptWindowSec, now))) {
      throw new ActionError("rate_limited", "Muitas tentativas. Espere alguns minutos e tente de novo");
    }
    // Só para decidir o caminho; quem vale é a reivindicação dentro de `run`, sob o lock.
    const inv = await withStore(call.storeId, (tx) => findPending(tx, call.storeId, input.token));
    if (!inv) throw gone();
    if (!(await checkRateLimit(`team:accept:invite:${inv.id}`, TEAM.acceptPerInvite, TEAM.acceptWindowSec, now))) {
      throw new ActionError("rate_limited", "Muitas tentativas neste convite. Espere alguns minutos e tente de novo");
    }
    if (input.mode === "existing") {
      // O mesmo caminho do login: bloqueio de 5 tentativas por e-mail em 15 min e tempo constante.
      const cred = await verifyCredentials(inv.email, input.password);
      if (!cred) throw new ActionError("forbidden", "Senha incorreta");
      return { inviteId: inv.id, email: inv.email, mode: "existing", userId: cred.userId };
    }
    if ((await accountId(inv.email)) !== null) throw hasAccount();
    return { inviteId: inv.id, email: inv.email, mode: "new", passwordHash: await hashPassword(input.password) };
  },
  async run(ctx, input, prepared): Promise<{ userId: string; storeId: string; role: Role; newAccount: boolean }> {
    const { storeId, tx } = ctx;
    await lockTeam(tx, storeId);
    // Uso único: só um aceite reivindica a linha. O e-mail em claro é apagado na mesma escrita.
    const [claimed] = await tx
      .update(teamInvite)
      .set({ status: "accepted", email: null, acceptedAt: sql`now()`, endedAt: sql`now()` })
      .where(
        and(
          eq(teamInvite.id, prepared.inviteId),
          eq(teamInvite.storeId, storeId),
          eq(teamInvite.tokenHash, inviteTokenHash(input.token)),
          eq(teamInvite.status, "pending"),
          gt(teamInvite.expiresAt, sql`now()`),
        ),
      )
      .returning({ id: teamInvite.id, role: teamInvite.role });
    if (!claimed) throw gone();

    let userId: string;
    if (prepared.mode === "new") {
      // A conta pode ter nascido entre o prepare e aqui (outra loja, outro aceite): a página volta no modo "Com conta".
      const [created] = await tx
        .insert(users)
        .values({ email: prepared.email, name: input.mode === "new" ? input.name : "", passwordHash: prepared.passwordHash, mustChangePassword: false })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id });
      if (!created) throw hasAccount();
      userId = created.id;
    } else {
      userId = prepared.userId;
    }

    const [member] = await tx
      .select({ role: membership.role })
      .from(membership)
      .where(and(eq(membership.storeId, storeId), eq(membership.userId, userId)))
      .limit(1);
    let role = claimed.role as Role;
    if (member) {
      // Virou membro por outro caminho: o convite fecha sem duplicar nem mudar o papel.
      role = member.role as Role;
    } else {
      // O convite reivindicado já ocupava um assento: conta só os membros.
      const [members] = await tx.select({ n: sql<number>`count(*)::int` }).from(membership).where(eq(membership.storeId, storeId));
      if (members!.n + 1 > TEAM.maxSeats) throw new ActionError("conflict", `A equipe já tem ${TEAM.maxSeats} pessoas. Fale com quem convidou você`);
      await tx.insert(membership).values({ userId, storeId, role });
    }
    await tx.update(teamInvite).set({ acceptedBy: userId }).where(eq(teamInvite.id, claimed.id));
    return { userId, storeId, role, newAccount: prepared.mode === "new" };
  },
  async afterCommit(_call, _input, _out, prepared) {
    // Senha certa no aceite zera as tentativas de login do e-mail, como o login.
    if (prepared.mode === "existing") await clearLoginAttempts(prepared.email);
  },
});
