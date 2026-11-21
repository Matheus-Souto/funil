"use client";

// Ações da página de contatos: WhatsApp e copiar o e-mail (ícones), marcar como contatado e excluir (menu "⋯") e excluir
// tudo de um e-mail (pedido do titular, num modal). Sem regra de negócio: tudo passa pelas server actions do painel (POST).
// O e-mail a excluir nunca vai para a URL.
import { useEffect, useState } from "react";
import { Check, Copy, Ellipsis, MessageCircleCheck, Trash2 } from "lucide-react";
import { DropdownMenu } from "@/components/arc/dropdown-menu/dropdown-menu";
import { Tooltip } from "@/components/arc/tooltip/tooltip";
import { brandOf } from "../../brand-icons";
import s from "../../panel.module.css";
import { Dialog, Live, useActionRunner } from "../../ui";
import { deleteLeadAction, forgetLeadEmailAction, markLeadContactedAction } from "../actions";

const WHATSAPP = brandOf("whatsapp")!;

/** Copia o e-mail do contato (ícone com dica; o resultado vai para a região aria-live). */
function CopyEmail({ email }: { email: string }) {
  const [done, setDone] = useState<null | "ok" | "fail">(null);
  useEffect(() => {
    if (!done) return;
    const h = window.setTimeout(() => setDone(null), 2000);
    return () => window.clearTimeout(h);
  }, [done]);
  return (
    <>
      <Tooltip content={done === "ok" ? "Copiado!" : "Copiar e-mail"}>
        <button
          type="button"
          className={s.iconBtn}
          aria-label={`Copiar o e-mail ${email}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(email);
              setDone("ok");
            } catch {
              setDone("fail");
            }
          }}
        >
          {done === "ok" ? <Check size={16} strokeWidth={2} aria-hidden="true" /> : <Copy size={16} strokeWidth={1.75} aria-hidden="true" />}
        </button>
      </Tooltip>
      <span className={s.srOnly} role="status" aria-live="polite">
        {done === "ok" ? "E-mail copiado." : done === "fail" ? "Não foi possível copiar. Selecione o e-mail e copie à mão." : ""}
      </span>
    </>
  );
}

export function LeadRowActions({
  id,
  code,
  status,
  email,
  whatsapp,
  canWrite,
}: {
  id: string;
  code: string;
  status: "open" | "contacted";
  email: string | null;
  whatsapp: string | null;
  canWrite: boolean;
}) {
  const mark = useActionRunner();
  const del = useActionRunner();
  const [confirm, setConfirm] = useState(false);
  const busy = mark.pending || del.pending;
  const close = () => {
    del.setMsg(null);
    setConfirm(false);
  };
  return (
    <div className={s.rowActions}>
      {whatsapp ? (
        <Tooltip content="Abrir no WhatsApp">
          <a className={s.iconBtn} href={whatsapp} target="_blank" rel="noopener noreferrer" aria-label={`Abrir o contato #${code} no WhatsApp`}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill={WHATSAPP.hex} aria-hidden="true">
              <path d={WHATSAPP.path} />
            </svg>
          </a>
        </Tooltip>
      ) : null}
      {email ? (
        <span className={s.hideSm}>
          <CopyEmail email={email} />
        </span>
      ) : null}
      {canWrite ? (
        <DropdownMenu
          label={`Ações do contato #${code}`}
          align="end"
          triggerClassName={s.iconBtn}
          triggerLabel={`Mais ações do contato #${code}`}
          trigger={<Ellipsis size={16} strokeWidth={1.75} aria-hidden="true" />}
          items={[
            ...(status === "open"
              ? [
                  {
                    label: "Marcar como contatado",
                    icon: <MessageCircleCheck size={15} strokeWidth={1.75} />,
                    disabled: busy,
                    onSelect: () => void mark.run(() => markLeadContactedAction(id)),
                  },
                ]
              : []),
            {
              label: "Excluir contato",
              icon: <Trash2 size={15} strokeWidth={1.75} />,
              destructive: true,
              separatorBefore: status === "open",
              disabled: busy,
              onSelect: () => {
                mark.setMsg(null);
                del.setMsg(null);
                setConfirm(true);
              },
            },
          ]}
        />
      ) : null}
      <Live msg={confirm ? null : (del.msg ?? mark.msg)} />
      <Dialog
        open={confirm}
        onClose={close}
        tone="danger"
        title={`Excluir o contato #${code}?`}
        footer={
          <>
            <button type="button" className={s.btn} onClick={close} data-autofocus>
              Cancelar
            </button>
            <button
              type="button"
              className={`${s.btn} ${s.btnDanger}`}
              disabled={del.pending}
              onClick={async () => {
                const r = await del.run(() => deleteLeadAction(id));
                if (r.ok) setConfirm(false);
              }}
            >
              {del.pending ? "Excluindo…" : "Excluir"}
            </button>
          </>
        }
      >
        <p>O e-mail e o celular deste contato são apagados e não dá para desfazer.</p>
        {del.msg?.tone === "error" ? <Live msg={del.msg} /> : null}
      </Dialog>
    </div>
  );
}

