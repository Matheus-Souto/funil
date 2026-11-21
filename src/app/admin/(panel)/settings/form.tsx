"use client";

// Loja (P15): nome, e-mail de aviso de venda e cor do checkout com prévia ao vivo do contraste (a mesma regra AA do
// checkout: src/lib/brand.ts).
import { useMemo, useState, type CSSProperties } from "react";
import { brandVars, contrastRatio, DEFAULT_BRAND } from "@/lib/brand";
import { PIcon } from "../../icons";
import s from "../../panel.module.css";
import { Live, useActionRunner } from "../../ui";
import { updateSettingsAction } from "../actions";

const HEX = /^#[0-9a-f]{6}$/i;
const ratio = (n: number) => `${n.toFixed(1).replace(".", ",")}:1`;
const TEXT_NAME: Record<string, string> = { "#FFFFFF": "Texto branco", "#15201B": "Texto escuro", "#000000": "Texto preto" };

export function SettingsForm({ initial, canWrite }: { initial: { name: string; notifyEmail: string; brandColor: string | null; leadCapture: boolean; privacyEmail: string }; canWrite: boolean }) {
  const [f, setF] = useState({ name: initial.name, notifyEmail: initial.notifyEmail, color: initial.brandColor ?? "", leadCapture: initial.leadCapture, privacyEmail: initial.privacyEmail });
  const run = useActionRunner();
  const valid = f.color === "" || HEX.test(f.color);
  const vars = useMemo(() => brandVars(valid && f.color ? f.color : null), [f.color, valid]);
  const on = vars["--color-on-brand"];
  const r = contrastRatio(on, vars["--color-brand"]);
  const strongChanged = vars["--color-brand-strong"] !== vars["--color-brand"];

  return (
    <form
      className={s.settingsRow}
      style={{ borderTop: 0 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) {
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
          }),
        );
      }}
    >
      <div>
        <h2 className={s.sectionTitle}>Loja</h2>
        <p>Aparece no checkout, na página de obrigado e nos e-mails.</p>
      </div>
      <fieldset className={s.card} disabled={!canWrite} style={{ margin: 0 }}>
        <legend className={s.srOnly}>Dados da loja</legend>
        <div className={s.stack}>
          <div className={s.grid2}>
            <label className={s.field}>
              <span className={s.label}>Nome da loja</span>
              <input className={s.input} value={f.name} required maxLength={100} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </label>
            <div className={s.field}>
              <label className={s.field}>
              <span className={s.label}>E-mail para aviso de venda</span>
              <input className={s.input} type="email" value={f.notifyEmail} maxLength={254} onChange={(e) => setF({ ...f, notifyEmail: e.target.value })} />
              </label>
              <span className={s.hint}>Recebe um aviso a cada venda paga e os alertas da loja.</span>
            </div>
          </div>
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
                  style={{ width: 44, height: 42, padding: 2, border: "1px solid var(--color-border-strong)", borderRadius: 10, background: "var(--color-surface)" }}
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
            <div className={s.field}>
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
              </label>
              <span className={s.hint}>Aparece no aviso de privacidade do checkout.</span>
            </div>
          </div>
          <div className={s.banner} data-tone="neutral">
            <PIcon name="palette" />
            <div>
              Se a cor tiver pouco contraste (ex.: amarelo), o texto do botão vira escuro automaticamente e links usam uma versão mais escura da cor
              {strongChanged ? ` (aqui: ${vars["--color-brand-strong"]})` : ""}.
            </div>
          </div>
          {canWrite ? (
            <div className={s.formActions}>
              <button type="submit" className={`${s.btn} ${s.btnPrimary}`} disabled={run.pending}>
                {run.pending ? "Salvando…" : "Salvar alterações"}
              </button>
            </div>
          ) : (
            <p className={s.hint}>Só o dono da loja altera estes dados.</p>
          )}
          <Live msg={run.msg} />
        </div>
      </fieldset>
    </form>
  );
}
