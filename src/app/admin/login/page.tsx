import { redirect } from "next/navigation";
import { needsSetup } from "@/lib/stores";
import { loginAction } from "../actions";
import { PIcon } from "../icons";
import { Art } from "../blocks";
import { BrandLogo } from "../brand";
import s from "../panel.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Entrar" };

// P01 Login.
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ erro?: string }> }) {
  if (await needsSetup()) redirect("/admin/setup");
  const { erro } = await searchParams;
  return (
    <div className={`${s.root} ${s.auth}`}>
      <header className={s.authTop}>
        <span className={s.brand}>
          <BrandLogo />
        </span>
      </header>
      <main className={s.authBody}>
        <Art name="cadeado" size={120} className={s.authArt} />
        <h1>Entrar no painel</h1>
        <p className={s.authLead}>Acompanhe vendas, libere Pix e configure sua loja.</p>
        <div className={s.authCard}>
          <form action={loginAction}>
            {erro ? (
              <div className={s.banner} data-tone="danger" role="alert">
                <PIcon name="circle-alert" />
                <div>E-mail ou senha inválidos.</div>
              </div>
            ) : null}
            <label className={s.field}>
              <span className={s.label}>E-mail</span>
              <input className={s.input} name="email" type="email" autoComplete="username" required maxLength={254} autoFocus />
            </label>
            <label className={s.field}>
              <span className={s.label}>Senha</span>
              <input className={s.input} name="password" type="password" autoComplete="current-password" required maxLength={256} />
            </label>
            <button type="submit" className={`${s.btn} ${s.btnPrimary} ${s.btnLg} ${s.btnBlock}`}>
              Entrar
            </button>
          </form>
        </div>
        <p className={s.hint} style={{ marginTop: 18, textAlign: "center", maxWidth: 400 }}>
          Esqueceu a senha? Peça ao dono da loja ou ao administrador da instalação.
        </p>
      </main>
      <footer className={s.authFoot}>
        <span>PingaPay · plataforma de vendas de código aberto</span>
      </footer>
    </div>
  );
}
