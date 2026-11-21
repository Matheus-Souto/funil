import { redirect } from "next/navigation";
import { needsSetup } from "@/lib/stores";
import { setupAction } from "../actions";
import { PIcon } from "../icons";
import { Art } from "../blocks";
import { BrandLogo } from "../brand";
import s from "../panel.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Configuração inicial" };

const STEPS = [
  { t: "Sua loja", d: "Nome da loja e seu acesso" },
  { t: "Como receber", d: "Pix manual ou Asaas" },
  { t: "Seu produto", d: "Envie o PDF" },
  { t: "Primeira oferta", d: "Preço e link do checkout" },
];

// P02 Configuração inicial (o passo 1 é aqui; os passos 2 a 4 seguem no painel, guiados por "Primeiros passos").
export default async function SetupPage({ searchParams }: { searchParams: Promise<{ erro?: string }> }) {
  if (!(await needsSetup())) redirect("/admin/login");
  const { erro } = await searchParams;
  return (
    <div className={`${s.root} ${s.auth}`}>
      <header className={s.authTop} data-bar="true">
        <span className={s.brand} aria-label="PingaPay">
          <BrandLogo />
        </span>
        <span className={s.muted}>Dá para mudar tudo depois em Configurações</span>
      </header>
      <main className={s.setup}>
        <div>
          <span className={s.eyebrow}>Configuração inicial</span>
          <Art name="produto" size={120} className={s.authArt} />
          <h1>Sua loja pronta para vender em 4 passos</h1>
          <ol className={s.wizard}>
            {STEPS.map((x, i) => (
              <li key={x.t} aria-current={i === 0 ? "step" : undefined}>
                <span>{i + 1}</span>
                <div>
                  <b>{x.t}</b>
                  <small>{x.d}</small>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <section className={s.setupCard} aria-labelledby="setup-titulo">
          <h2 id="setup-titulo">Crie sua loja</h2>
          <p className={s.muted} style={{ margin: 0 }}>
            Você será o dono da loja. Depois disso, o painel guia os próximos passos.
          </p>
          <form action={setupAction}>
            {erro === "codigo" ? (
              <div className={s.banner} data-tone="danger" role="alert">
                <PIcon name="circle-alert" />
                <div>Código de configuração inválido. Copie de novo do log do servidor.</div>
              </div>
            ) : erro ? (
              <div className={s.banner} data-tone="danger" role="alert">
                <PIcon name="circle-alert" />
                <div>Confira os dados. A senha precisa ter no mínimo 10 caracteres.</div>
              </div>
            ) : null}
            <div className={s.field}>
              <label className={s.field}>
                <span className={s.label}>Código de configuração</span>
                <input className={`${s.input} ${s.mono}`} name="setupToken" autoComplete="off" spellCheck={false} required maxLength={200} />
              </label>
              <span className={s.hint}>
                Está no log do servidor: <code>docker compose logs app | grep configuração</code>. Protege este primeiro acesso.
              </span>
            </div>
            <label className={s.field}>
              <span className={s.label}>Nome da loja</span>
              <input className={s.input} name="storeName" required maxLength={100} />
            </label>
            <div className={s.grid2}>
              <label className={s.field}>
                <span className={s.label}>Seu nome</span>
                <input className={s.input} name="name" autoComplete="name" required maxLength={100} />
              </label>
              <label className={s.field}>
                <span className={s.label}>E-mail</span>
                <input className={s.input} name="email" type="email" autoComplete="username" required maxLength={254} />
              </label>
            </div>
            <label className={s.field}>
              <span className={s.label}>Senha (mínimo 10 caracteres)</span>
              <input className={s.input} name="password" type="password" autoComplete="new-password" minLength={10} maxLength={256} required />
            </label>
            <div className={s.formActions} style={{ borderTop: "1px solid var(--color-border)", paddingTop: 18 }}>
              <button type="submit" className={`${s.btn} ${s.btnPrimary} ${s.btnLg}`}>
                Criar loja
              </button>
            </div>
          </form>
        </section>
      </main>
    </div>
  );
}
