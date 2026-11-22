"use client";

// Equipe (só o dono): convite por e-mail, membros (trocar papel, encerrar sessões, remover, deixar de ser dono, sair da
// loja) e convites pendentes (reenviar, revogar). Sem regra de negócio: tudo passa pelas actions, que conferem de novo.
// O link do convite nunca chega aqui: ele só existe no e-mail do convidado.
import { useState } from "react";
import { Ellipsis, LogOut, Plus, Repeat, Trash2, UserX } from "lucide-react";
import { Avatar } from "@/components/arc/avatar/avatar";
import { DropdownMenu } from "@/components/arc/dropdown-menu/dropdown-menu";
import { Select } from "@/components/arc/select/select";
import { SortableDataTable } from "@/components/arc/sortable-data-table/sortable-data-table";
import { Badge } from "../../blocks";
import type { ActionResult } from "../../result";
import s from "../../panel.module.css";
import { Dialog, Live, useActionRunner } from "../../ui";
import { changeRoleAction, inviteAction, leaveStoreAction, removeMemberAction, resendInviteAction, revokeInviteAction, revokeMemberSessionsAction } from "../actions";
import { ROLE_INFO, roleLabel, type MemberRole } from "./roles";

export interface MemberRow {
  userId: string;
  name: string;
  email: string;
  role: string;
  activeSessions: number;
  mustChangePassword: boolean;
  isYou: boolean;
  /** Tokens MCP ativos que a pessoa criou nesta loja (revogados se ela for removida ou deixar de ser dona). */
  tokensCreated: number;
}

export interface InviteRow {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  expiresTs: number;
  sendStatus: "sent" | "failed" | null;
  sendError: string | null;
  lastSentAt: string | null;
}

const ROLE_TONE: Record<string, "success" | "info" | "warning" | "neutral"> = { owner: "success", admin: "info", support: "info", traffic: "warning" };

/** O que o papel pode e não pode (tabela 3 da spec), embaixo do Select. */
function RoleHelp({ role }: { role: MemberRole }) {
  const info = ROLE_INFO[role];
  return (
    <p className={s.hint}>
      <b>{info.label}:</b> {info.can}
      {info.cannot ? ` Não pode: ${info.cannot.charAt(0).toLowerCase()}${info.cannot.slice(1)}` : ""}
    </p>
  );
}

const sessionsText = (n: number) => (n === 0 ? "sem sessão ativa" : n === 1 ? "1 sessão ativa" : `${n} sessões ativas`);

/** Frase do Dialog sobre os tokens MCP que a ação vai revogar. */
function tokensLine(n: number, who: "você" | "ela"): string {
  const created = who === "você" ? "que você criou" : "que essa pessoa criou";
  if (n === 0) return who === "você" ? "Você não tem tokens MCP ativos nesta loja: nenhum será revogado." : "Essa pessoa não tem tokens MCP ativos nesta loja: nenhum será revogado.";
  return n === 1 ? `1 token MCP ${created} nesta loja vai ser revogado.` : `${n} tokens MCP ${created} nesta loja vão ser revogados.`;
}

// ---- convidar ----------------------------------------------------------------------------------------------------

