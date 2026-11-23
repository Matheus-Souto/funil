"use client";

// Configurações em abas (as do Arc): Loja, Checkout, Contatos e recuperação (um formulário só, salvo de uma vez), Página
// de vendas e Entrega (conteúdo do servidor). Cada ajuste é uma linha: título e explicação à esquerda, controle à
// direita. Trocar de aba não perde o que foi digitado (o estado vive aqui); a barra de salvar aparece quando há alteração.
// A aba fica no endereço (?aba=), para links diretos (ex.: o aviso de Contatos abre ?aba=contatos).
// A cor do checkout usa o seletor de cores do Arc, com prévia ao vivo e o contraste do texto do botão (a mesma regra AA
// do checkout: src/lib/brand.ts).
import { useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { z } from "zod";
import { ColorPicker } from "@/components/arc/color-picker/color-picker";
import { Switch } from "@/components/arc/switch/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/arc/tabs/tabs";
import { brandVars, DEFAULT_BRAND } from "@/lib/brand";
import { useLeaveGuard } from "../../leave-guard";
import s from "../../panel.module.css";
import { Live, useActionRunner } from "../../ui";
import { updateSettingsAction } from "../actions";
import { SETTINGS_TABS, type SettingsTab } from "./tabs";

const HEX = /^#[0-9a-f]{6}$/i;
const DEFAULT_COLOR = DEFAULT_BRAND["--color-brand"];
const SWATCHES = [DEFAULT_COLOR, "#3E8114", "#2F6BFF", "#7C3AED", "#E11D48", "#F59E0B"].map((color) => ({ id: color, color }));

interface Initial {
  name: string;
  notifyEmail: string;
  brandColor: string | null;
  leadCapture: boolean;
  privacyEmail: string;
  recovery: { on: boolean; lead: boolean; pix: boolean; card: boolean };
}

const formOf = (i: Initial) => ({ name: i.name, notifyEmail: i.notifyEmail, color: i.brandColor ?? "", leadCapture: i.leadCapture, privacyEmail: i.privacyEmail, recovery: i.recovery });

// A mesma regra do servidor (src/lib/store-settings.ts: trim, minúsculas e z.email): o que passa aqui não volta recusado.
const EMAIL = z.email();
const emailOk = (v: string) => EMAIL.safeParse(v.trim().toLowerCase()).success;

/** Aba de cada campo de updateStoreSettings, para levar até o erro que vem do servidor. */
const TAB_OF_FIELD: Record<string, SettingsTab> = {
  name: "loja",
  notifyEmail: "loja",
  brandColor: "checkout",
  leadCapture: "contatos",
  privacyEmail: "contatos",
  recovery: "contatos",
};

/** Primeiro problema do formulário e a aba onde ele está (a mesma regra que o servidor confere). */
function problemOf(f: ReturnType<typeof formOf>, colorOk: boolean): { tab: SettingsTab; text: string } | null {
  if (!f.name.trim()) return { tab: "loja", text: "Informe o nome da loja." };
  if (f.notifyEmail.trim() && !emailOk(f.notifyEmail)) return { tab: "loja", text: "O e-mail para aviso de venda parece inválido." };
  if (!colorOk) return { tab: "checkout", text: "Use uma cor no formato #RRGGBB." };
  if (f.leadCapture && !f.privacyEmail.trim()) return { tab: "contatos", text: "Com a captura ligada, informe o e-mail para pedidos de privacidade." };
  if (f.privacyEmail.trim() && !emailOk(f.privacyEmail)) return { tab: "contatos", text: "O e-mail para pedidos de privacidade parece inválido." };
  return null;
}

/** Título e explicação de uma linha de ajuste; os ids ligam o texto ao controle (leitor de tela). */
function SetText({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <div className={s.setText}>
      <h3 id={`${id}-t`}>{title}</h3>
      <p id={`${id}-d`}>{children}</p>
    </div>
  );
}

export function SettingsPanel({
  initial,
  canWrite,
  initialTab,
  script,
  delivery,
}: {
  initial: Initial;
  canWrite: boolean;
  initialTab: SettingsTab;
  script: ReactNode;
  delivery: ReactNode;
}) {
  const id = useId();
  const tabs = SETTINGS_TABS;
  const [tab, setTab] = useState<SettingsTab>(tabs.some(([k]) => k === initialTab) ? initialTab : "loja");
  const [f, setF] = useState(() => formOf(initial));
  // Depois de salvar, a página volta do servidor com os valores novos: o formulário passa a compará-los com eles.
  const [saved, setSaved] = useState(() => formOf(initial));
  const [seen, setSeen] = useState(initial);
  // O que foi enviado: se a pessoa não mexeu depois de salvar, o formulário passa a mostrar o que o servidor gravou (ele
  // normaliza, ex.: e-mail em minúsculas), senão a barra de "alterações não salvas" ficaria presa.
  const [submitted, setSubmitted] = useState<string | null>(null);
  if (initial !== seen) {
    setSeen(initial);
    setSaved(formOf(initial));
    if (submitted !== null && submitted === JSON.stringify(f)) setF(formOf(initial));
    setSubmitted(null);
  }
  const dirty = JSON.stringify({ ...f, name: f.name.trim(), notifyEmail: f.notifyEmail.trim(), privacyEmail: f.privacyEmail.trim() }) !== JSON.stringify(saved);
  const run = useActionRunner();
  const leaveGuard = useLeaveGuard(canWrite && dirty, "As alterações das configurações ainda não foram salvas.");
  const valid = f.color === "" || HEX.test(f.color);
  const vars = useMemo(() => brandVars(valid && f.color ? f.color : null), [f.color, valid]);
  const strongChanged = vars["--color-brand-strong"] !== vars["--color-brand"];
  const setRecovery = (patch: Partial<Initial["recovery"]>) => setF({ ...f, recovery: { ...f.recovery, ...patch } });

  const go = (k: string) => {
    if (!tabs.some(([t]) => t === k)) return;
    setTab(k as SettingsTab);
    const url = new URL(window.location.href);
    url.searchParams.set("aba", k);
    window.history.replaceState(null, "", url);
  };

  return (
    <form
      id="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        // Só a aba aberta fica montada, então a validação do navegador não alcança as outras: confere aqui e leva à aba.
        const problem = problemOf(f, valid);
        if (problem) {
          go(problem.tab);
          run.setMsg({ tone: "error", text: problem.text });
          return;
        }
        setSubmitted(JSON.stringify(f));
        void run
          .run(() =>
            updateSettingsAction({
              name: f.name.trim(),
              notifyEmail: f.notifyEmail.trim() || null,
              brandColor: f.color ? f.color.toUpperCase() : null,
              leadCapture: f.leadCapture,
              privacyEmail: f.privacyEmail.trim() || null,
              recovery: f.recovery,
            }),
          )
          .then((r) => {
            // Erro do servidor num campo de outra aba (ex.: "Conecte o e-mail da loja em Conexões" salvando da aba Loja):
            // leva à aba do campo, onde a mensagem faz sentido.
            const to = !r.ok && r.field ? TAB_OF_FIELD[r.field.split(".")[0]!] : undefined;
            if (to) go(to);
          });
      }}
    >
      <Tabs value={tab} onValueChange={go}>
        <TabsList aria-label="Seções das configurações">
          {tabs.map(([k, label]) => (
            <TabsTrigger key={k} value={k}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="loja">
          <fieldset disabled={!canWrite} className={`${s.settingsFieldset} ${s.setCard}`}>
            <div className={s.setRow}>
              <SetText id={`${id}-nome`} title="Nome da loja">
                Aparece no checkout, na página de obrigado e nos e-mails.
              </SetText>
              <input className={s.input} value={f.name} required maxLength={100} aria-labelledby={`${id}-nome-t`} aria-describedby={`${id}-nome-d`} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </div>
            <div className={s.setRow}>
              <SetText id={`${id}-aviso`} title="E-mail para aviso de venda">
                Recebe um aviso a cada venda paga e os alertas da loja.
              </SetText>
              <input
                className={s.input}
                type="email"
                value={f.notifyEmail}
                maxLength={254}
                placeholder="voce@sualoja.com.br"
                aria-labelledby={`${id}-aviso-t`} aria-describedby={`${id}-aviso-d`}
                onChange={(e) => setF({ ...f, notifyEmail: e.target.value })}
              />
            </div>
          </fieldset>
        </TabsContent>

        <TabsContent value="checkout">
          <fieldset disabled={!canWrite} className={`${s.settingsFieldset} ${s.setCard} ${s.setCheckout}`}>
            <div className={s.setColor}>
              <SetText id={`${id}-cor`} title="Cor da loja">
                Botões e destaques do checkout. Se a cor tiver pouco contraste (ex.: amarelo), o texto do botão escurece sozinho e os links usam uma
                versão mais escura{strongChanged ? ` (aqui: ${vars["--color-brand-strong"]})` : ""}.
              </SetText>
              <ColorPicker
                value={valid && f.color ? f.color : DEFAULT_COLOR}
                onValueChange={(hex) => setF({ ...f, color: hex.slice(0, 7).toUpperCase() })}
                label="Cor da loja"
                background={vars["--color-on-brand"]}
                alpha={false}
                contrastLabel="com o texto do botão"
                defaultSwatches={SWATCHES}
              />
              {f.color ? (
                <button type="button" className={s.linkBtn} style={{ fontSize: 13 }} onClick={() => setF({ ...f, color: "" })}>
                  Voltar à cor padrão
                </button>
              ) : null}
            </div>
            <div className={s.setMock} style={vars as CSSProperties} aria-label="Prévia do checkout" role="img">
              <b>{f.name.trim() || "Sua loja"}</b>
              <span>Produto de exemplo · Pix</span>
              <span className={s.setMockBtn}>Gerar Pix de R$ 9,90</span>
              <span className={s.setMockLink}>Link e destaque na cor da loja</span>
            </div>
          </fieldset>
        </TabsContent>

        <TabsContent value="contatos">
          <fieldset disabled={!canWrite} className={`${s.settingsFieldset} ${s.setCard}`}>
            <div className={s.setRowSwitch}>
              <SetText id={`${id}-captura`} title="Guardar o contato de quem não finaliza a compra">
                E-mail e celular ficam por até 30 dias, com aviso no checkout. Exige o e-mail para pedidos de privacidade.
              </SetText>
              <Switch
                checked={f.leadCapture}
                onCheckedChange={(v) => setF({ ...f, leadCapture: v })}
                aria-labelledby={`${id}-captura-t`}
                aria-describedby={`${id}-captura-d`}
              />
            </div>
            <div className={s.setRow}>
              <SetText id={`${id}-priv`} title="E-mail para pedidos de privacidade">
                {f.leadCapture ? "Obrigatório com a captura ligada. " : ""}Aparece no aviso de privacidade do checkout.
              </SetText>
              <input
                className={s.input}
                type="email"
                value={f.privacyEmail}
                maxLength={254}
                required={f.leadCapture}
                placeholder="privacidade@sualoja.com.br"
                aria-labelledby={`${id}-priv-t`} aria-describedby={`${id}-priv-d`}
                onChange={(e) => setF({ ...f, privacyEmail: e.target.value })}
              />
            </div>
            <div className={s.setRowSwitch}>
              <SetText id={`${id}-rec`} title="Recuperação de vendas por e-mail">
                Um lembrete por compra, pelo e-mail da loja (Conexões), com link para a pessoa não receber mais.
              </SetText>
              <Switch checked={f.recovery.on} onCheckedChange={(v) => setRecovery({ on: v })} aria-labelledby={`${id}-rec-t`} aria-describedby={`${id}-rec-d`} />
            </div>
            {f.recovery.on ? (
              <div className={s.setSub} role="group" aria-label="Quando mandar o lembrete">
                <div className={s.setSubRow}>
                  <span id={`${id}-rl`}>
                    Digitou o e-mail e saiu antes do pedido
                    <small>Precisa da captura de contato ligada.</small>
                  </span>
                  <Switch checked={f.recovery.lead} onCheckedChange={(v) => setRecovery({ lead: v })} aria-labelledby={`${id}-rl`} />
                </div>
                <div className={s.setSubRow}>
                  <span id={`${id}-rp`}>Pix gerado e não pago</span>
                  <Switch checked={f.recovery.pix} onCheckedChange={(v) => setRecovery({ pix: v })} aria-labelledby={`${id}-rp`} />
                </div>
                <div className={s.setSubRow}>
                  <span id={`${id}-rc`}>Cartão recusado</span>
                  <Switch checked={f.recovery.card} onCheckedChange={(v) => setRecovery({ card: v })} aria-labelledby={`${id}-rc`} />
                </div>
              </div>
            ) : null}
          </fieldset>
        </TabsContent>

        <TabsContent value="pagina">{script}</TabsContent>
        <TabsContent value="entrega">{delivery}</TabsContent>
      </Tabs>

      {!canWrite && (tab === "loja" || tab === "checkout" || tab === "contatos") ? <p className={s.hint}>Só o dono da loja altera estes dados.</p> : null}
      {canWrite && dirty ? (
        <div className={`${s.saveBar} ${s.saveBarSimple}`} role="region" aria-label="Alterações não salvas">
          <span>Alterações não salvas</span>
          <button
            type="button"
            className={s.btn}
            onClick={() => {
              setF(saved);
              // A mensagem era sobre o que foi descartado: sai junto.
              run.setMsg(null);
            }}
            disabled={run.pending}
          >
            Descartar
          </button>
          <button type="submit" className={`${s.btn} ${s.btnPrimary}`} disabled={run.pending}>
            {run.pending ? "Salvando…" : "Salvar alterações"}
          </button>
        </div>
      ) : null}
      <Live msg={run.msg} />
      {leaveGuard}
    </form>
  );
}
