import { runAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { getPanelIdentity, requirePanelActor } from "@/lib/auth/session";
import { connectionsStatus } from "@/lib/connections";
import { PageHead } from "../../blocks";
import s from "../../panel.module.css";
import { AsaasCard, MetaCard, PixManualCard, SmtpCard } from "./cards";

export const dynamic = "force-dynamic";
export const metadata = { title: "Conexões" };

export default async function ConnectionsPage() {
  const panel = await requirePanelActor();
  const st = await runAction(connectionsStatus, { ...panel, origin: "panel" }, {});
  const role = panel.actor.role;
  const canWrite = hasPermission(role, "connections.write");
  // Pixel/token da loja: só o dono (connections.write); o tráfego só testa a conexão.
  const canTestMeta = hasPermission(role, "tracking.write");
  const { userEmail } = await getPanelIdentity(panel);
  return (
    <>
      <PageHead title="Conexões" sub="Chaves e tokens ficam criptografados e nunca são exibidos de novo: só aparece “configurado”." />
      <div className={s.grid2} style={{ alignItems: "start" }}>
        <div className={s.stack}>
          <PixManualCard data={st.pixManual} canWrite={canWrite} />
          <SmtpCard data={st.smtp} canWrite={canWrite} defaultTo={userEmail} />
        </div>
        <div className={s.stack}>
          <AsaasCard data={st.asaas} canWrite={canWrite} />
          <MetaCard data={st.meta} canWrite={canWrite} canTest={canTestMeta} />
        </div>
      </div>
    </>
  );
}
