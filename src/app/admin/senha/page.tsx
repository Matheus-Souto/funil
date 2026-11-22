import Link from "next/link";
import { getPanelIdentity, requirePanelActor } from "@/lib/auth/session";
import { changePasswordFormAction, logoutAction } from "../(panel)/actions";
import { PIcon } from "../icons";
import { Art } from "../blocks";
import s from "../panel.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Trocar senha" };

const ERRORS: Record<string, string> = {
  atual: "A senha atual não confere.",
  confirmacao: "A senha nova e a repetição não são iguais.",
  nova: "A senha nova precisa ter no mínimo 10 caracteres e ser diferente da atual.",
  limite: "Muitas tentativas. Espere 15 minutos e tente de novo.",
};

// Trocar senha. Fora do grupo do painel: com senha temporária (store:create), toda outra tela redireciona para cá.
export default async function ChangePasswordPage({ searchParams }: { searchParams: Promise<{ erro?: string; ok?: string }> }) {
  const panel = await requirePanelActor({ allowPasswordChange: true });
  const { erro, ok } = await searchParams;
  const id = await getPanelIdentity(panel);
  const forced = panel.mustChangePassword === true;
  return (
    <div className={`${s.root} ${s.auth}`}>
      <header className={s.authTop}>
        <span className={s.brand} style={{ padding: 0 }}>
          funil
        </span>
        {forced ? (
          <form action={logoutAction}>
            <button type="submit" className={`${s.btn} ${s.btnSm}`}>
              Sair
            </button>
          </form>
        ) : (
          <Link href="/admin" className={s.muted}>
            Voltar ao painel
          </Link>
        )}
      </header>
      <main className={s.authBody}>
        <Art name="funil" size={120} className={s.authArt} />
        <h1>Trocar senha</h1>
        <p className={s.authLead}>
          {id.userEmail} · {id.storeName}
        </p>
        <div className={s.authCard}>
          {ok ? (
            <div className={s.stack}>
              <div className={s.banner} data-tone="info" role="status">
                <PIcon name="circle-check" />
                <div>Senha trocada. As outras sessões (outros aparelhos e navegadores) foram encerradas.</div>
              </div>
              <Link href="/admin" className={`${s.btn} ${s.btnPrimary} ${s.btnLg} ${s.btnBlock}`}>
                Ir para o painel
              </Link>
            </div>
          ) : (
            <form action={changePasswordFormAction}>
              {forced ? (
                <div className={s.banner} role="note">
                  <PIcon name="lock" />
                  <div>Você entrou com uma senha temporária. Escolha uma senha sua para continuar.</div>
                </div>
              ) : null}
              {erro ? (
                <div className={s.banner} data-tone="danger" role="alert">
                  <PIcon name="circle-alert" />
                  <div>{ERRORS[erro] ?? "Não foi possível trocar a senha."}</div>
                </div>
              ) : null}
              <label className={s.field}>
                <span className={s.label}>{forced ? "Senha temporária" : "Senha atual"}</span>
                <input className={s.input} name="currentPassword" type="password" autoComplete="current-password" required maxLength={256} />
              </label>
              <label className={s.field}>
                <span className={s.label}>Senha nova (mínimo 10 caracteres)</span>
                <input className={s.input} name="newPassword" type="password" autoComplete="new-password" required minLength={10} maxLength={256} />
              </label>
              <label className={s.field}>
                <span className={s.label}>Repita a senha nova</span>
                <input className={s.input} name="confirmPassword" type="password" autoComplete="new-password" required minLength={10} maxLength={256} />
              </label>
              <p className={s.hint}>Ao trocar, as suas sessões em outros aparelhos e navegadores são encerradas.</p>
              <button type="submit" className={`${s.btn} ${s.btnPrimary} ${s.btnLg} ${s.btnBlock}`}>
                Trocar senha
              </button>
            </form>
          )}
        </div>
      </main>
      <footer className={s.authFoot}>
        <span>Funil · plataforma de vendas de código aberto</span>
      </footer>
    </div>
  );
}
