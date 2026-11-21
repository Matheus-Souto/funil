import Link from "next/link";
import { notFound } from "next/navigation";
import { runAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { requirePanelActor } from "@/lib/auth/session";
import { shortWhenSP as shortWhen } from "@/lib/format";
import { listLeads } from "@/lib/leads/panel";
import { firstParam, type Param } from "@/lib/panel-params";
import { getStoreSettings } from "@/lib/store-settings";
import { Art, Badge, Notice, PageHead } from "../../blocks";
import s from "../../panel.module.css";
import { parsePage, parsePerPage, type PerPage } from "../../per-page";
import { ColumnFilter, TableShell } from "../../table-controls";
import { TablePager } from "../../table-pager";
import { ForgetEmailButton, LeadRowActions } from "./lead-actions";
import { remindedLabel } from "./reminded";
import { whatsappUrl } from "./whatsapp";

export const dynamic = "force-dynamic";
export const metadata = { title: "Contatos" };

type Status = "open" | "contacted" | "converted";
type Search = { status?: Param; q?: Param; pagina?: Param; por?: Param };

const STATUS_BADGE: Record<Status, { label: string; tone: "warning" | "info" | "success" }> = {
  open: { label: "Aberto", tone: "warning" },
  contacted: { label: "Contatado", tone: "info" },
  converted: { label: "Comprou", tone: "success" },
};
const STATUS_FILTER: Record<Status, string> = { open: "Abertos", contacted: "Contatados", converted: "Compraram" };
const isStatus = (v: string): v is Status => Object.hasOwn(STATUS_BADGE, v);
/** Contatos seguem 50 por página como padrão (o tamanho de sempre da ação). */
const LEADS_PER_PAGE: PerPage = 50;

export default async function ContactsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const panel = await requirePanelActor();
  if (!hasPermission(panel.actor.role, "leads.read")) notFound();
  const call = { ...panel, origin: "panel" as const };
  const sp = await searchParams;
  const raw = sp.status === undefined ? [] : Array.isArray(sp.status) ? sp.status : [sp.status];
  const statuses = [...new Set(raw.flatMap((v) => v.split(",")).map((v) => v.trim()))].filter(isStatus);
  const q = firstParam(sp.q)?.trim().slice(0, 254) || undefined;
  const perPage = parsePerPage(sp.por, LEADS_PER_PAGE);
  let page = parsePage(sp.pagina);

  let data = await runAction(listLeads, call, { statuses, q, page, pageSize: perPage });
  // ?pagina= além do fim (contatos que venceram ou mudaram de status): mostra a última página.
  const last = Math.max(1, Math.ceil(data.total / perPage));
  if (data.items.length === 0 && page > last) {
    page = last;
    data = await runAction(listLeads, call, { statuses, q, page, pageSize: perPage });
  }
  const canWrite = hasPermission(panel.actor.role, "leads.write");
  const canOpenOrders = hasPermission(panel.actor.role, "orders.read");
  const canSettings = hasPermission(panel.actor.role, "connections.read");
  // Quem não vê as configurações da loja não sabe se a captura está ligada: mostra o vazio padrão.
  const captureOn = canSettings ? (await runAction(getStoreSettings, call, {})).leadCapture : true;
  const filtered = Boolean(statuses.length || q);

  return (
    <>
      <PageHead title="Contatos" />
      {captureOn ? null : (
        <div className={s.noticeStrip}>
          <Notice tone="info" action={canSettings ? <Link href="/admin/settings?aba=contatos">Ligar</Link> : null}>
            <b>Captura desligada:</b> ligue em Configurações para guardar o contato de quem não finaliza a compra.
          </Notice>
        </div>
      )}
      <TableShell
        q={q}
        keep={{ status: statuses, por: perPage === LEADS_PER_PAGE ? [] : [String(perPage)] }}
        placeholder="Buscar por código ou e-mail"
        searchLabel="Buscar contatos"
        count={`${data.total} ${data.total === 1 ? "contato" : "contatos"}${filtered ? " com estes filtros" : ""}`}
      >
        {data.items.length === 0 ? (
          <div className={s.empty}>
            <Art name="indicacao" size={96} />
            <h2>{filtered ? "Nenhum contato com estes filtros" : "Nenhum contato ainda"}</h2>
            <p>
              {filtered
                ? "Tente outra busca ou tire o filtro de status."
                : captureOn
                  ? "Quem digitar o e-mail no checkout e sair sem comprar aparece aqui."
                  : "Com a captura ligada, quem digitar o e-mail no checkout e sair sem comprar aparece aqui."}
            </p>
            {filtered ? (
              <Link className={`${s.btn} ${s.btnSm}`} href="/admin/contatos">
                Limpar filtros
              </Link>
            ) : null}
          </div>
        ) : (
          <table className={`${s.table} ${s.leadTable}`}>
            <thead>
              <tr>
                <th scope="col">Contato</th>
                <th scope="col">Oferta</th>
                <th scope="col">
                  <ColumnFilter
                    title="Status"
                    param="status"
                    values={statuses}
                    options={(Object.keys(STATUS_BADGE) as Status[]).map((k) => ({ value: k, label: STATUS_FILTER[k], icon: `lead-${k}` }))}
                  />
                </th>
                <th scope="col">Capturado</th>
                <th scope="col">
                  <span className={s.srOnly}>Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((l) => {
                const badge = STATUS_BADGE[l.status];
                return (
                  <tr key={l.id}>
                    <td>
                      <span className={s.leadCell}>
                        <b className={s.mono}>#{l.code}</b>
                        {l.status === "converted" ? (
                          <small>
                            Comprou:{" "}
                            {l.orderId && canOpenOrders ? (
                              <Link className={`${s.rowLink} ${s.mono}`} href={`/admin/orders/${l.orderId}`}>
                                pedido #{l.orderCode}
                              </Link>
                            ) : (
                              <span className={s.mono}>pedido #{l.orderCode}</span>
                            )}
                          </small>
                        ) : (
                          <>
                            {l.email ? <small className={s.leadEmail}>{l.email}</small> : null}
                            {l.phone ? <small>{l.phone}</small> : null}
                          </>
                        )}
                      </span>
                    </td>
                    <td>{l.offerName}</td>
                    <td>
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                      {l.remindedAt ? <small className={s.leadNote}>{remindedLabel(l.remindedAt)}</small> : null}
                    </td>
                    <td className={`${s.muted} ${s.nowrap}`}>{shortWhen(l.createdAt)}</td>
                    <td className={s.num}>
                      {l.status === "converted" ? null : (
                        <LeadRowActions id={l.id} code={l.code} status={l.status} email={l.email} whatsapp={whatsappUrl(l.phone)} canWrite={canWrite} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <TablePager page={page} perPage={perPage} total={data.total} defaultPerPage={LEADS_PER_PAGE} />
      </TableShell>

      <div className={s.pageFoot}>
        Contatos são apagados 30 dias depois da captura.
        {canWrite ? (
          <>
            {" "}
            <ForgetEmailButton />
          </>
        ) : null}
      </div>
    </>
  );
}
