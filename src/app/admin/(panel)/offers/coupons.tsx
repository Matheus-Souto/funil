"use client";

// Aba Cupons de Ofertas: lista (código, desconto, validade, usos, situação), criar, editar e arquivar. Percentual é
// digitado como porcentagem e guardado em pontos-base; valor fixo é digitado em reais e guardado em centavos (conversões
// puras em `@/lib/coupons/form`). Cupom arquivado continua ocupando o código e não se edita. Sem regra de negócio: tudo
// passa pelas actions do painel.
import { useId, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Select } from "@/components/arc/select/select";
import { SortableDataTable } from "@/components/arc/sortable-data-table/sortable-data-table";
import { Switch } from "@/components/arc/switch/switch";
import { COUPON_DUPLICATE_MESSAGE } from "@/lib/coupons/messages";
import { amountToCents, centsToAmountInput, dateInputOf, endOfDateInput, percentToBp, percentToInput, startOfDateInput, type CouponStatus } from "@/lib/coupons/form";
import { Art, Badge } from "../../blocks";
import s from "../../panel.module.css";
import { Dialog, Live, useActionRunner } from "../../ui";
import { archiveCouponAction, createCouponAction, updateCouponAction } from "../actions";

export interface CouponRow extends Record<string, unknown> {
  id: string;
  code: string;
  kind: "percent" | "fixed";
  percentBp: number | null;
  amountCents: number | null;
  appliesTo: "main" | "all";
  startsAtIso: string | null;
  endsAtIso: string | null;
  maxUses: number | null;
  maxPerEmail: number | null;
  active: boolean;
  offerIds: string[];
  uses: number;
  status: CouponStatus;
  /** Textos já formatados no servidor (horário de São Paulo e reais). */
  discountText: string;
  validityText: string;
  /** Para ordenar as colunas. */
  discountSort: number;
  endTs: number;
}

export interface OfferOption {
  id: string;
  name: string;
}

const STATUS: Record<CouponStatus, { label: string; tone: "success" | "warning" | "danger" | "info" | "neutral" }> = {
  active: { label: "Valendo", tone: "success" },
  scheduled: { label: "Agendado", tone: "info" },
  expired: { label: "Vencido", tone: "warning" },
  inactive: { label: "Desligado", tone: "neutral" },
  archived: { label: "Arquivado", tone: "neutral" },
};

interface Form {
  code: string;
  kind: "percent" | "fixed";
  value: string;
  appliesTo: "main" | "all";
  offerIds: string[];
  startsOn: string;
  endsOn: string;
  maxUses: string;
  maxPerEmail: string;
  active: boolean;
}

const emptyForm = (): Form => ({ code: "", kind: "percent", value: "", appliesTo: "main", offerIds: [], startsOn: "", endsOn: "", maxUses: "", maxPerEmail: "1", active: true });

const formOf = (c: CouponRow): Form => ({
  code: c.code,
  kind: c.kind,
  value: c.kind === "percent" ? percentToInput(c.percentBp ?? 0) : centsToAmountInput(c.amountCents ?? 0),
  appliesTo: c.appliesTo,
  offerIds: c.offerIds,
  startsOn: dateInputOf(c.startsAtIso ? new Date(c.startsAtIso) : null),
  endsOn: dateInputOf(c.endsAtIso ? new Date(c.endsAtIso) : null),
  maxUses: c.maxUses === null ? "" : String(c.maxUses),
  maxPerEmail: c.maxPerEmail === null ? "" : String(c.maxPerEmail),
  active: c.active,
});

/** Limite digitado: vazio = sem limite; senão inteiro maior que zero. */
function limitOf(text: string, what: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const t = text.trim();
  if (t === "") return { ok: true, value: null };
  if (!/^\d{1,9}$/.test(t) || Number(t) < 1) return { ok: false, error: `${what}: use um número inteiro maior que zero ou deixe vazio.` };
  return { ok: true, value: Number(t) };
}

