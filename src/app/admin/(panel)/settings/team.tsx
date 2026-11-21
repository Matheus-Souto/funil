"use client";

// Equipe (só o dono): membros da loja, sessões ativas no painel e "Encerrar sessões" (o membro precisa entrar de novo).
import { useState } from "react";
import { ROLE_LABEL } from "@/lib/orders/labels";
import type { Role } from "@/lib/actions/permissions";
import s from "../../panel.module.css";
import { Dialog, Live, useActionRunner } from "../../ui";
import { revokeMemberSessionsAction } from "../actions";

export interface TeamMember {
  userId: string;
  name: string;
  email: string;
  role: string;
  activeSessions: number;
  mustChangePassword: boolean;
  isYou: boolean;
}

export function TeamList({ members }: { members: TeamMember[] }) {
  const [target, setTarget] = useState<TeamMember | null>(null);
  const { pending, msg, run } = useActionRunner();
  return (
    <section className={s.card} aria-label="Equipe">
      <div className={s.rows}>
        {members.map((m) => (
          <div className={s.row} key={m.userId}>
            <span className={s.rowMain}>
              <b>{m.name}</b> <span className={s.muted}>{m.email}</span>
              <br />
              <small className={s.muted}>
                {ROLE_LABEL[m.role as Role] ?? m.role}
                {m.isYou ? " · você" : ""} · {m.activeSessions === 1 ? "1 sessão ativa" : `${m.activeSessions} sessões ativas`}
                {m.mustChangePassword ? " · ainda com a senha temporária" : ""}
              </small>
            </span>
            {m.isYou || m.activeSessions === 0 ? null : (
              <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => setTarget(m)}>
                Encerrar sessões
              </button>
            )}
          </div>
        ))}
      </div>
      <Live msg={target ? null : msg} />
      <Dialog
        open={target !== null}
        onClose={() => setTarget(null)}
        title={`Encerrar as sessões de ${target?.name ?? ""}?`}
        footer={
          <>
            <button type="button" className={s.btn} onClick={() => setTarget(null)} data-autofocus>
              Cancelar
            </button>
            <button
              type="button"
              className={`${s.btn} ${s.btnPrimary}`}
              disabled={pending}
              onClick={async () => {
                if (!target) return;
                const r = await run(() => revokeMemberSessionsAction(target.userId));
                if (r.ok) setTarget(null);
              }}
            >
              {pending ? "Encerrando…" : "Encerrar sessões"}
            </button>
          </>
        }
      >
        <p>
          {target?.email} sai do painel desta loja em todos os aparelhos e precisa entrar de novo com a senha. Se a senha
          dele pode ter vazado, peça que troque a senha depois de entrar.
        </p>
        {msg?.tone === "error" ? <Live msg={msg} /> : null}
      </Dialog>
    </section>
  );
}
