import Link from "next/link";
import { notFound } from "next/navigation";
import { runAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { listTeam } from "@/lib/auth/account";
import { requirePanelActor } from "@/lib/auth/session";
import { connectionsStatus } from "@/lib/connections";
import { dateTimeSP, shortWhenSP } from "@/lib/format";
import { MEMBER_ROLES } from "@/lib/team/members";
import { INVITE_ROLES, canGrant } from "@/lib/team/rules";
import { Notice, PageHead } from "../../blocks";
import s from "../../panel.module.css";
import type { MemberRole } from "./roles";
import { InviteButton, InvitesTable, MembersTable, type InviteRow, type MemberRow } from "./team-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Equipe" };

/** Sem resultado do envio depois disso, a situação vira "Envio não confirmado" em vez de "Enviando". */
const STUCK_SEND_MS = 5 * 60_000;

// Equipe (spec "Equipe e convites", seção 10): membros, convites pendentes e o convite por e-mail. Só quem gere a equipe
// (`team.manage`, hoje só o dono); sem a permissão, 404 como as outras telas protegidas por papel.
export default async function TeamPage() {
  const panel = await requirePanelActor();
  if (!hasPermission(panel.actor.role, "team.manage")) notFound();
  const ctx = { ...panel, origin: "panel" as const };
  const [team, conn] = await Promise.all([runAction(listTeam, ctx, {}), runAction(connectionsStatus, ctx, {})]);
  const role = panel.actor.role;
  const now = new Date();

  const members: MemberRow[] = team.members.map((m) => ({
    userId: m.userId,
    name: m.name,
    email: m.email,
    role: m.role,
    activeSessions: m.activeSessions,
    mustChangePassword: m.mustChangePassword,
    isYou: m.isYou,
    tokensCreated: m.tokensCreated,
  }));
  const invites: InviteRow[] = team.invites.map((i) => ({
    id: i.id,
    email: i.email ?? "",
    role: i.role,
    expiresAt: dateTimeSP(i.expiresAt),
    expiresTs: i.expiresAt.getTime(),
    sendStatus: i.sendStatus === "sent" || i.sendStatus === "failed" ? i.sendStatus : null,
    sendError: i.sendError,
    lastSentAt: i.lastSentAt ? shortWhenSP(i.lastSentAt, now) : null,
    sendStuck: i.sendStatus === null && i.lastSentAt !== null && now.getTime() - i.lastSentAt.getTime() > STUCK_SEND_MS,
  }));
  // Só os papéis que quem está logado pode conceder (a ação confere de novo, sob o lock).
  const inviteRoles = INVITE_ROLES.filter((r) => canGrant(role, r)) as MemberRole[];
  const memberRoles = MEMBER_ROLES.filter((r) => canGrant(role, r)) as MemberRole[];
  const owners = members.filter((m) => m.role === "owner").length;

  return (
    <>
      <PageHead
        title="Equipe"
        sub="Quem acessa o painel desta loja e os convites que ainda não foram aceitos."
        actions={<InviteButton roles={inviteRoles} disabled={!conn.emailUsable} />}
      />
      {conn.emailUsable ? null : (
        <div className={s.noticeStrip}>
          <Notice tone="warning" action={<Link href="/admin/connections">Abrir Conexões</Link>}>
            Para convidar alguém, conecte o e-mail da loja em Conexões
          </Notice>
        </div>
      )}
      <MembersTable members={members} roles={memberRoles} owners={owners} />
      <InvitesTable invites={invites} />
    </>
  );
}
