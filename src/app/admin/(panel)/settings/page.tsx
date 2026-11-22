import { runAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { listTeam } from "@/lib/auth/account";
import { requirePanelActor } from "@/lib/auth/session";
import { getStoreSettings } from "@/lib/store-settings";
import { Accordion } from "@/components/arc/accordion/accordion";
import { CopyButton } from "@/components/arc/copy-button/copy-button";
import { Art, PageHead } from "../../blocks";
import { PIcon } from "../../icons";
import { firstParam, type Param } from "@/lib/panel-params";
import s from "../../panel.module.css";
import { SettingsPanel } from "./form";
import { SETTINGS_TABS, type SettingsTab } from "./tabs";
import { TeamList } from "./team";

export const dynamic = "force-dynamic";
export const metadata = { title: "Configurações" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ aba?: Param }> }) {
  const panel = await requirePanelActor();
  const aba = firstParam((await searchParams).aba);
  const initialTab: SettingsTab = SETTINGS_TABS.find(([k]) => k === aba)?.[0] ?? "loja";
  const st = await runAction(getStoreSettings, { ...panel, origin: "panel" }, {});
  const canWrite = hasPermission(panel.actor.role, "connections.write");
  const team = hasPermission(panel.actor.role, "team.manage") ? await runAction(listTeam, { ...panel, origin: "panel" }, {}) : null;
  const host = new URL(st.checkoutBaseUrl).host;
  return (
    <>
      <PageHead title="Configurações" />
      <SettingsPanel
        initial={{ name: st.name, notifyEmail: st.notifyEmail ?? "", brandColor: st.brandColor, leadCapture: st.leadCapture, privacyEmail: st.privacyEmail ?? "", recovery: st.recovery }}
        canWrite={canWrite}
        initialTab={initialTab}
        script={
          <section className={s.setCard} id="script" aria-label="Script da página de vendas">
            <div className={s.setBody}>
              <div className={s.setText}>
                <h3>Script da página de vendas</h3>
                <p>
                  Cole antes do <code className={s.mono}>&lt;/body&gt;</code> da sua página. Ele leva UTMs, fbclid e <code className={s.mono}>?ref=</code> para os
                  links do checkout, assim as vendas aparecem por origem e indicação.
                </p>
              </div>
              <pre className={s.setCode} aria-label="Script do t.js">
                {st.trackingSnippet}
                <span className={s.setCodeCopy}>
                  <CopyButton value={st.trackingSnippet} label="Copiar script" iconOnly variant="plain" />
                </span>
              </pre>
              <Accordion
                defaultOpen={-1}
                items={[
                  {
                    title: "Página hospedada na Cloudflare (Pages)",
                    content: (
                      <ol className={s.setSteps}>
                        <li>
                          No projeto da página, abra o <code className={s.mono}>index.html</code> e cole o script logo antes de{" "}
                          <code className={s.mono}>&lt;/body&gt;</code>. Publique de novo (deploy).
                        </li>
                        <li>
                          Os botões de compra precisam apontar para o checkout: <code className={s.mono}>https://{host}/c/&lt;endereço-da-oferta&gt;</code>. O
                          script só completa links desse endereço.
                        </li>
                      </ol>
                    ),
                  },
                  {
                    title: "Rocket Loader ligado",
                    content: (
                      <p className={s.setSteps} style={{ paddingLeft: 0 }}>
                        Em Speed → Optimization, com o Rocket Loader ligado, acrescente <code className={s.mono}>data-cfasync=&quot;false&quot;</code> à tag{" "}
                        <code className={s.mono}>&lt;script&gt;</code> para ele não adiar o script.
                      </p>
                    ),
                  },
                  {
                    title: "Como conferir",
                    content: (
                      <p className={s.setSteps} style={{ paddingLeft: 0 }}>
                        Abra a página com <code className={s.mono}>?utm_source=teste</code> e passe o mouse no botão de compra: o link deve levar o{" "}
                        <code className={s.mono}>utm_source=teste</code>.
                      </p>
                    ),
                  },
                ]}
              />
            </div>
          </section>
        }
        team={
          team ? (
            <div id="equipe">
              <p className={s.setIntro}>
                Quem acessa o painel da loja. Encerrar as sessões tira a pessoa do painel em todos os aparelhos. Para trocar a sua senha, use{" "}
                <a href="/admin/senha">Trocar senha</a>.
              </p>
              <TeamList members={team.members} />
            </div>
          ) : null
        }
        delivery={
          <div>
            <p className={s.setIntro}>Regras do link pessoal de download.</p>
            <div className={s.setStats}>
              <div className={s.setStat}>
                <Art name="pdf" size={48} />
                <div>
                  <small>Validade do link</small>
                  <b>30 dias</b>
                </div>
              </div>
              <div className={s.setStat}>
                <Art name="pedidos" size={48} />
                <div>
                  <small>Limite de downloads</small>
                  <b>5 por link</b>
                </div>
              </div>
            </div>
            <p className={s.setNote}>
              <PIcon name="info" size={14} />
              Reembolso ou contestação desativa o link na hora. Em Pedidos, “Reenviar acesso” pode gerar links novos.
            </p>
          </div>
        }
      />
    </>
  );
}
