import { runAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { getPanelIdentity, requirePanelActor } from "@/lib/auth/session";
import { connectionsStatus } from "@/lib/connections";
import { Art, Notice, PageHead } from "../../blocks";
import s from "../../panel.module.css";
import { AsaasCard, MetaCard, PixManualCard, ResendCard, SmtpCard, TelegramCard } from "./cards";

export const dynamic = "force-dynamic";
export const metadata = { title: "Conexões" };

export default async function ConnectionsPage() {
  const panel = await requirePanelActor();
  const st = await runAction(connectionsStatus, { ...panel, origin: "panel" }, {});
  const role = panel.actor.role;
  const canWrite = hasPermission(role, "connections.write");
  // Pixel/token da loja: só o dono (connections.write); o tráfego só testa a conexão.
  const canTestMeta = hasPermission(role, "tracking.write");
  const { userEmail, storeName } = await getPanelIdentity(panel);
  return (
    <>
      <PageHead title="Conexões" />
      {!st.emailUsable || st.turnstile.recommended ? (
        <div className={s.noticeStrip}>
          {st.emailUsable ? null : (
            <Notice tone="danger" alert>
              <b>Nenhum e-mail configurado:</b> os acessos e os avisos de venda vão falhar. Ative o SMTP ou o Resend.
            </Notice>
          )}
          {st.turnstile.recommended ? (
            <Notice
              tone="warning"
              title="A loja vende com cartão e o servidor está sem Turnstile. Com muitas recusas de cartão em pouco tempo, cada comprador fica limitado a 3 tentativas por hora em vez de passar pela verificação. Quem instalou o servidor define TURNSTILE_SITE_KEY e TURNSTILE_SECRET no .env (docs/instalacao.md)."
            >
              <b>Recomendado:</b> ative a verificação anti-robô (Cloudflare Turnstile) no servidor.
            </Notice>
          ) : null}
        </div>
      ) : null}
      <div className={s.connGroups}>
        <section className={`${s.card} ${s.cardFlush}`} aria-labelledby="conn-receber">
          <header className={s.connGroupHead}>
            <Art name="carteira" size={32} className={s.connGroupArt} />
            <h2 id="conn-receber">Como receber</h2>
          </header>
          <PixManualCard data={st.pixManual} canWrite={canWrite} />
          <AsaasCard data={st.asaas} canWrite={canWrite} />
        </section>
        <section className={`${s.card} ${s.cardFlush}`} aria-labelledby="conn-email">
          <header className={s.connGroupHead}>
            <Art name="email" size={32} className={s.connGroupArt} />
            <h2 id="conn-email">E-mail para o comprador</h2>
            <span className={s.connGroupHint}>Basta um dos dois</span>
          </header>
          <SmtpCard data={st.smtp} canWrite={canWrite} defaultTo={userEmail} active={st.emailProvider === "smtp"} usable={st.emailUsable} />
          <ResendCard data={st.resend} canWrite={canWrite} defaultTo={userEmail} storeName={storeName} active={st.emailProvider === "resend"} usable={st.emailUsable} />
        </section>
        <section className={`${s.card} ${s.cardFlush}`} aria-labelledby="conn-avisos">
          <header className={s.connGroupHead}>
            <Art name="avisos" size={32} className={s.connGroupArt} />
            <h2 id="conn-avisos">Rastreamento e avisos</h2>
          </header>
          <MetaCard data={st.meta} canWrite={canWrite} canTest={canTestMeta} />
          <TelegramCard data={st.telegram} canWrite={canWrite} />
        </section>
      </div>
    </>
  );
}
