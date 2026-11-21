"use client";

// Ações da página de contatos: marcar como contatado, excluir um contato e excluir tudo de um e-mail (pedido do titular).
// Sem regra de negócio: tudo passa pelas server actions do painel (POST). O e-mail a excluir nunca vai para a URL.
import { useState } from "react";
import s from "../../panel.module.css";
import { Dialog, Live, useActionRunner } from "../../ui";
import { deleteLeadAction, forgetLeadEmailAction, markLeadContactedAction } from "../actions";

export function LeadRowActions({ id, code, status }: { id: string; code: string; status: "open" | "contacted" }) {
  const mark = useActionRunner();
  const del = useActionRunner();
  const [confirm, setConfirm] = useState(false);
  const busy = mark.pending || del.pending;
  const close = () => {
    del.setMsg(null);
    setConfirm(false);
  };
  return (
    <div className={s.formActions}>
      {status === "open" ? (
        <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={busy} onClick={() => mark.run(() => markLeadContactedAction(id))}>
          Marcar como contatado
        </button>
      ) : null}
      <button
        type="button"
        className={`${s.btn} ${s.btnSm} ${s.btnDangerGhost}`}
        disabled={busy}
        aria-label={`Excluir o contato #${code}`}
        onClick={() => {
          mark.setMsg(null);
          del.setMsg(null);
          setConfirm(true);
        }}
      >
        Excluir
      </button>
      <Live msg={confirm ? null : (del.msg ?? mark.msg)} />
      <Dialog
        open={confirm}
        onClose={close}
        icon="shield-alert"
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

export function ForgetEmailForm() {
  const [email, setEmail] = useState("");
  const [confirm, setConfirm] = useState(false);
  const forget = useActionRunner();
  const clean = email.trim();
  const close = () => {
    forget.setMsg(null);
    setConfirm(false);
  };
  return (
    <>
      {/* Sem `name` no campo e sem GET: o e-mail só viaja no corpo do POST da server action, nunca na URL. */}
      <form
        className={s.filters}
        onSubmit={(e) => {
          e.preventDefault();
          if (clean) {
            forget.setMsg(null);
            setConfirm(true);
          }
        }}
      >
        <label className={s.search}>
          <span className={s.srOnly}>E-mail do titular que pediu a exclusão</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="E-mail de quem pediu a exclusão" maxLength={254} autoComplete="off" />
        </label>
        <button type="submit" className={`${s.btn} ${s.btnDangerGhost}`} disabled={!clean || forget.pending}>
          Excluir todos deste e-mail
        </button>
      </form>
      <Live msg={confirm ? null : forget.msg} />
      <Dialog
        open={confirm}
        onClose={close}
        icon="shield-alert"
        tone="danger"
        title="Excluir todos os contatos deste e-mail?"
        footer={
          <>
            <button type="button" className={s.btn} onClick={close} data-autofocus>
              Cancelar
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
                }
              }}
            >
              {forget.pending ? "Excluindo…" : "Excluir todos"}
            </button>
          </>
        }
      >
        <p>
          Apaga todos os contatos guardados com <b style={{ overflowWrap: "anywhere" }}>{clean}</b>, em todas as ofertas da loja. Não dá para desfazer.
        </p>
        {forget.msg?.tone === "error" ? <Live msg={forget.msg} /> : null}
      </Dialog>
    </>
  );
}