/** Entrada da action a partir do formulário, ou o texto do primeiro problema. `edit`: só manda a data que mudou. */
function inputOf(f: Form, edit: CouponRow | null): { ok: true; input: Record<string, unknown> } | { ok: false; error: string } {
  const code = f.code.trim();
  if (code === "") return { ok: false, error: "Informe o código do cupom." };
  const v = f.kind === "percent" ? percentToBp(f.value) : amountToCents(f.value);
  if (!v.ok) return { ok: false, error: v.error };
  const uses = limitOf(f.maxUses, "Limite de usos");
  if (!uses.ok) return uses;
  const per = limitOf(f.maxPerEmail, "Limite por pessoa");
  if (!per.ok) return per;
  const before = edit ? formOf(edit) : null;
  const input: Record<string, unknown> = {
    code,
    kind: f.kind,
    percentBp: f.kind === "percent" ? v.value : null,
    amountCents: f.kind === "fixed" ? v.value : null,
    appliesTo: f.appliesTo,
    maxUses: uses.value,
    maxPerEmail: per.value,
    active: f.active,
    offerIds: f.offerIds,
  };
  if (!before || f.startsOn !== before.startsOn) input.startsAt = f.startsOn ? startOfDateInput(f.startsOn).toISOString() : null;
  if (!before || f.endsOn !== before.endsOn) input.endsAt = f.endsOn ? endOfDateInput(f.endsOn).toISOString() : null;
  if (f.startsOn && f.endsOn && f.endsOn < f.startsOn) return { ok: false, error: "O fim da validade deve ser depois do início." };
  return { ok: true, input };
}

const DUPLICATE_HINT = " Ele pode estar arquivado: marque “Mostrar arquivados” para ver.";
/** Quem só lê vê os botões desabilitados e esta linha (docs/padrao-de-paginas.md §5). */
const READ_ONLY_HINT = "Só o dono e os administradores (quem edita ofertas) criam, editam e arquivam cupons.";

