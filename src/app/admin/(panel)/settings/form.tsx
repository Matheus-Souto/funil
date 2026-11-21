"use client";

// Configurações em abas: Loja, Checkout, Contatos e recuperação (um formulário só, salvo de uma vez), Página de vendas,
// Equipe e Entrega (conteúdo do servidor). Trocar de aba não perde o que foi digitado; a barra de salvar aparece quando
// há alteração. A aba fica no endereço (?aba=), para links diretos (ex.: o aviso de Contatos abre ?aba=contatos).
// A cor do checkout tem prévia ao vivo do contraste (a mesma regra AA do checkout: src/lib/brand.ts).
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { brandVars, contrastRatio, DEFAULT_BRAND } from "@/lib/brand";
import { PIcon } from "../../icons";
import s from "../../panel.module.css";
import { Live, useActionRunner } from "../../ui";
import { updateSettingsAction } from "../actions";
import { SETTINGS_TABS, type SettingsTab } from "./tabs";

const HEX = /^#[0-9a-f]{6}$/i;
const ratio = (n: number) => `${n.toFixed(1).replace(".", ",")}:1`;
const TEXT_NAME: Record<string, string> = { "#FFFFFF": "Texto branco", "#15201B": "Texto escuro", "#000000": "Texto preto" };


interface Initial {
  name: string;
  notifyEmail: string;
  brandColor: string | null;
  leadCapture: boolean;
  privacyEmail: string;
  recovery: { on: boolean; lead: boolean; pix: boolean; card: boolean };
}

const formOf = (i: Initial) => ({ name: i.name, notifyEmail: i.notifyEmail, color: i.brandColor ?? "", leadCapture: i.leadCapture, privacyEmail: i.privacyEmail, recovery: i.recovery });

