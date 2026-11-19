import { runAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { requirePanelActor } from "@/lib/auth/session";
import { getStoreSettings } from "@/lib/store-settings";
import { PageHead } from "../../blocks";
import { PIcon } from "../../icons";
import s from "../../panel.module.css";
import { CopyButton } from "../../ui";
import { SettingsForm } from "./form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Configurações" };

export default async function SettingsPage() {
  const panel = await requirePanelActor();
  const st = await runAction(getStoreSettings, { ...panel, origin: "panel" }, {});
  const canWrite = hasPermission(panel.actor.role, "connections.write");
  const host = new URL(st.checkoutBaseUrl).host;
  return (
    <>
      <PageHead title="Configurações" sub="Dados da loja, aparência do checkout e integração com a página de vendas." />
      <SettingsForm initial={{ name: st.name, notifyEmail: st.notifyEmail ?? "", brandColor: st.brandColor }} canWrite={canWrite} />

      <div className={s.settingsRow} id="script">
        <div>
          <h2 className={s.sectionTitle}>Script da página de vendas</h2>
          <p>
            Cole antes do <code className={s.mono}>&lt;/body&gt;</code> da sua página. Ele leva UTMs, fbclid e <code className={s.mono}>?ref=</code> para os
            links do checkout, assim as vendas aparecem por origem e indicação.
          </p>
        </div>
        <section className={s.card}>
          <pre className={s.codeBlock} aria-label="Script do t.js">
            {st.trackingSnippet}
          </pre>
          <div className={s.formActions} style={{ marginTop: 12 }}>
            <CopyButton text={st.trackingSnippet} label="Copiar script" />
          </div>
          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>Página de vendas hospedada na Cloudflare (Pages)</summary>
            <ol className={s.checklist}>
              <li>
                No projeto da página (Cloudflare Pages), abra o <code className={s.mono}>index.html</code> e cole o script logo antes de{" "}
                <code className={s.mono}>&lt;/body&gt;</code>. Publique de novo (deploy).
              </li>
              <li>
                Os botões de compra precisam apontar para o checkout: <code className={s.mono}>https://{host}/c/&lt;endereço-da-oferta&gt;</code>. O script só
                completa links desse endereço.
              </li>
              <li>
                Se o Rocket Loader estiver ligado (Speed → Optimization), acrescente <code className={s.mono}>data-cfasync=&quot;false&quot;</code> à tag{" "}
                <code className={s.mono}>&lt;script&gt;</code> para ele não adiar o script.
              </li>
              <li>
                Para conferir: abra a página com <code className={s.mono}>?utm_source=teste</code> e passe o mouse no botão de compra; o link deve levar o{" "}
                <code className={s.mono}>utm_source=teste</code>.
              </li>
            </ol>
          </details>
        </section>
      </div>

      <div className={s.settingsRow}>
        <div>
          <h2 className={s.sectionTitle}>Entrega</h2>
          <p>Regras do link pessoal de download.</p>
        </div>
        <section className={s.card}>
          <div className={s.rows}>
            <div className={s.row}>
              <span>Validade do link</span>
              <span>30 dias</span>
            </div>
            <div className={s.row}>
              <span>Limite de downloads</span>
              <span>5</span>
            </div>
          </div>
          <p className={s.hint} style={{ display: "flex", gap: 6, alignItems: "center", margin: "10px 0 0" }}>
            <PIcon name="info" size={14} />
            Reembolso ou contestação desativa o link na hora. Em Pedidos, “Reenviar acesso” pode gerar links novos.
          </p>
        </section>
      </div>
    </>
  );
}