/** Botão do topo da página e o Dialog do convite. Sem e-mail conectado, fica desabilitado (o aviso aparece na página). */
export function InviteButton({ roles, disabled }: { roles: MemberRole[]; disabled: boolean }) {
  // Começa no papel com menos acesso (o último da lista).
  const initial = roles[roles.length - 1] ?? "support";
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>(initial);
  const [done, setDone] = useState(false);
  const invite = useActionRunner();
  const reset = () => {
    setEmail("");
    setRole(initial);
    setDone(false);
    invite.setMsg(null);
  };
  const close = () => {
    setOpen(false);
    reset();
  };

  return (
    <>
      <button
        type="button"
        className={`${s.btn} ${s.btnPrimary}`}
        disabled={disabled || roles.length === 0}
        title={disabled ? "Para convidar alguém, conecte o e-mail da loja em Conexões" : undefined}
        onClick={() => setOpen(true)}
      >
        <Plus size={16} strokeWidth={2} aria-hidden="true" />
        Convidar pessoa
      </button>
      <Dialog
        open={open}
        onClose={close}
        title="Convidar pessoa"
        footer={
          done ? (
            <>
              <button type="button" className={s.btn} onClick={reset}>
                Convidar outra pessoa
              </button>
              <button type="button" className={`${s.btn} ${s.btnPrimary}`} onClick={close} data-autofocus>
                Pronto
              </button>
            </>
          ) : (
            <>
              <button type="button" className={s.btn} onClick={close}>
                Cancelar
              </button>
              <button type="submit" form="invite-form" className={`${s.btn} ${s.btnPrimary}`} disabled={invite.pending || email.trim() === ""}>
                {invite.pending ? "Enviando…" : "Enviar convite"}
              </button>
            </>
          )
        }
      >
        {done ? (
          <Live msg={invite.msg} />
        ) : (
          <form
            id="invite-form"
            className={s.teamForm}
            onSubmit={async (e) => {
              e.preventDefault();
              const r = await invite.run(() => inviteAction({ email: email.trim(), role }));
              if (r.ok) {
                setDone(true);
                // Convite gravado, mas o e-mail não saiu: a mensagem é de erro (com o caminho para resolver).
                if (!r.data.sent && r.message) invite.setMsg({ tone: "error", text: r.message });
              }
            }}
          >
            <label className={s.field}>
              <span className={s.label}>E-mail</span>
              <input
                className={s.input}
                type="email"
                value={email}
                required
                maxLength={254}
                autoComplete="off"
                placeholder="pessoa@exemplo.com"
                onChange={(e) => setEmail(e.target.value)}
                data-autofocus
              />
              <span className={s.hint}>O link do convite vai só para este e-mail e vale 7 dias.</span>
            </label>
            <div className={s.field}>
              <Select
                className={s.arcField}
                label="Papel"
                value={role}
                onValueChange={(v) => setRole(v as MemberRole)}
                options={roles.map((r) => ({ value: r, label: ROLE_INFO[r].label }))}
              />
              <RoleHelp role={role} />
            </div>
            <Live msg={invite.msg} />
          </form>
        )}
      </Dialog>
    </>
  );
}

// ---- membros -----------------------------------------------------------------------------------------------------

type MemberDialog = { kind: "role" | "sessions" | "remove" | "demote" | "leave"; member: MemberRow };