export function SettingsPanel({
  initial,
  canWrite,
  initialTab,
  script,
  team,
  delivery,
}: {
  initial: Initial;
  canWrite: boolean;
  initialTab: SettingsTab;
  script: ReactNode;
  /** Só para quem gerencia a equipe; sem isso a aba não aparece. */
  team: ReactNode | null;
  delivery: ReactNode;
}) {
  const tabs = SETTINGS_TABS.filter(([k]) => k !== "equipe" || team);
  const [tab, setTab] = useState<SettingsTab>(tabs.some(([k]) => k === initialTab) ? initialTab : "loja");
  const [f, setF] = useState(() => formOf(initial));
  // Depois de salvar, a página volta do servidor com os valores novos: o formulário passa a compará-los com eles.
  const [saved, setSaved] = useState(() => formOf(initial));
  const [seen, setSeen] = useState(initial);
  if (initial !== seen) {
    setSeen(initial);
    setSaved(formOf(initial));
  }
  const dirty = JSON.stringify({ ...f, name: f.name.trim(), notifyEmail: f.notifyEmail.trim(), privacyEmail: f.privacyEmail.trim() }) !== JSON.stringify(saved);
  const run = useActionRunner();
  const valid = f.color === "" || HEX.test(f.color);
  const vars = useMemo(() => brandVars(valid && f.color ? f.color : null), [f.color, valid]);
  const on = vars["--color-on-brand"];
  const r = contrastRatio(on, vars["--color-brand"]);
  const strongChanged = vars["--color-brand-strong"] !== vars["--color-brand"];

  const go = (k: SettingsTab) => {
    setTab(k);
    const url = new URL(window.location.href);
    url.searchParams.set("aba", k);
    window.history.replaceState(null, "", url);
  };

  return (
    <>
      <nav className={s.settingsTabs} role="tablist" aria-label="Seções das configurações">
        {tabs.map(([k, label]) => (
          <button key={k} type="button" role="tab" id={`aba-${k}`} aria-selected={tab === k} aria-controls={`painel-${k}`} onClick={() => go(k)}>
            {label}
          </button>
        ))}
      </nav>

      <form
        id="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) {
            go("checkout");
            run.setMsg({ tone: "error", text: "Use uma cor no formato #RRGGBB." });
            return;
          }
          void run.run(() =>
            updateSettingsAction({
              name: f.name.trim(),
              notifyEmail: f.notifyEmail.trim() || null,
              brandColor: f.color ? f.color.toUpperCase() : null,
              leadCapture: f.leadCapture,
              privacyEmail: f.privacyEmail.trim() || null,
              recovery: f.recovery,
            }),
          );
        }}
      >
        <fieldset disabled={!canWrite} className={s.settingsFieldset}>
          <section className={`${s.card} ${s.settingsCard}`} role="tabpanel" id="painel-loja" aria-labelledby="aba-loja" hidden={tab !== "loja"}>
            <div className={s.grid2}>
              <label className={s.field}>
                <span className={s.label}>Nome da loja</span>
                <input className={s.input} value={f.name} required maxLength={100} onChange={(e) => setF({ ...f, name: e.target.value })} />
                <span className={s.hint}>Aparece no checkout, na página de obrigado e nos e-mails.</span>
              </label>
              <label className={s.field}>
                <span className={s.label}>E-mail para aviso de venda</span>
                <input className={s.input} type="email" value={f.notifyEmail} maxLength={254} onChange={(e) => setF({ ...f, notifyEmail: e.target.value })} />
                <span className={s.hint}>Recebe um aviso a cada venda paga e os alertas da loja.</span>
              </label>
            </div>
          </section>

          <section className={`${s.card} ${s.settingsCard}`} role="tabpanel" id="painel-checkout" aria-labelledby="aba-checkout" hidden={tab !== "checkout"}>
            <div className={s.grid2}>
              <div className={s.field}>
                <label className={s.label} htmlFor="brand-hex">
                  Cor da loja
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    type="color"
                    aria-label="Escolher a cor"
                    value={valid && f.color ? f.color.toLowerCase() : DEFAULT_BRAND["--color-brand"].toLowerCase()}
                    onChange={(e) => setF({ ...f, color: e.target.value.toUpperCase() })}
                    className={s.colorWell}
                  />
                  <input
                    id="brand-hex"
                    className={`${s.input} ${s.mono}`}
                    value={f.color}
                    placeholder={`${DEFAULT_BRAND["--color-brand"]} (padrão)`}
                    maxLength={7}
                    aria-invalid={!valid}
                    aria-describedby="brand-contrast"
                    onChange={(e) => setF({ ...f, color: e.target.value.trim() })}
                  />
                </div>
                <span id="brand-contrast" className={valid ? s.hint : s.fieldError} aria-live="polite" style={valid ? { color: "var(--color-success)" } : undefined}>
                  {valid ? (
                    <>
                      <PIcon name="circle-check" size={14} /> {TEXT_NAME[on] ?? "Texto"} legível ({ratio(r)}, AA)
                    </>
                  ) : (
                    "Use o formato #RRGGBB."
                  )}
                </span>
                {f.color ? (
                  <button type="button" className={s.linkBtn} style={{ alignSelf: "flex-start", fontSize: 13 }} onClick={() => setF({ ...f, color: "" })}>
                    Voltar à cor padrão
                  </button>
                ) : null}
              </div>
              <div className={s.field}>
                <span className={s.label}>Prévia do botão</span>
                <div style={{ ...(vars as CSSProperties), display: "flex", flexDirection: "column", gap: 8 }} aria-hidden="true">
                  <span className={s.previewBtn} style={{ marginTop: 0 }}>
                    Gerar Pix de R$ 9,90
                  </span>
                  <span style={{ color: "var(--color-brand-strong)", fontWeight: 600, fontSize: 13 }}>Link e destaque na cor da loja</span>
                </div>
              </div>
            </div>
            <p className={s.hint} style={{ margin: 0 }}>
              Se a cor tiver pouco contraste (ex.: amarelo), o texto do botão vira escuro sozinho e os links usam uma versão mais escura da cor
              {strongChanged ? ` (aqui: ${vars["--color-brand-strong"]})` : ""}.
            </p>
          </section>

          <section className={`${s.card} ${s.settingsCard}`} role="tabpanel" id="painel-contatos" aria-labelledby="aba-contatos" hidden={tab !== "contatos"}>
            <div className={s.grid2}>
              <div className={s.field}>
                <label className={s.switch}>
                  <input type="checkbox" checked={f.leadCapture} onChange={(e) => setF({ ...f, leadCapture: e.target.checked })} aria-describedby="lead-capture-hint" />
                  Guardar o contato de quem não finaliza a compra
                </label>
                <span id="lead-capture-hint" className={s.hint}>
                  E-mail e celular ficam por até 30 dias, com aviso no checkout. Exige o e-mail para pedidos de privacidade.
                </span>
              </div>
              <label className={s.field}>
                <span className={s.label}>E-mail para pedidos de privacidade</span>
                <input
                  className={s.input}
                  type="email"
                  value={f.privacyEmail}
                  maxLength={254}
                  required={f.leadCapture}
                  onChange={(e) => setF({ ...f, privacyEmail: e.target.value })}
                />
                <span className={s.hint}>Aparece no aviso de privacidade do checkout.</span>
              </label>
            </div>
            <div className={s.field}>
              <span className={s.label}>Recuperação de vendas por e-mail</span>
              <label className={s.switch}>
                <input type="checkbox" checked={f.recovery.on} onChange={(e) => setF({ ...f, recovery: { ...f.recovery, on: e.target.checked } })} aria-describedby="recovery-hint" />
                Mandar um lembrete por e-mail para quem não concluiu a compra
              </label>
              <span id="recovery-hint" className={s.hint}>
                Sai pelo e-mail da loja (Conexões). Um lembrete por compra, com link para a pessoa não receber mais.
              </span>
              <div className={s.settingsSub}>
                <label className={s.switch}>
                  <input type="checkbox" checked={f.recovery.lead} disabled={!f.recovery.on} onChange={(e) => setF({ ...f, recovery: { ...f.recovery, lead: e.target.checked } })} />
                  Digitou o e-mail e saiu antes do pedido (precisa da captura de contato ligada)
                </label>
                <label className={s.switch}>
                  <input type="checkbox" checked={f.recovery.pix} disabled={!f.recovery.on} onChange={(e) => setF({ ...f, recovery: { ...f.recovery, pix: e.target.checked } })} />
                  Pix gerado e não pago
                </label>
                <label className={s.switch}>
                  <input type="checkbox" checked={f.recovery.card} disabled={!f.recovery.on} onChange={(e) => setF({ ...f, recovery: { ...f.recovery, card: e.target.checked } })} />
                  Cartão recusado
                </label>
              </div>
            </div>
          </section>
        </fieldset>

        {!canWrite && (tab === "loja" || tab === "checkout" || tab === "contatos") ? <p className={s.hint}>Só o dono da loja altera estes dados.</p> : null}
        {canWrite && dirty ? (
          <div className={`${s.saveBar} ${s.saveBarSimple}`} role="region" aria-label="Alterações não salvas">
            <span>Alterações não salvas</span>
            <button type="button" className={s.btn} onClick={() => setF(saved)} disabled={run.pending}>
              Descartar
            </button>
            <button type="submit" className={`${s.btn} ${s.btnPrimary}`} disabled={run.pending}>
              {run.pending ? "Salvando…" : "Salvar alterações"}
            </button>
          </div>
        ) : null}
        <Live msg={run.msg} />
      </form>

      <div role="tabpanel" id="painel-pagina" aria-labelledby="aba-pagina" hidden={tab !== "pagina"}>
        {script}
      </div>
      {team ? (
        <div role="tabpanel" id="painel-equipe" aria-labelledby="aba-equipe" hidden={tab !== "equipe"}>
          {team}
        </div>
      ) : null}
      <div role="tabpanel" id="painel-entrega" aria-labelledby="aba-entrega" hidden={tab !== "entrega"}>
        {delivery}
      </div>
    </>
  );
}
