import { runAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { getPanelIdentity, requirePanelActor } from "@/lib/auth/session";
import { connectionsStatus } from "@/lib/connections";
import { dateTimeSP } from "@/lib/format";
import { listMcpTokens } from "@/lib/mcp/tokens";
import { getStoreSettings } from "@/lib/store-settings";
import { Art, Notice, PageHead } from "../../blocks";
import s from "../../panel.module.css";
import { AppCard, AsaasCard, MetaCard, PixManualCard, ResendCard, SmtpCard, TelegramCard, type IntegrationKeyRow } from "./cards";

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
  // Chaves da API de integração: tokens `integration`, só para quem gerencia tokens (team.manage, o dono).
  const canManageKeys = hasPermission(role, "team.manage");
  const ctx = { ...panel, origin: "panel" as const };
  const [keyList, settings] = await Promise.all([canManageKeys ? runAction(listMcpTokens, ctx, { kind: "integration" }) : [], runAction(getStoreSettings, ctx, {})]);
  const keys: IntegrationKeyRow[] = keyList.map((k) => ({
    id: k.id,
    name: k.name,
    last4: k.last4,
    createdAt: dateTimeSP(k.createdAt),
    lastUsedAt: k.lastUsedAt ? dateTimeSP(k.lastUsedAt) : null,
    revokedAt: k.revokedAt ? dateTimeSP(k.revokedAt) : null,
  }));
  const apiBaseUrl = `${settings.checkoutBaseUrl.replace(/\/+$/, "")}/api/integracao/v1`;
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
            <Notice tone="warning">
              <b>Recomendado:</b> ative a verificação anti-robô (Cloudflare Turnstile). Sem ela, com muitas recusas de cartão em
              pouco tempo, cada comprador fica limitado a 3 tentativas por hora. Quem instalou o servidor define TURNSTILE_SITE_KEY e
              TURNSTILE_SECRET no .env (docs/instalacao.md).
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
        <section className={`${s.card} ${s.cardFlush}`} aria-labelledby="conn-app">
          <header className={s.connGroupHead}>
            <Art name="cadeado" size={32} className={s.connGroupArt} />
            <h2 id="conn-app">App com conta de usuário</h2>
          </header>
          <AppCard data={st.app} canWrite={canWrite} canManageKeys={canManageKeys} keys={keys} apiBaseUrl={apiBaseUrl} />
        </section>
      </div>
    </>
  );
}
