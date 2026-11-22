"use client";

// Formulário do aceite do convite: conta nova (nome, senha e confirmação) ou conta que já existe (só a senha). Os erros
// voltam da server action como estado (`useActionState`): nome e senha nunca vão para a URL. O e-mail é o do convite e não
// muda no aceite.
import { useActionState } from "react";
import { acceptInviteAction, type AcceptState } from "../../actions";
import { PIcon } from "../../icons";
import s from "../../panel.module.css";
import { GONE_TEXT } from "./texts";

export function AcceptForm({ token, email, hasAccount }: { token: string; email: string; hasAccount: boolean }) {
  const [state, action, pending] = useActionState<AcceptState, FormData>(acceptInviteAction, null);
  // A conta pode ter nascido entre abrir a página e enviar: aí a página passa ao formulário de senha.
  const existing = hasAccount || state?.hasAccount === true;

  if (state?.gone) {
    return (
      <div className={s.authCard}>
        <div className={s.banner} data-tone="danger" role="alert">
          <PIcon name="circle-alert" />
          <div>{GONE_TEXT}</div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className={s.authCard}>
        <form action={action}>
          {state?.error ? (
            <div className={s.banner} data-tone="danger" role="alert">
              <PIcon name="circle-alert" />
              <div>{state.error}</div>
            </div>
          ) : null}
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="mode" value={existing ? "existing" : "new"} />
          <label className={s.field}>
            <span className={s.label}>E-mail</span>
            <input className={s.input} type="email" value={email} readOnly autoComplete="username" aria-describedby="convite-email" />
            <span className={s.hint} id="convite-email">
              {existing ? "Você já tem conta na plataforma. Entre com a sua senha para aceitar." : "A sua conta vai usar este e-mail."}
            </span>
          </label>
          {existing ? (
            <label className={s.field}>
              <span className={s.label}>Senha</span>
              <input className={s.input} name="password" type="password" autoComplete="current-password" required maxLength={256} autoFocus />
            </label>
          ) : (
            <>
              <label className={s.field}>
                <span className={s.label}>Seu nome</span>
                <input key={state?.name ?? ""} className={s.input} name="name" type="text" autoComplete="name" required maxLength={100} defaultValue={state?.name ?? ""} autoFocus />
              </label>
              <label className={s.field}>
                <span className={s.label}>Crie uma senha</span>
                <input className={s.input} name="password" type="password" autoComplete="new-password" required minLength={10} maxLength={256} />
                <span className={s.hint}>No mínimo 10 caracteres.</span>
              </label>
              <label className={s.field}>
                <span className={s.label}>Repita a senha</span>
                <input className={s.input} name="confirmPassword" type="password" autoComplete="new-password" required minLength={10} maxLength={256} />
              </label>
            </>
          )}
          <button type="submit" className={`${s.btn} ${s.btnPrimary} ${s.btnLg} ${s.btnBlock}`} disabled={pending}>
            {pending ? "Aceitando…" : existing ? "Entrar e aceitar" : "Criar conta e aceitar"}
          </button>
        </form>
      </div>
      {existing ? (
        <p className={`${s.hint} ${s.authHint}`}>
          Esqueceu a senha? Fale com quem convidou você.
        </p>
      ) : null}
    </>
  );
}
