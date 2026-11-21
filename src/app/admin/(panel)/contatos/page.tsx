import Link from "next/link";
import { notFound } from "next/navigation";
import { runAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { requirePanelActor } from "@/lib/auth/session";
import { shortWhenSP as shortWhen } from "@/lib/format";
import { listLeads } from "@/lib/leads/panel";
import { firstParam, type Param } from "@/lib/panel-params";
import { getStoreSettings } from "@/lib/store-settings";
import { Badge, PageHead } from "../../blocks";
import { PIcon } from "../../icons";
import s from "../../panel.module.css";
import { CopyButton } from "../../ui";
import { ForgetEmailForm, LeadRowActions } from "./lead-actions";
import { whatsappUrl } from "./whatsapp";

export const dynamic = "force-dynamic";
export const metadata = { title: "Contatos" };

type Status = "open" | "contacted" | "converted";
type Search = { status?: Param; q?: Param; pagina?: Param };

const STATUSES: Array<[Status, string]> = [
  ["open", "Abertos"],
  ["contacted", "Contatados"],
  ["converted", "Compraram"],
];
const STATUS_BADGE: Record<Status, { label: string; tone: "warning" | "info" | "success" }> = {
  open: { label: "Aberto", tone: "warning" },
  contacted: { label: "Contatado", tone: "info" },
  converted: { label: "Comprou", tone: "success" },
};

export default async function ContactsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const panel = await requirePanelActor();
  if (!hasPermission(panel.actor.role, "leads.read")) notFound();
  const call = { ...panel, origin: "panel" as const };
  const sp = await searchParams;
  const rawStatus = firstParam(sp.status);
  const status = STATUSES.find(([k]) => k === rawStatus)?.[0];
  const q = firstParam(sp.q)?.trim().slice(0, 254) || undefined;
  const pageNum = Number.parseInt(firstParam(sp.pagina) ?? "1", 10);
  const page = Number.isFinite(pageNum) && pageNum >= 1 ? Math.min(pageNum, 10_000) : 1;

  const data = await runAction(listLeads, call, { status, q, page });
  const canWrite = hasPermission(panel.actor.role, "leads.write");
  const canOpenOrders = hasPermission(panel.actor.role, "orders.read");
  // Quem não vê as configurações da loja não sabe se a captura está ligada: mostra o vazio padrão.
  const captureOn = hasPermission(panel.actor.role, "connections.read") ? (await runAction(getStoreSettings, call, {})).leadCapture : true;

  const qs = (over: Partial<Record<keyof Search, string | undefined>>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ status, q, ...over })) if (v) p.set(k, v);
    const str = p.toString();
    return str ? `?${str}` : "";
  };
  const filtered = Boolean(status || q);
  const from = data.total === 0 ? 0 : (page - 1) * data.pageSize + 1;
  const to = Math.min(data.total, page * data.pageSize);

  return (
    <>
      <PageHead
        title="Contatos"
        sub={`${data.total} ${data.total === 1 ? "contato" : "contatos"}${filtered ? " com estes filtros" : ""} de quem não finalizou a compra`}
      />
      <form className={s.filters} method="get" role="search">
        {status ? <input type="hidden" name="status" value={status} /> : null}
        <label className={s.search}>
          <PIcon name="search" size={16} />
          <span className={s.srOnly}>Buscar contatos</span>
          <input name="q" defaultValue={q} placeholder="Buscar por código ou e-mail" maxLength={254} />
        </label>
        <button type="submit" className={s.btn}>
          Filtrar
        </button>
      </form>
      <nav className={s.pills} aria-label="Filtrar por status">
        <Link className={s.pill} href={`/admin/contatos${qs({ status: undefined, pagina: undefined })}`} aria-current={!status ? "page" : undefined}>
          Todos
        </Link>
        {STATUSES.map(([k, label]) => (
          <Link key={k} className={s.pill} href={`/admin/contatos${qs({ status: k, pagina: undefined })}`} aria-current={status === k ? "page" : undefined}>
            {label}
          </Link>
        ))}
      </nav>

      <section className={`${s.card} ${s.cardFlush}`}>
        {data.items.length === 0 ? (
          <p className={s.empty}>
            {filtered
              ? "Nenhum contato com estes filtros."
              : captureOn
                ? "Nenhum contato de quem não finalizou a compra."
                : "A captura está desligada. Ligue em Configurações."}
          </p>
        ) : (
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">Quando</th>
                <th scope="col">Oferta</th>
                <th scope="col">Contato</th>
                <th scope="col">Status</th>
                {canWrite ? <th scope="col">Ações</th> : null}
              </tr>
            </thead>
            <tbody>
              {data.items.map((l) => {
                const wa = whatsappUrl(l.phone);
                const badge = STATUS_BADGE[l.status];
                return (
                  <tr key={l.id}>
                    <td className={`${s.muted} ${s.nowrap}`}>
                      {shortWhen(l.createdAt)}
                      <small className={s.mono}>#{l.code}</small>
                    </td>
                    <td>{l.offerName}</td>
                    <td>
                      {l.status === "converted" ? (
                        <>
                          Comprou —{" "}
                          {l.orderId && canOpenOrders ? (
                            <Link className={`${s.rowLink} ${s.mono}`} href={`/admin/orders/${l.orderId}`}>
                              pedido #{l.orderCode}
                            </Link>
                          ) : (
                            <span className={s.mono}>pedido #{l.orderCode}</span>
                          )}
                        </>
                      ) : (
                        <>
                          {l.email ? (
                            <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                              <span style={{ overflowWrap: "anywhere" }}>{l.email}</span>
                              <CopyButton text={l.email} label="Copiar" small />
                            </span>
                          ) : null}
                          {l.phone ? (
                            <small>
                              {wa ? (
                                <a href={wa} target="_blank" rel="noopener noreferrer">
                                  {l.phone} (WhatsApp)
                                </a>
                              ) : (
                                l.phone
                              )}
                            </small>
                          ) : null}
                        </>
                      )}
                    </td>
                    <td>
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                      {l.remindedAt ? <small style={{ marginTop: 4 }}>Lembrete enviado em {shortWhen(l.remindedAt)}</small> : null}
                    </td>
                    {canWrite ? <td>{l.status === "converted" ? null : <LeadRowActions id={l.id} code={l.code} status={l.status} />}</td> : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className={s.tableFoot}>
          <span>
            Mostrando {from}–{to} de {data.total}
          </span>
          <div>
            {page > 1 ? (
              <Link className={s.btn} href={`/admin/contatos${qs({ pagina: String(page - 1) })}`}>
                Anterior
              </Link>
            ) : (
              <span className={s.btn} aria-disabled="true">
                Anterior
              </span>
            )}
            {to < data.total ? (
              <Link className={s.btn} href={`/admin/contatos${qs({ pagina: String(page + 1) })}`}>
                Próxima
              </Link>
            ) : (
              <span className={s.btn} aria-disabled="true">
                Próxima
              </span>
            )}
          </div>
        </div>
      </section>

      <p className={s.hint} style={{ marginTop: 16 }}>
        Contatos são apagados 30 dias depois da captura.
      </p>
      {canWrite ? (
        <section className={s.card} aria-labelledby="contatos-titular" style={{ marginTop: 16 }}>
          <h2 id="contatos-titular" className={s.sectionTitle}>
            Pedido de exclusão do titular
          </h2>
          <p className={s.hint}>Quando alguém pedir para apagar os dados, informe o e-mail: todos os contatos da loja com ele são excluídos.</p>
          <ForgetEmailForm />
        </section>
      ) : null}
    </>
  );
}