/** Link "Pedido de exclusão (LGPD)" no rodapé: abre o modal que apaga todos os contatos de um e-mail. */
export function ForgetEmailButton() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [confirm, setConfirm] = useState(false);
  const forget = useActionRunner();
  const clean = email.trim();
  const reset = () => {
    forget.setMsg(null);
    setConfirm(false);
    setEmail("");
  };
  return (
    <>
      <button type="button" className={s.linkBtn} onClick={() => setOpen(true)}>
        Pedido de exclusão (LGPD)
      </button>
      <Live msg={open ? null : forget.msg} />
      <Dialog
        open={open}
        onClose={() => {
          reset();
          setOpen(false);
        }}
        tone={confirm ? "danger" : undefined}
        title={confirm ? "Excluir todos os contatos deste e-mail?" : "Pedido de exclusão do titular"}
        footer={
          confirm ? (
            <>
              <button type="button" className={s.btn} onClick={() => setConfirm(false)} data-autofocus>
                Voltar
              </button>
              <button
                type="button"
                className={`${s.btn} ${s.btnDanger}`}
                disabled={forget.pending}
                onClick={async () => {
                  const r = await forget.run(() => forgetLeadEmailAction(clean));
                  if (r.ok) {
                    setConfirm(false);
                    setEmail("");
                    setOpen(false);
                  }
                }}
              >
                {forget.pending ? "Excluindo…" : "Excluir todos"}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={s.btn}
                onClick={() => {
                  reset();
                  setOpen(false);
                }}
              >
                Cancelar
              </button>
              <button type="submit" form="forget-email" className={`${s.btn} ${s.btnDangerGhost}`} disabled={!clean}>
                Continuar
              </button>
            </>
          )
        }
      >
        {confirm ? (
          <p>
            Apaga todos os contatos guardados com <b style={{ overflowWrap: "anywhere" }}>{clean}</b>, em todas as ofertas da loja. Não dá para desfazer.
          </p>
        ) : (
          // Sem `name` no campo e sem GET: o e-mail só viaja no corpo do POST da server action, nunca na URL.
          <form
            id="forget-email"
            className={s.stack}
            onSubmit={(e) => {
              e.preventDefault();
              if (clean) {
                forget.setMsg(null);
                setConfirm(true);
              }
            }}
          >
            <p className={s.muted}>Quando alguém pedir para apagar os dados, informe o e-mail: todos os contatos da loja com ele são excluídos.</p>
            <label className={s.field}>
              <span className={s.label}>E-mail do titular</span>
              <input
                className={s.input}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="E-mail de quem pediu a exclusão"
                maxLength={254}
                autoComplete="off"
                data-autofocus
              />
            </label>
          </form>
        )}
        {forget.msg?.tone === "error" ? <Live msg={forget.msg} /> : null}
      </Dialog>
    </>
  );
}
