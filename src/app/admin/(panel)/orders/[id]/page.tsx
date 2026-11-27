import { notFound } from "next/navigation";
import { ActionError, runAction } from "@/lib/actions/core";
import { requirePanelActor } from "@/lib/auth/session";
import { brl, dateTimeShortSP, dateTimeSP, splitUniqueAmount, validUntilSP } from "@/lib/format";
import { APP_NOTICE_LABEL, METHOD_LABEL, ROLE_LABEL, STATUS_LABEL, paidOnOldAsaasAccount, pixManualExpiry } from "@/lib/orders/labels";
import { allowedOrderActions, getOrderDetail, type AppNotice, type OrderDetail } from "@/lib/orders/panel";
import { Badge, PageHead, StatusBadge } from "../../../blocks";
import { PIcon } from "../../../icons";
import s from "../../../panel.module.css";
import { OrderActions } from "./order-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pedido" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FLAG: Record<string, string> = {
  duplicate: "cobrança em dobro: devolver ao comprador",
  superseded: "conta Asaas anterior (descartada)",
  old_account_event: "movimento na conta anterior: conferir lá",
};
const REVOKED: Record<string, string> = { order_status: "desativado (reembolso ou contestação)", renewed: "substituído por links novos" };
const DELIVERY_STATUS_LABEL: Record<string, string> = { delivered: "entregue", bounced: "devolvido", complained: "marcado como spam" };