export function MembersTable({ members, roles, owners }: { members: MemberRow[]; roles: MemberRole[]; owners: number }) {
  const [open, setOpen] = useState<MemberDialog | null>(null);
  const [nextRole, setNextRole] = useState<MemberRole>("admin");
  const act = useActionRunner();
  const soleOwner = owners <= 1;
  const show = (kind: MemberDialog["kind"], member: MemberRow) => {
    act.setMsg(null);
    // Trocar papel começa no papel atual; deixar de ser dono, no Administrador.
    setNextRole(kind === "role" && roles.includes(member.role as MemberRole) ? (member.role as MemberRole) : "admin");
    setOpen({ kind, member });
  };
  const close = () => {
    act.setMsg(null);
    setOpen(null);
  };
  const confirm = async <T,>(fn: () => Promise<ActionResult<T>>) => {
    const r = await act.run(fn);
    if (r.ok) setOpen(null);
  };

  const m = open?.member;
  const demoteRoles = roles.filter((r) => r !== "owner");

  const actionsFor = (row: MemberRow) => {
    if (row.isYou) {
      const why = soleOwner && row.role === "owner" ? "A loja precisa de pelo menos um dono" : undefined;
      return (
        <span className={s.rowActions}>
          {row.role === "owner" ? (
            <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={!!why} title={why} onClick={() => show("demote", row)}>
              Deixar de ser dono
            </button>
          ) : null}
          <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={!!why} title={why} onClick={() => show("leave", row)}>
            Sair da loja
          </button>
        </span>
      );
    }
    // Um dono não muda o papel nem remove outro dono (só encerra as sessões dele).
    const otherOwner = row.role === "owner";
    return (
      <span className={s.rowActions}>
        {row.activeSessions > 0 ? (
          <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => show("sessions", row)}>
            Encerrar sessões
          </button>
        ) : null}
        {otherOwner ? null : (
          <DropdownMenu
            label={`Ações de ${row.name || row.email}`}
            align="end"
            triggerClassName={s.iconBtn}
            triggerLabel={`Mais ações de ${row.name || row.email}`}
            trigger={<Ellipsis size={16} strokeWidth={1.75} aria-hidden="true" />}
            items={[
              { label: "Trocar papel", icon: <Repeat size={15} strokeWidth={1.75} />, onSelect: () => show("role", row) },
              { label: "Remover da equipe", icon: <UserX size={15} strokeWidth={1.75} />, destructive: true, separatorBefore: true, onSelect: () => show("remove", row) },
            ]}
          />
        )}
      </span>
    );
  };

  return (
    // Uma linha por pessoa (no celular, as ações descem para baixo do nome).
    <section className={`${s.card} ${s.cardFlush} ${s.teamCard}`} aria-label="Membros da equipe">
      <div className={s.teamHead}>
        <h2>Membros</h2>
        <small>{members.length === 1 ? "1 pessoa" : `${members.length} pessoas`}</small>
      </div>
      {members.map((row) => (
        <div className={s.setMember} key={row.userId}>
          <Avatar name={row.name || row.email} size="md" />
          <span className={s.setMemberText}>
            <b>
              {row.name || "Sem nome"}
              {row.isYou ? <span className={s.muted}> (você)</span> : null}
            </b>
            <small className={s.leadEmail}>{row.email}</small>
            <small>
              {sessionsText(row.activeSessions)}
              {row.mustChangePassword ? " · ainda com a senha temporária" : ""}
            </small>
          </span>
          <Badge tone={ROLE_TONE[row.role] ?? "neutral"}>{roleLabel(row.role)}</Badge>
          {actionsFor(row)}
        </div>
      ))}
      {soleOwner ? (
        <p className={s.teamFoot}>
          Você é o único dono. Para transferir a loja, troque o papel de outra pessoa para Dono e depois deixe de ser dono.
        </p>
      ) : null}
      <div className={s.teamLive}>
        <Live msg={open ? null : act.msg} />
      </div>

      <Dialog
        open={open?.kind === "role"}
        onClose={close}
        title={`Trocar o papel de ${m?.name ?? ""}`}
        footer={
          <>
            <button type="button" className={s.btn} onClick={close} data-autofocus>
              Cancelar
            </button>
            <button
              type="button"
              className={`${s.btn} ${s.btnPrimary}`}
              disabled={act.pending || nextRole === m?.role}
              onClick={() => m && confirm(() => changeRoleAction(m.userId, nextRole))}
            >
              {act.pending ? "Salvando…" : "Trocar papel"}
            </button>
          </>
        }
      >
        <div className={s.field}>
          <Select
            className={s.arcField}
            label="Papel"
            value={nextRole}
            onValueChange={(v) => setNextRole(v as MemberRole)}
            options={roles.map((r) => ({ value: r, label: ROLE_INFO[r].label }))}
          />
          <RoleHelp role={nextRole} />
        </div>
        {nextRole === "owner" && m?.role !== "owner" ? (
          <p>
            Como dono, {m?.name} passa a gerir a equipe, os tokens MCP e as conexões. Um dono não muda o papel de outro dono nem o remove: depois,
            só {m?.name} pode deixar de ser dono.
          </p>
        ) : null}
        <p>A troca vale no próximo clique de {m?.name}, sem precisar entrar de novo.</p>
        {act.msg?.tone === "error" ? <Live msg={act.msg} /> : null}
      </Dialog>

      <Dialog
        open={open?.kind === "sessions"}
        onClose={close}
        title={`Encerrar as sessões de ${m?.name ?? ""}?`}
        footer={
          <>
            <button type="button" className={s.btn} onClick={close} data-autofocus>
              Cancelar
            </button>
            <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled={act.pending} onClick={() => m && confirm(() => revokeMemberSessionsAction(m.userId))}>
              {act.pending ? "Encerrando…" : "Encerrar sessões"}
            </button>
          </>
        }
      >
        <p>
          {m?.email} sai do painel desta loja em todos os aparelhos e precisa entrar de novo com a senha. Se a senha pode ter vazado, peça que a troque
          depois de entrar.
        </p>
        {act.msg?.tone === "error" ? <Live msg={act.msg} /> : null}
      </Dialog>

      <Dialog
        open={open?.kind === "remove"}
        onClose={close}
        tone="danger"
        title={`Remover ${m?.name ?? ""} da equipe?`}
        footer={
          <>
            <button type="button" className={s.btn} onClick={close} data-autofocus>
              Cancelar
            </button>
            <button type="button" className={`${s.btn} ${s.btnDanger}`} disabled={act.pending} onClick={() => m && confirm(() => removeMemberAction(m.userId))}>
              <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
              {act.pending ? "Removendo…" : "Remover da equipe"}
            </button>
          </>
        }
      >
        <p>
          {m?.email} perde o acesso ao painel desta loja agora e as sessões dele aqui são encerradas. A conta continua existindo (ela pode estar em
          outra loja). Para voltar, só com um convite novo.
        </p>
        <p>{tokensLine(m?.tokensCreated ?? 0, "ela")}</p>
        {act.msg?.tone === "error" ? <Live msg={act.msg} /> : null}
      </Dialog>

      <Dialog
        open={open?.kind === "demote"}
        onClose={close}
        tone="danger"
        title="Deixar de ser dono?"
        footer={
          <>
            <button type="button" className={s.btn} onClick={close} data-autofocus>
              Cancelar
            </button>
            <button type="button" className={`${s.btn} ${s.btnDanger}`} disabled={act.pending} onClick={() => m && confirm(() => changeRoleAction(m.userId, nextRole))}>
              {act.pending ? "Salvando…" : "Deixar de ser dono"}
            </button>
          </>
        }
      >
        <div className={s.field}>
          <Select
            className={s.arcField}
            label="Seu novo papel"
            value={nextRole}
            onValueChange={(v) => setNextRole(v as MemberRole)}
            options={demoteRoles.map((r) => ({ value: r, label: ROLE_INFO[r].label }))}
          />
          <RoleHelp role={nextRole} />
        </div>
        <p>Você deixa de gerir a equipe, os tokens MCP e as conexões. Para voltar a ser dono, outro dono precisa promover você.</p>
        <p>{tokensLine(m?.tokensCreated ?? 0, "você")}</p>
        {act.msg?.tone === "error" ? <Live msg={act.msg} /> : null}
      </Dialog>

      <Dialog
        open={open?.kind === "leave"}
        onClose={close}
        tone="danger"
        title="Sair da loja?"
        footer={
          <>
            <button type="button" className={s.btn} onClick={close} data-autofocus>
              Cancelar
            </button>
            <button type="button" className={`${s.btn} ${s.btnDanger}`} disabled={act.pending} onClick={() => confirm(() => leaveStoreAction())}>
              <LogOut size={16} strokeWidth={1.75} aria-hidden="true" />
              {act.pending ? "Saindo…" : "Sair da loja"}
            </button>
          </>
        }
      >
        <p>Você sai da equipe desta loja e volta para a tela de login. Para voltar, alguém precisa convidar você de novo. A sua conta continua existindo.</p>
        <p>{tokensLine(m?.tokensCreated ?? 0, "você")}</p>
        {act.msg?.tone === "error" ? <Live msg={act.msg} /> : null}
      </Dialog>
    </section>
  );
}

