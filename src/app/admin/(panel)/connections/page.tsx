import { runAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { getPanelIdentity, requirePanelActor } from "@/lib/auth/session";
import { connectionsStatus } from "@/lib/connections";
import { PageHead } from "../../blocks";
import { PIcon } from "../../icons";
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
      {st.emailUsable ? null : (
        <div className={s.alerts}>
          <div className={s.banner} data-tone="danger" role="alert" id="email-inutilizavel">
            <PIcon name="mail" />
            <div>
              <b>Nenhum provedor de e-mail utilizável: os e-mails de acesso e os avisos de venda vão falhar.</b>
              <p>Configure o SMTP ou o Resend em Conexões e ative um deles.</p>
            </div>
          </div>
        </div>
      )}
      {st.turnstile.recommended ? (
        <div className={s.alerts}>
          <div className={s.banner} role="note" id="turnstile-recomendado">
            <PIcon name="triangle-alert" />
            <div>
              <b>Recomendado: configure a verificação anti-robô (Cloudflare Turnstile).</b>
              <p>
                A loja vende com cartão e o servidor está sem Turnstile. Com muitas recusas de cartão em pouco tempo, cada
                comprador fica limitado a 3 tentativas por hora em vez de passar pela verificação. Quem instalou o servidor
                define TURNSTILE_SITE_KEY e TURNSTILE_SECRET no .env (docs/instalacao.md).
              </p>
            </div>
          </div>
        </div>
      ) : null}
      <div className={s.connGroups}>
        <section className={s.connGroup} aria-labelledby="conn-receber">
          <div className={s.connGroupHead}>
            <h2 id="conn-receber">Como receber</h2>
            <p>Para onde vai o dinheiro de cada venda.</p>
          </div>
          <div className={s.connGroupGrid}>
            <PixManualCard data={st.pixManual} canWrite={canWrite} />
            <AsaasCard data={st.asaas} canWrite={canWrite} />
          </div>
        </section>
        <section className={s.connGroup} aria-labelledby="conn-email">
          <div className={s.connGroupHead}>
            <h2 id="conn-email">E-mail para o comprador</h2>
            <p>Leva o link de download e os avisos de venda. Basta um dos dois.</p>
          </div>
          <div className={s.connGroupGrid}>
            <SmtpCard data={st.smtp} canWrite={canWrite} defaultTo={userEmail} active={st.emailProvider === "smtp"} usable={st.emailUsable} />
            <ResendCard data={st.resend} canWrite={canWrite} defaultTo={userEmail} storeName={storeName} active={st.emailProvider === "resend"} usable={st.emailUsable} />
          </div>
        </section>
        <section className={s.connGroup} aria-labelledby="conn-avisos">
          <div className={s.connGroupHead}>
            <h2 id="conn-avisos">Rastreamento e avisos</h2>
            <p>Eventos para os anúncios do Meta e avisos da loja no Telegram.</p>
          </div>
          <div className={s.connGroupGrid}>
            <MetaCard data={st.meta} canWrite={canWrite} canTest={canTestMeta} />
            <TelegramCard data={st.telegram} canWrite={canWrite} />
          </div>
        </section>
      </div>
    </>
  );
}