/** Estado do último aviso ao app: o selo e a linha de apoio (tentativas e último código HTTP; nunca a resposta do app). */
function noticeState(n: AppNotice): { tone: "success" | "warning" | "danger" | "neutral"; label: string; detail: string } {
  const http = n.lastHttpStatus !== null ? ` · HTTP ${n.lastHttpStatus}` : "";
  if (n.status === "delivered") return { tone: "success", label: "Entregue", detail: n.deliveredAt ? dateTimeShortSP(n.deliveredAt) : "" };
  if (n.status === "failed") return { tone: "danger", label: "Não entregue", detail: `${n.attempts} tentativas${http}` };
  if (n.attempts === 0) return { tone: "neutral", label: "Na fila", detail: "sai em instantes" };
  return { tone: "warning", label: "Tentando de novo", detail: `tentativa ${n.attempts} de ${n.maxAttempts}${http}` };
}

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const panel = await requirePanelActor();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  let d: OrderDetail;
  try {
    d = await runAction(getOrderDetail, { ...panel, origin: "panel" }, { id });
  } catch (e) {
    if (e instanceof ActionError && e.code === "not_found") notFound();
    throw e;
  }
  const allowed = allowedOrderActions(panel.actor.role, d);
  const manual = d.method === "pix_manual";
  const awaiting = manual && (d.status === "pending" || d.status === "expired");
  // Vencido também quando ainda `pending` com a validade passada (a varredura não rodou): mesma conferência extra.
  const late = pixManualExpiry(d);
  const amount = d.manualAmountCents ?? d.totalCents;
  const [same, diff] = splitUniqueAmount(d.totalCents, amount);
  const t = d.attribution.lastTouch ?? d.attribution.firstTouch ?? {};
  const phoneDigits = d.buyer.phone.replace(/\D/g, "");
  const notice = d.app?.notice ?? null;
  const noticeName = notice ? (APP_NOTICE_LABEL[notice.eventType] ?? notice.eventType) : null;
  const noticeView = notice ? noticeState(notice) : null;
  const refundLabel =
    d.refund.state === "processing" || d.refund.state === "awaiting_provider" ? "Estorno solicitado" : d.refund.state === "stale" ? "Estorno pendente" : undefined;

  return (
    <>
      <PageHead
        back={{ href: "/admin/orders", label: "Pedidos" }}
        title={`Pedido #${d.code}`}
        badge={<StatusBadge status={d.status} method={d.method} label={refundLabel} />}
        actions={
          <OrderActions
            id={d.id}
            code={d.code}
            status={d.status}
            method={d.method}
            buyerName={d.buyer.name}
            email={d.buyer.email}
            amountCents={amount}
            totalCents={d.totalCents}
            createdAt={d.createdAt.toISOString()}
            expiresAt={d.expiresAt?.toISOString() ?? null}
            expired={late.expired}
            reservedUntil={late.reservedUntil?.toISOString() ?? null}
            allowed={allowed}
            oldAsaasAccount={paidOnOldAsaasAccount(d)}
            appNotice={d.app ? (noticeName ?? "") : null}
          />
        }
      />

      {notice?.status === "failed" ? (
        <div className={s.alerts}>
          <div className={s.banner} role="alert">
            <PIcon name="triangle-alert" />
            <div>
              <b>O app não confirmou o aviso “{noticeName}”.</b>
              <p>
                Ele pode não ter liberado (ou retirado) o plano ou os créditos deste pedido. Confira o webhook do app em Conexões
                {allowed.resendNotice ? " e use “Reenviar aviso ao app”." : " e peça a quem atende os pedidos para reenviar o aviso."}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {d.refund.state !== "none" ? (
        <div className={s.alerts}>
          {d.refund.state === "stale" ? (
            <div className={s.banner} role="alert">
              <PIcon name="triangle-alert" />
              <div>
                <b>Estorno pendente sem processamento — solicitar de novo.</b>
                <p>
                  O estorno foi pedido {d.refund.requestedAt ? `em ${dateTimeSP(d.refund.requestedAt)}` : ""}, mas não está em andamento no Asaas
                  {allowed.refund ? ". Use “Reembolsar” para pedir de novo." : ". Peça a quem pode reembolsar para solicitar de novo."}
                </p>
              </div>
            </div>
          ) : (
            <div className={s.banner} data-tone="info" role="status">
              <PIcon name="rotate-ccw" />
              <div>
                <b>Estorno solicitado{d.refund.requestedAt ? ` em ${dateTimeSP(d.refund.requestedAt)}` : ""}.</b>
                <p>
                  {d.refund.state === "processing"
                    ? "Enviando o pedido de estorno ao Asaas."
                    : "O Asaas recebeu o pedido. O pedido muda para reembolsado assim que o Asaas confirmar."}
                </p>
              </div>
            </div>
          )}
        </div>
      ) : null}

      <div className={s.splitWide}>
        <div className={s.stack}>
          {awaiting ? (
            <section className={`${s.card} ${s.pixCard}`} aria-label="Conferência do Pix manual">
              <div className={s.uniqueBox}>
                <div>
                  <span className={s.muted}>Procure no extrato um Pix de</span>
                  <p className={s.uniqueAmount} data-testid="panel-unique-amount">
                    {same}
                    <mark>{diff}</mark>
                  </p>
                  <span className={s.hint}>
                    Valor único deste pedido ({brl(d.totalCents)} + {brl(amount - d.totalCents)} de identificação)
                  </span>
                </div>
                <div className={`${s.rows} ${s.factRows}`}>
                  <div className={s.row}>
                    <span>Recebido a partir de</span>
                    <span>{dateTimeShortSP(d.createdAt)}</span>
                  </div>
                  <div className={s.row}>
                    <span>Identificador</span>
                    <span className={s.mono}>{d.identifier}</span>
                  </div>
                  <div className={s.row}>
                    <span>Chave Pix</span>
                    <span>{d.pix?.key || "—"}</span>
                  </div>
                  <div className={s.row}>
                    <span>{late.expired ? "Expirou" : "Expira"}</span>
                    <span>{d.expiresAt ? (late.expired ? dateTimeShortSP(d.expiresAt) : validUntilSP(d.expiresAt)) : "—"}</span>
                  </div>
                </div>
              </div>
              <div className={s.pixWarn} role="note">
                <PIcon name="shield-alert" size={20} />
                <div>
                  <b>Confira no extrato do banco. Nunca libere por comprovante enviado pelo comprador.</b>
                  <p>Comprovantes são fáceis de falsificar. O nome do pagador pode ser diferente do cliente; o extrato pode não mostrar o identificador.</p>
                </div>
              </div>
            </section>
          ) : null}

          <section className={s.card}>
            <div className={s.cardHead}>
              <h2>Itens</h2>
              <small>{d.offer.name}</small>
            </div>
            <div className={s.rows}>
              {/* Pedido de app não tem PDF: a linha é a própria oferta. */}
              {d.items.length === 0 ? (
                <div className={s.row}>
                  <span style={{ color: "var(--color-text)" }}>{d.offer.name}</span>
                  <span>{brl(d.subtotalCents)}</span>
                </div>
              ) : null}
              {d.items.map((g) => (
                <div key={g.kind} className={s.row}>
                  <span style={{ color: "var(--color-text)" }}>
                    {g.names.join(" + ")}
                    {g.kind === "bump" ? " (bump)" : ""}
                  </span>
                  <span>{brl(g.priceCents)}</span>
                </div>
              ))}
              {d.coupon ? (
                <div className={s.row}>
                  <span>
                    Cupom <span className={s.mono}>{d.coupon.code}</span>
                    <small className={s.muted} style={{ display: "block" }}>
                      Desconto já aplicado nos valores acima · subtotal {brl(d.subtotalCents)}
                    </small>
                  </span>
                  <span>−{brl(d.discountCents)}</span>
                </div>
              ) : null}
              {manual && amount !== d.totalCents ? (
                <div className={s.row}>
                  <span>Centavos de identificação (Pix manual)</span>
                  <span>{brl(amount - d.totalCents)}</span>
                </div>
              ) : null}
              <div className={`${s.row} ${s.rowTotal}`}>
                <span>{d.status === "pending" || d.status === "expired" || d.status === "declined" ? "Total a receber" : "Total pago"}</span>
                <span>{brl(amount)}</span>
              </div>
            </div>
          </section>

          {d.payments.length > 0 ? (
            <section className={s.card}>
              <div className={s.cardHead}>
                <h2>Pagamentos</h2>
              </div>
              <div className={s.rows}>
                {d.payments.map((p) => (
                  <div key={p.id} className={s.row}>
                    <span>
                      {p.provider === "manual" ? "Pix manual (liberado no painel)" : <span className={s.mono}>{p.providerId}</span>}
                      {p.flags.map((f) => (
                        <span key={f} style={{ marginLeft: 8 }}>
                          <Badge tone={f === "superseded" ? "neutral" : "danger"}>{FLAG[f]}</Badge>
                        </span>
                      ))}
                    </span>
                    <span>
                      {brl(p.amountCents)} <small className={s.muted}>· {p.status}</small>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {d.links.length > 0 ? (
            <section className={s.card}>
              <div className={s.cardHead}>
                <h2>Links de download</h2>
              </div>
              <div className={s.rows}>
                {d.links.map((l) => (
                  <div key={l.id} className={s.row}>
                    <span>
                      {l.productName}
                      <small className={s.muted} style={{ display: "block" }}>
                        {l.revokedAt ? `${REVOKED[l.revokedReason ?? ""] ?? "desativado"} em ${dateTimeSP(l.revokedAt)}` : `vale até ${dateTimeSP(l.expiresAt)}`}
                      </small>
                    </span>
                    <span>
                      {l.downloads} de {l.maxDownloads} downloads
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className={s.card}>
            <div className={s.cardHead}>
              <h2>Histórico</h2>
            </div>
            <ol className={s.timeline}>
              {d.timeline.map((e, i) => (
                <li key={i}>
                  <div>
                    {e.label}
                    <small>
                      {dateTimeShortSP(e.at)}
                      {e.detail ? ` · ${e.detail}` : ""}
                      {e.actorRole ? ` · por ${(ROLE_LABEL as Record<string, string>)[e.actorRole]?.replace("Você é dono", "dono") ?? e.actorRole}` : ""}
                    </small>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <div className={s.stack}>
          <section className={s.card}>
            <div className={s.cardHead}>
              <h2>Cliente</h2>
            </div>
            <p style={{ margin: 0, fontWeight: 700, fontSize: 15 }}>{d.buyer.name}</p>
            <p style={{ margin: "4px 0 0" }} className={s.muted}>
              {d.buyer.email}
            </p>
            <p style={{ margin: "2px 0 0" }} className={s.muted}>
              {d.buyer.phone}
              {phoneDigits.length >= 10 ? (
                <>
                  {" · "}
                  <a href={`https://wa.me/55${phoneDigits.slice(-11)}`} target="_blank" rel="noreferrer" style={{ color: "var(--color-primary-ink)" }}>
                    abrir WhatsApp
                  </a>
                </>
              ) : null}
            </p>
            {d.buyer.cpfMasked ? (
              <p style={{ margin: "2px 0 0" }} className={s.muted}>
                {d.buyer.cpfMasked.includes("/") ? "CNPJ" : "CPF"} {d.buyer.cpfMasked}
              </p>
            ) : null}
          </section>

          <section className={s.card}>
            <div className={s.cardHead}>
              <h2>Entrega</h2>
            </div>
            <div className={s.rows}>
              <div className={s.row}>
                <span>Status</span>
                <span>{STATUS_LABEL[d.status]}</span>
              </div>
              <div className={s.row}>
                <span>Método</span>
                <span>{METHOD_LABEL[d.method]}</span>
              </div>
              {d.app ? (
                <>
                  <div className={s.row}>
                    <span>Conta no app</span>
                    <span className={s.mono}>{d.app.account}</span>
                  </div>
                  <div className={s.row}>
                    <span>Código do app</span>
                    <span className={s.mono}>{d.app.appCode ?? "—"}</span>
                  </div>
                  <div className={s.row}>
                    <span>
                      Aviso ao app
                      {noticeName ? (
                        <small className={s.muted} style={{ display: "block" }}>
                          {noticeName}
                        </small>
                      ) : null}
                    </span>
                    <span>
                      {noticeView ? (
                        <>
                          <Badge tone={noticeView.tone}>{noticeView.label}</Badge>
                          {noticeView.detail ? (
                            <small className={s.muted} style={{ display: "block" }}>
                              {noticeView.detail}
                            </small>
                          ) : null}
                        </>
                      ) : (
                        "após o pagamento"
                      )}
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <div className={s.row}>
                    <span>E-mail de acesso</span>
                    <span>
                      {d.emails.some((e) => e.kind === "delivery" && e.status === "sent")
                        ? "enviado"
                        : d.emails.some((e) => e.kind === "delivery")
                          ? "falhou (nova tentativa automática)"
                          : d.status === "paid"
                            ? "na fila"
                            : "após o pagamento"}
                    </span>
                  </div>
                  <div className={s.row}>
                    <span>Link pessoal</span>
                    <span>30 dias · 5 downloads</span>
                  </div>
                </>
              )}
            </div>
            {d.emails.length > 0 ? (
              <>
                <h3 className={s.label} style={{ margin: "14px 0 6px" }}>
                  E-mails
                </h3>
                <ul className={s.timeline}>
                  {d.emails.map((e, i) => (
                    <li key={i}>
                      <div>
                        {e.kind === "delivery" ? "Acesso ao comprador" : "Aviso ao vendedor"} · {e.status === "sent" ? "enviado" : "falhou"}
                        {e.deliveryStatus ? ` · ${DELIVERY_STATUS_LABEL[e.deliveryStatus] ?? e.deliveryStatus}` : ""}
                        <small>
                          {dateTimeShortSP(e.at)}
                          {e.error ? ` · ${e.error}` : ""}
                        </small>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </section>

          <section className={s.card}>
            <div className={s.cardHead}>
              <h2>Origem</h2>
            </div>
            <div className={s.rows}>
              {(["utm_source", "utm_medium", "utm_campaign", "utm_content"] as const).map((k) =>
                t[k] ? (
                  <div key={k} className={s.row}>
                    <span>{k}</span>
                    <span className={s.mono}>{t[k]}</span>
                  </div>
                ) : null,
              )}
              <div className={s.row}>
                <span>Indicação (ref)</span>
                <span className={s.mono}>{d.attribution.ref ?? "nenhuma"}</span>
              </div>
              <div className={s.row}>
                <span>Meta (fbclid)</span>
                <span>{d.attribution.hasFbc ? "capturado" : "não"}</span>
              </div>
            </div>
            {!t.utm_source ? <p className={s.hint}>Sem utm_source: conta como “direto”.</p> : null}
          </section>
        </div>
      </div>
    </>
  );
}