// ---- convites pendentes ------------------------------------------------------------------------------------------

export function InvitesTable({ invites }: { invites: InviteRow[] }) {
  const [revoking, setRevoking] = useState<InviteRow | null>(null);
  const act = useActionRunner();
  const closeRevoke = () => {
    act.setMsg(null);
    setRevoking(null);
  };
  const resend = async (inv: InviteRow) => {
    const r = await act.run(() => resendInviteAction(inv.id));
    if (r.ok && !r.data.sent && r.message) act.setMsg({ tone: "error", text: r.message });
  };

  return (
    <section className={`${s.card} ${s.cardFlush} ${s.teamCard}`} aria-labelledby="equipe-convites">
      <div className={s.teamHead}>
        <h2 id="equipe-convites">Convites pendentes</h2>
        {invites.length > 0 ? <small>{invites.length === 1 ? "1 convite" : `${invites.length} convites`}</small> : null}
      </div>
      {invites.length === 0 ? (
        <p className={s.teamFoot}>Nenhum convite pendente. Quem for convidado aparece aqui até aceitar.</p>
      ) : (
        <div className={s.arcTable}>
          <SortableDataTable<InviteRow & Record<string, unknown>>
            rows={invites as Array<InviteRow & Record<string, unknown>>}
            rowKey="id"
            caption="Convites pendentes"
            itemName={{ one: "convite", other: "convites" }}
            columns={[
              { key: "email", label: "E-mail", render: (_, inv) => <span className={s.leadEmail}>{inv.email}</span> },
              { key: "role", label: "Papel", render: (_, inv) => <Badge tone={ROLE_TONE[inv.role] ?? "neutral"}>{roleLabel(inv.role)}</Badge> },
              { key: "expiresTs", label: "Validade", render: (_, inv) => <span className={`${s.muted} ${s.nowrap}`}>vence em {inv.expiresAt}</span> },
              {
                key: "sendStatus",
                label: "Situação",
                render: (_, inv) =>
                  inv.sendStatus === "sent" ? (
                    <Badge tone="success">Enviado {inv.lastSentAt ? `(${inv.lastSentAt})` : ""}</Badge>
                  ) : inv.sendStatus === "failed" ? (
                    <span className={s.leadCell}>
                      <Badge tone="danger">Não enviado</Badge>
                      <small>{inv.sendError ?? "sem motivo informado"}</small>
                    </span>
                  ) : (
                    <Badge tone="neutral">Enviando</Badge>
                  ),
              },
              {
                key: "id",
                label: "Ações",
                sortable: false,
                render: (_, inv) => (
                  <span className={s.rowActions}>
                    <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={act.pending} onClick={() => resend(inv)} aria-label={`Reenviar o convite de ${inv.email}`}>
                      Reenviar
                    </button>
                    <button
                      type="button"
                      className={`${s.btn} ${s.btnSm}`}
                      onClick={() => {
                        act.setMsg(null);
                        setRevoking(inv);
                      }}
                      aria-label={`Revogar o convite de ${inv.email}`}
                    >
                      Revogar
                    </button>
                  </span>
                ),
              },
            ]}
          />
        </div>
      )}
      <div className={s.teamLive}>
        <Live msg={revoking ? null : act.msg} />
      </div>
      <Dialog
        open={revoking !== null}
        onClose={closeRevoke}
        tone="danger"
        title="Revogar o convite?"
        footer={
          <>
            <button type="button" className={s.btn} onClick={closeRevoke} data-autofocus>
              Cancelar
            </button>
            <button
              type="button"
              className={`${s.btn} ${s.btnDanger}`}
              disabled={act.pending}
              onClick={async () => {
                if (!revoking) return;
                const r = await act.run(() => revokeInviteAction(revoking.id));
                if (r.ok) setRevoking(null);
              }}
            >
              {act.pending ? "Revogando…" : "Revogar"}
            </button>
          </>
        }
      >
        <p>O link enviado para {revoking?.email} deixa de valer na hora. Para convidar de novo, use Convidar pessoa.</p>
        {act.msg?.tone === "error" ? <Live msg={act.msg} /> : null}
      </Dialog>
    </section>
  );
}