export function CouponsPanel({ coupons, offers, canWrite }: { coupons: CouponRow[]; offers: OfferOption[]; canWrite: boolean }) {
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<{ row: CouponRow | null } | null>(null);
  const [archiving, setArchiving] = useState<CouponRow | null>(null);
  const [f, setF] = useState<Form>(emptyForm);
  const [problem, setProblem] = useState<string | null>(null);
  const save = useActionRunner();
  const archive = useActionRunner();
  const rows = useMemo(() => (showArchived ? coupons : coupons.filter((c) => c.status !== "archived")), [coupons, showArchived]);
  const archivedCount = coupons.length - coupons.filter((c) => c.status !== "archived").length;
  const offerName = (id: string) => offers.find((o) => o.id === id)?.name ?? "Oferta";
  const ids = useId();

  // Um retorno por vez fora do diálogo: abrir um formulário apaga o aviso anterior (dos dois).
  const openForm = (row: CouponRow | null) => {
    save.setMsg(null);
    archive.setMsg(null);
    setProblem(null);
    setF(row ? formOf(row) : emptyForm());
    setEditing({ row });
  };
  /** Cancelar: some o erro do diálogo. Depois de salvar, o "Cupom salvo." continua visível fora dele. */
  const closeForm = () => {
    save.setMsg(null);
    setProblem(null);
    setEditing(null);
  };
  const openArchive = (row: CouponRow) => {
    save.setMsg(null);
    archive.setMsg(null);
    setArchiving(row);
  };
  const closeArchive = () => {
    archive.setMsg(null);
    setArchiving(null);
  };
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((cur) => ({ ...cur, [k]: v }));

  const submit = async () => {
    const edit = editing?.row ?? null;
    const r = inputOf(f, edit);
    if (!r.ok) {
      setProblem(r.error);
      return;
    }
    setProblem(null);
    const res = await save.run(() => (edit ? updateCouponAction({ id: edit.id, ...r.input }) : createCouponAction(r.input)));
    if (res.ok) {
      setProblem(null);
      setEditing(null);
    } else if (res.code === "conflict" && res.error === COUPON_DUPLICATE_MESSAGE) save.setMsg({ tone: "error", text: `${res.error}.${DUPLICATE_HINT}` });
    // Outros conflitos (ex.: "Este cupom já foi usado: crie outro código") ficam como vieram, no aviso do diálogo.
  };

  return (
    <div className={s.stack}>
      <div className={s.titleRow} style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <Switch checked={showArchived} onCheckedChange={setShowArchived} label={`Mostrar arquivados${archivedCount > 0 ? ` (${archivedCount})` : ""}`} />
        <button
          type="button"
          className={`${s.btn} ${s.btnPrimary}`}
          onClick={() => openForm(null)}
          disabled={!canWrite}
          aria-describedby={canWrite ? undefined : `${ids}-ro`}
        >
          <Plus size={16} strokeWidth={2} aria-hidden="true" />
          Novo cupom
        </button>
      </div>
      {canWrite ? null : (
        <p id={`${ids}-ro`} className={s.hint}>
          {READ_ONLY_HINT}
        </p>
      )}

      <section className={`${s.card} ${s.cardFlush}`} aria-label="Cupons">
        {rows.length === 0 ? (
          <div className={s.empty}>
            <Art name="ticket" size={96} />
            <h2>{coupons.length === 0 ? "Nenhum cupom ainda" : "Nenhum cupom ativo"}</h2>
            <p>
              {coupons.length === 0
                ? "O cupom dá desconto no checkout. Crie o primeiro e divulgue o link com ?cupom=CODIGO."
                : "Os cupons existentes estão arquivados. Marque “Mostrar arquivados” para vê-los."}
            </p>
          </div>
        ) : (
          <div className={s.arcTable}>
            <SortableDataTable<CouponRow>
              rows={rows}
              rowKey="id"
              caption="Cupons"
              defaultSort={{ key: "code", direction: "asc" }}
              columns={[
                {
                  key: "code",
                  label: "Cupom",
                  render: (_, c) => (
                    <span className={s.leadCell}>
                      <b className={s.mono}>{c.code}</b>
                      <small>{c.offerIds.length === 0 ? "Todas as ofertas" : c.offerIds.map(offerName).join(" · ")}</small>
                    </span>
                  ),
                },
                {
                  key: "discountSort",
                  label: "Desconto",
                  numeric: false,
                  render: (_, c) => (
                    <span className={s.leadCell}>
                      <b>{c.discountText}</b>
                      <small>{c.appliesTo === "all" ? "Principal e bump" : "Só o principal"}</small>
                    </span>
                  ),
                },
                { key: "endTs", label: "Validade", numeric: false, render: (_, c) => <span className={`${s.muted} ${s.nowrap}`}>{c.validityText}</span> },
                {
                  key: "uses",
                  label: "Usos",
                  numeric: true,
                  render: (_, c) => (
                    <span className={s.leadCell}>
                      <b>{c.maxUses === null ? c.uses : `${c.uses} de ${c.maxUses}`}</b>
                      <small>{c.maxPerEmail === null ? "sem limite por pessoa" : `${c.maxPerEmail} por pessoa`}</small>
                    </span>
                  ),
                },
                { key: "status", label: "Situação", render: (_, c) => <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge> },
                {
                  key: "id",
                  label: "Ações",
                  sortable: false,
                  render: (_, c) =>
                    c.status !== "archived" ? (
                      <span className={s.nowrap} style={{ display: "inline-flex", gap: 8 }}>
                        <button
                          type="button"
                          className={`${s.btn} ${s.btnSm}`}
                          onClick={() => openForm(c)}
                          disabled={!canWrite}
                          aria-label={`Editar o cupom ${c.code}`}
                          aria-describedby={canWrite ? undefined : `${ids}-ro`}
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          className={`${s.btn} ${s.btnSm}`}
                          onClick={() => openArchive(c)}
                          disabled={!canWrite}
                          aria-label={`Arquivar o cupom ${c.code}`}
                          aria-describedby={canWrite ? undefined : `${ids}-ro`}
                        >
                          Arquivar
                        </button>
                      </span>
                    ) : null,
                },
              ]}
            />
          </div>
        )}
      </section>
      {/* Retorno de criar, editar e arquivar, visível depois que o diálogo fecha. */}
      <Live msg={archiving || editing ? null : (save.msg ?? archive.msg)} />

      <Dialog
        open={editing !== null}
        onClose={closeForm}
        title={editing?.row ? `Editar o cupom ${editing.row.code}` : "Novo cupom"}
        footer={
          <>
            <button type="button" className={s.btn} onClick={closeForm}>
              Cancelar
            </button>
            <button type="submit" form="coupon-form" className={`${s.btn} ${s.btnPrimary}`} disabled={save.pending}>
              {save.pending ? "Salvando…" : editing?.row ? "Salvar alterações" : "Criar cupom"}
            </button>
          </>
        }
      >
        <form
          id="coupon-form"
          className={s.stack}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className={s.field}>
            <span className={s.label}>Código</span>
            <input
              className={s.input}
              value={f.code}
              maxLength={32}
              placeholder="Ex.: KIDS10"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => set("code", e.target.value.toUpperCase())}
              data-autofocus
            />
            <span className={s.hint}>De 3 a 32 caracteres: letras, números, hífen e sublinhado.</span>
          </label>
          <div className={s.grid2}>
            <Select
              className={s.arcField}
              label="Tipo"
              value={f.kind}
              onValueChange={(v) => setF({ ...f, kind: v as Form["kind"], value: "" })}
              options={[
                { value: "percent", label: "Percentual (%)" },
                { value: "fixed", label: "Valor fixo (R$)" },
              ]}
            />
            <label className={s.field}>
              <span className={s.label}>{f.kind === "percent" ? "Desconto (%)" : "Desconto (R$)"}</span>
              <input className={s.input} value={f.value} inputMode="decimal" placeholder={f.kind === "percent" ? "10" : "5,00"} autoComplete="off" onChange={(e) => set("value", e.target.value)} />
              <span className={s.hint}>{f.kind === "percent" ? "De 0,01% a 90%, até 2 casas." : "O total nunca fica abaixo de R$ 5,00."}</span>
            </label>
          </div>
          <Select
            className={s.arcField}
            label="Vale para"
            value={f.appliesTo}
            onValueChange={(v) => set("appliesTo", v as Form["appliesTo"])}
            options={[
              { value: "main", label: "Só o produto principal" },
              { value: "all", label: "Produto principal e bump" },
            ]}
          />
          {offers.length > 0 ? (
            <fieldset className={s.field} style={{ margin: 0, padding: 0, border: 0 }}>
              <legend className={s.label}>Ofertas</legend>
              {offers.map((o) => (
                <label key={o.id} className={s.switch} style={{ fontWeight: 500 }}>
                  <input type="checkbox" checked={f.offerIds.includes(o.id)} onChange={(e) => set("offerIds", e.target.checked ? [...f.offerIds, o.id] : f.offerIds.filter((x) => x !== o.id))} />
                  {o.name}
                </label>
              ))}
              <span className={s.hint}>Nenhuma marcada: vale para todas as ofertas.</span>
            </fieldset>
          ) : null}
          <div className={s.grid2}>
            <label className={s.field}>
              <span className={s.label}>Começa em</span>
              <input className={s.input} type="date" value={f.startsOn} onChange={(e) => set("startsOn", e.target.value)} />
            </label>
            <label className={s.field}>
              <span className={s.label}>Termina em</span>
              <input className={s.input} type="date" value={f.endsOn} onChange={(e) => set("endsOn", e.target.value)} />
            </label>
          </div>
          <span className={s.hint} style={{ marginTop: -8 }}>
            Datas no horário de São Paulo; o cupom vale até o fim do último dia. Vazio: sem início ou sem fim.
          </span>
          <div className={s.grid2}>
            <label className={s.field}>
              <span className={s.label}>Limite de usos</span>
              <input className={s.input} value={f.maxUses} inputMode="numeric" placeholder="Sem limite" autoComplete="off" onChange={(e) => set("maxUses", e.target.value)} />
            </label>
            <label className={s.field}>
              <span className={s.label}>Limite por pessoa</span>
              <input className={s.input} value={f.maxPerEmail} inputMode="numeric" placeholder="Sem limite" autoComplete="off" onChange={(e) => set("maxPerEmail", e.target.value)} />
            </label>
          </div>
          <Switch checked={f.active} onCheckedChange={(v) => set("active", v)} label="Cupom ligado" />
          <Live msg={problem ? { tone: "error", text: problem } : save.msg} />
        </form>
      </Dialog>

      <Dialog
        open={archiving !== null}
        onClose={closeArchive}
        tone="danger"
        title={`Arquivar o cupom ${archiving?.code ?? ""}?`}
        footer={
          <>
            <button type="button" className={s.btn} onClick={closeArchive} data-autofocus>
              Cancelar
            </button>
            <button
              type="button"
              className={`${s.btn} ${s.btnDanger}`}
              disabled={archive.pending}
              onClick={async () => {
                if (!archiving) return;
                const r = await archive.run(() => archiveCouponAction(archiving.id));
                if (r.ok) setArchiving(null);
              }}
            >
              {archive.pending ? "Arquivando…" : "Arquivar"}
            </button>
          </>
        }
      >
        <p>O cupom para de valer na hora. Ele não pode ser editado nem religado, e o código continua ocupado.</p>
        {archive.msg?.tone === "error" ? <Live msg={archive.msg} /> : null}
      </Dialog>
    </div>
  );
}
