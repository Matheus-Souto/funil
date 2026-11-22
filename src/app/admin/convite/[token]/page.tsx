import type { Metadata } from "next";
import { headers } from "next/headers";
import { runAction } from "@/lib/actions/core";
import { dateTimeSP } from "@/lib/format";
import { resolveStore } from "@/lib/stores";
import { inviteInfo } from "@/lib/team/accept";
import { Art } from "../../blocks";
import { BrandLogo } from "../../brand";
import s from "../../panel.module.css";
import { AcceptForm } from "./accept-form";
import { GONE_TEXT } from "./texts";

export const dynamic = "force-dynamic";
// O token vai no caminho: sem Referer (o next.config.ts também manda o cabeçalho) e fora dos buscadores.
export const metadata: Metadata = { title: "Convite para a equipe", referrer: "no-referrer", robots: { index: false, follow: false } };

// Aceite do convite da equipe (spec "Equipe e convites", seção 6). Fora do grupo (panel), como o login: abre sem sessão.
// O GET só lê (`team.inviteInfo`); quem aceita é o POST do formulário. Token inválido de qualquer tipo mostra a mesma
// mensagem, para a página não dizer se um token existe.
export default async function InvitePage({ params }: { params: Promise<{ token?: string }> }) {
  const { token = "" } = await params;
  const found = await resolveStore((await headers()).get("host") ?? "");
  const info = found ? await runAction(inviteInfo, { storeId: found.id, actor: { kind: "public" }, origin: "public" }, { token: token.slice(0, 200) }) : null;
  return (
    <div className={`${s.root} ${s.auth}`}>
      <header className={s.authTop}>
        <span className={s.brand} aria-label="PingaPay">
          <BrandLogo />
        </span>
      </header>
      <main className={s.authBody}>
        <Art name={info ? "email" : "cadeado"} size={120} className={s.authArt} />
        {info ? (
          <>
            <h1>
              {info.storeName} convidou você como {info.roleLabel}
            </h1>
            <p className={s.authLead}>O convite vale até {dateTimeSP(info.expiresAt)}.</p>
            <AcceptForm token={token} email={info.email} hasAccount={info.hasAccount} />
          </>
        ) : (
          <>
            <h1>Convite indisponível</h1>
            <p className={s.authLead}>{GONE_TEXT}</p>
          </>
        )}
      </main>
      <footer className={s.authFoot}>
        <span>PingaPay · plataforma de vendas de código aberto</span>
      </footer>
    </div>
  );
}
