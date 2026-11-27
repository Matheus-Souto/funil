import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrderPublic, type OrderPublic } from "@/lib/checkout";
import { brl, dateTimeSP, splitUniqueAmount, validUntilSP } from "@/lib/format";
import { getStoreBrandColor, resolveStore } from "@/lib/stores";
import s from "../../(design)/buyer.module.css";
import { Icon } from "../../(design)/icons";
import { BuyerShell } from "../../(design)/shell";
import { APP_ACCESS_TEXT } from "../../c/[slug]/texts";
import { regeneratePixAction } from "./actions";
import { PurchasePixel } from "./pixel";
import { CopyPixButton, OrderLive } from "./status";
import { pendingView } from "./view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Seu pedido", robots: { index: false } };

/** Página do pedido (frames 05, 06, 07 e 09 do canvas Doop). Nunca mostra e-mail, CPF ou ids internos. */
export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { publicId } = await params;
  const pixNotice = (await searchParams).pix;
  const store = await resolveStore((await headers()).get("host") ?? "");
  if (!store) notFound();
  const order = await getOrderPublic(store.id, publicId);
  if (!order) notFound();
  const brandColor = await getStoreBrandColor(store.id);

  return (
    <BuyerShell storeName={store.name} brandColor={brandColor}>
      {order.status === "pending" ? <OrderLive publicId={publicId} status={order.status} sessionClosed={order.app?.sessionClosed ?? null} /> : null}
      <OrderBody order={order} storeName={store.name} publicId={publicId} pixNotice={typeof pixNotice === "string" ? pixNotice : undefined} />
    </BuyerShell>
  );
}

function OrderBody({ order, storeName, publicId, pixNotice }: { order: OrderPublic; storeName: string; publicId: string; pixNotice?: string }) {
  switch (order.status) {
    case "pending":
      // Sessão do app encerrada antes de qualquer meio de pagamento (regra e exceção do cartão em `pendingView`).
      switch (pendingView(order)) {
        case "session_closed":
          return <AppSessionClosed order={order} closed={order.app!.sessionClosed!} />;
        case "pix_manual":
          return <ManualPix order={order} storeName={storeName} />;
        case "pix_asaas":
          return <AsaasPix order={order} storeName={storeName} publicId={publicId} pixNotice={pixNotice} />;
        default:
          return <CardPending order={order} />;
      }
    case "paid":
      return <ThankYou order={order} storeName={storeName} publicId={publicId} />;
    case "expired":
      return <Expired order={order} />;
    default:
      return <Closed order={order} />;
  }
}

const qrSrc = (pix: NonNullable<OrderPublic["pix"]>) =>
  pix.qrSvg ? `data:image/svg+xml;utf8,${encodeURIComponent(pix.qrSvg)}` : pix.qrImage ? `data:image/png;base64,${pix.qrImage}` : null;

function QrCard({ pix, amount, size }: { pix: NonNullable<OrderPublic["pix"]>; amount: number; size: number }) {
  const src = qrSrc(pix);
  if (!src) return null;
  return (
    <section className={`${s.card} ${s.qrCard}`}>
      <p className={`${s.p0} ${s.muted}`} style={{ fontSize: 14, fontWeight: 500 }}>
        Pagando de outro aparelho? Escaneie:
      </p>
      <div className={s.qrFrame}>
        {/* eslint-disable-next-line @next/next/no-img-element -- QR gerado no servidor (data URI) */}
        <img src={src} alt={`QR Code do Pix de ${brl(amount)}`} width={size} height={size} />
      </div>
    </section>
  );
}

function CodeBox({ code }: { code: string }) {
  return (
    <>
      <p className={s.codeLabel}>Pix copia e cola</p>
      <div className={s.code} data-testid="pix-code">
        {code}
      </div>
      <CopyPixButton code={code} />
    </>
  );
}

function ManualPix({ order, storeName }: { order: OrderPublic; storeName: string }) {
  const amount = order.manualAmountCents ?? order.totalCents;
  const [same, diff] = splitUniqueAmount(order.totalCents, amount);
  const extra = amount - order.totalCents;
  const pix = order.pix;
  return (
    <main className={s.main}>
      <div className={s.banner} role="status">
        <Icon name="hourglass" />
        <span>Pedido reservado · aguardando seu Pix</span>
      </div>
      <section className={s.card} style={{ padding: "24px 16px" }}>
        <p className={`${s.lead} ${s.center}`}>
          Pague <b>exatamente</b> este valor
        </p>
        <div className={s.uniqueBox}>
          <p className={`${s.uniqueAmount} ${s.money}`} data-testid="unique-amount" aria-label={brl(amount)}>
            {same}
            <span className={s.uniqueCents}>{diff}</span>
          </p>
        </div>
        <p className={s.infoLine}>
          <Icon name="info" />
          <span>
            {extra === 1 ? "O 1 centavo a mais identifica" : `Os ${extra} centavos a mais identificam`} o <b>seu</b> pedido no extrato da loja. Com outro valor, a
            liberação pode atrasar.
          </span>
        </p>
        {pix ? (
          <>
            <CodeBox code={pix.copyPaste} />
            <div className={s.rows}>
              {pix.receiver ? (
                <div className={s.row}>
                  <span>Recebedor</span>
                  <b>{pix.receiver}</b>
                </div>
              ) : null}
              <div className={s.row}>
                <span>Identificador</span>
                <b className={s.mono}>{pix.txid}</b>
              </div>
              {order.expiresAt ? (
                <div className={s.row}>
                  <span>Válido até</span>
                  <b>{validUntilSP(new Date(order.expiresAt))}</b>
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <p className={s.alert} role="alert">
            <Icon name="circle-alert" />
            <span>A loja ainda não configurou a chave Pix. Fale com a {storeName} antes de pagar.</span>
          </p>
        )}
      </section>
      <section className={`${s.card} ${s.steps}`}>
        <h2 className={s.sec} style={{ margin: 0 }}>
          E depois de pagar?
        </h2>
        <p className={`${s.step} ${s.p0}`}>
          <Icon name="badge-check" size={22} className={s.stepIcon} />
          <span>
            A {storeName} confere o pagamento <b>manualmente</b> no extrato do banco.
          </span>
        </p>
        <p className={`${s.step} ${s.p0}`}>
          <Icon name="mail" size={22} className={s.stepIcon} />
          <span>O envio acontece depois que o pagamento for conferido: o PDF chega no seu e-mail, normalmente em algumas horas.</span>
        </p>
        <p className={`${s.step} ${s.p0}`}>
          <Icon name="file-x" size={22} className={s.stepIcon} />
          <span>Não precisa enviar comprovante.</span>
        </p>
      </section>
      {pix ? <QrCard pix={pix} amount={amount} size={168} /> : null}
      <p className={s.foot}>Pedido #{order.code}</p>
    </main>
  );
}

function AsaasPix({ order, storeName, publicId, pixNotice }: { order: OrderPublic; storeName: string; publicId: string; pixNotice?: string }) {
  const pix = order.pix;
  const app = order.offer.delivery === "app";
  return (
    <main className={s.main}>
      <div className={s.banner} role="status" aria-live="polite">
        <span className={s.live} />
        <span>Aguardando pagamento</span>
        <span className={s.bannerAside}>Atualiza sozinho</span>
      </div>
      <section className={`${s.card} ${s.center}`} style={{ padding: "24px 16px" }}>
        <p className={s.lead}>Pague com Pix para receber o seu acesso</p>
        <p className={`${s.bigAmount} ${s.money}`}>{brl(order.totalCents)}</p>
        {order.expiresAt ? (
          <p className={`${s.p0} ${s.muted}`} style={{ marginTop: 8, fontSize: 14 }}>
            Válido até <b style={{ color: "var(--color-text)", fontWeight: 600 }}>{validUntilSP(new Date(order.expiresAt))}</b>
          </p>
        ) : null}
        {pix ? (
          <CodeBox code={pix.copyPaste} />
        ) : (
          <>
            <p className={s.alert} role="alert">
              <Icon name="circle-alert" />
              <span>
                {pixNotice === "limite"
                  ? "Você já pediu vários códigos. Aguarde alguns minutos e tente de novo."
                  : "O código Pix não ficou pronto. Toque abaixo para gerar um novo."}
              </span>
            </p>
            {/* POST (server action): nunca é disparado por um simples GET da página. Pedido de app com a sessão encerrada
                (vencida ou já paga): sem novo código; o comprador volta ao app. */}
            {app && !order.app?.sessionId ? (
              <BackToApp order={order} />
            ) : (
              <form action={regeneratePixAction.bind(null, publicId)}>
                <button type="submit" className={`${s.btn} ${s.btnLg} ${s.btnFull} ${s.mt12}`}>
                  <Icon name="refresh-cw" size={20} />
                  Gerar novo código Pix
                </button>
              </form>
            )}
          </>
        )}
      </section>
      <section className={s.card}>
        <h2 className={s.sec}>Como pagar</h2>
        <div className={s.steps}>
          <p className={`${s.step} ${s.p0}`}>
            <span className={s.stepNum}>1</span>
            <span>
              Abra o app do seu banco e entre na área <b>Pix</b>.
            </span>
          </p>
          <p className={`${s.step} ${s.p0}`}>
            <span className={s.stepNum}>2</span>
            <span>
              Escolha <b>Pix copia e cola</b> e cole o código.
            </span>
          </p>
          <p className={`${s.step} ${s.p0}`}>
            <span className={s.stepNum}>3</span>
            <span>
              Confira o valor de {brl(order.totalCents)} e a loja <b>{storeName}</b>, e confirme.
            </span>
          </p>
        </div>
      </section>
      {pix ? <QrCard pix={pix} amount={order.totalCents} size={184} /> : null}
      <p className={s.mailNote}>
        <Icon name={app ? "smartphone" : "mail"} />
        <span>
          {app ? APP_ACCESS_TEXT : "Assim que o pagamento for confirmado, enviamos o acesso para o e-mail que você informou."} Pode fechar esta página.
        </span>
      </p>
      <p className={s.foot}>
        Pedido #{order.code}
        {order.offer.methods.includes("card") && retryHref(order, true) ? (
          <>
            {" · "}
            {/* Pelo app, o cartão abre na mesma sessão (só enquanto ela serve; o checkout de app não abre sem ela). */}
            <Link href={retryHref(order, true)!}>Pagar com cartão</Link>
          </>
        ) : null}
      </p>
    </main>
  );
}

function CardPending({ order }: { order: OrderPublic }) {
  return (
    <main className={s.main}>
      <div className={s.banner} role="status" aria-live="polite">
        <span className={s.live} />
        <span>Pagamento em análise</span>
        <span className={s.bannerAside}>Atualiza sozinho</span>
      </div>
      <section className={`${s.card} ${s.center}`}>
        <p className={s.lead}>Estamos confirmando o pagamento de</p>
        <p className={`${s.bigAmount} ${s.money}`}>{brl(order.totalCents)}</p>
        <p className={s.heroText}>
          Não pague de novo: assim que o banco responder, esta página mostra o resultado
          {order.offer.delivery === "app" ? ". O acesso é liberado no app." : " e o acesso chega no seu e-mail."}
        </p>
      </section>
      <p className={s.foot}>Pedido #{order.code}</p>
    </main>
  );
}

function ThankYou({ order, storeName, publicId }: { order: OrderPublic; storeName: string; publicId: string }) {
  const paidWith = order.method === "card_asaas" ? "cartão" : "Pix";
  return (
    <main className={`${s.main} ${s.mainCenter}`}>
      {order.pixelId ? <PurchasePixel pixelId={order.pixelId} publicId={publicId} valueCents={order.totalCents} /> : null}
      <div className={s.hero}>
        <div className={s.heroIcon}>
          <Icon name="circle-check" size={38} />
        </div>
        <h1 className={s.heroTitle}>Pagamento confirmado!</h1>
        <p className={s.heroText} style={{ marginTop: 6 }}>
          Obrigado pela compra{order.buyerFirstName ? `, ${order.buyerFirstName}` : ""}.
        </p>
      </div>
      {order.offer.delivery === "app" ? (
        <section className={`${s.card} ${s.accessCard}`}>
          <div className={s.accessTop}>
            <span className={s.accessIcon}>
              <Icon name="smartphone" size={22} />
            </span>
            <div>
              <p className={s.accessTitle}>O acesso é liberado no app</p>
              <p className={`${s.p0} ${s.muted}`} style={{ marginTop: 4, fontSize: 15 }}>
                Volte ao app para usar o que você comprou.
              </p>
            </div>
          </div>
          {order.app?.returnUrl ? (
            <a className={`${s.btn} ${s.btnLg} ${s.btnFull} ${s.mt12}`} href={order.app.returnUrl}>
              Voltar ao app
            </a>
          ) : null}
        </section>
      ) : (
        <section className={`${s.card} ${s.accessCard}`}>
          <div className={s.accessTop}>
            <span className={s.accessIcon}>
              <Icon name="mail-check" size={22} />
            </span>
            <div>
              <p className={s.accessTitle}>Enviamos o acesso para seu e-mail</p>
              <p className={`${s.p0} ${s.muted}`} style={{ marginTop: 4, fontSize: 15 }}>
                No e-mail que você informou na compra.
              </p>
            </div>
          </div>
          <p className={`${s.p0} ${s.muted}`} style={{ marginTop: 14, fontSize: 14 }}>
            Não chegou em 5 minutos? Procure em <b style={{ color: "var(--color-text)" }}>Spam</b> ou <b style={{ color: "var(--color-text)" }}>Promoções</b>.
          </p>
        </section>
      )}
      {order.thankYouText ? (
        <section className={s.card}>
          <p className={s.eyebrow}>Uma mensagem da {storeName}</p>
          <p className={s.message}>{order.thankYouText}</p>
        </section>
      ) : null}
      <section className={s.card}>
        <div className={s.summaryHead}>
          <h2 className={s.summaryTitle}>Resumo do pedido</h2>
          <span className={s.pill}>Pago</span>
        </div>
        {order.items.map((i) => (
          <div className={s.li} key={i.name}>
            <span>{i.name}</span>
            <span className={s.money}>{brl(i.priceCents)}</span>
          </div>
        ))}
        <div className={s.divider} style={{ margin: "12px 0" }} />
        <div className={`${s.li} ${s.liStrong}`}>
          <span>Total pago com {paidWith}</span>
          <span className={s.money}>{brl(order.method === "pix_manual" && order.manualAmountCents ? order.manualAmountCents : order.totalCents)}</span>
        </div>
        <p className={`${s.p0} ${s.muted}`} style={{ marginTop: 6, fontSize: 13 }}>
          Pedido #{order.code} · {dateTimeSP(new Date(order.paidAt ?? order.createdAt))}
        </p>
      </section>
    </main>
  );
}

/**
 * Link de nova tentativa no checkout. Pedido de app: só com a sessão ainda utilizável (`?s=`); senão `null`, e a página
 * orienta reabrir o pagamento pelo app. Pedido de download: o checkout da oferta, como antes.
 */
function retryHref(order: OrderPublic, card = false): string | null {
  const q = new URLSearchParams();
  if (order.offer.delivery === "app") {
    if (!order.app?.sessionId) return null;
    q.set("s", order.app.sessionId);
  }
  if (card) q.set("metodo", "cartao");
  const qs = q.toString();
  return `/c/${order.offer.slug}${qs ? `?${qs}` : ""}`;
}

/** Pedido de app sem sessão utilizável: nova tentativa só pelo app (com o botão de volta quando o app mandou o retorno). */
function BackToApp({ order }: { order: OrderPublic }) {
  return (
    <>
      <p className={`${s.p0} ${s.muted}`}>Para pagar de novo, abra o pagamento outra vez pelo app.</p>
      {order.app?.returnUrl ? (
        <a className={`${s.btn} ${s.btnLg} ${s.btnFull}`} href={order.app.returnUrl}>
          Voltar ao app
        </a>
      ) : null}
    </>
  );
}

/** Pedido de app pendente com a sessão encerrada: só o desfecho e "Voltar ao app" (sem QR, código nem botões de pagar). */
function AppSessionClosed({ order, closed }: { order: OrderPublic; closed: "paid" | "expired" }) {
  const paid = closed === "paid";
  return (
    <main className={`${s.main} ${s.mainCenter}`}>
      <div className={s.hero}>
        <div className={s.heroIcon} data-tone="neutral">
          <Icon name={paid ? "circle-check" : "timer-off"} size={30} />
        </div>
        <h1 className={`${s.heroTitle} ${s.heroTitleSm}`}>{paid ? "Pagamento já concluído" : "Link de pagamento vencido"}</h1>
        <p className={s.heroText}>
          {paid ? (
            <>
              Este link já foi pago em outro pedido. <b>Não pague de novo:</b> o acesso é liberado no app.
            </>
          ) : (
            "Este link de pagamento venceu. Volte ao app e tente de novo."
          )}
        </p>
      </div>
      {order.app?.returnUrl ? (
        <section className={`${s.card} ${s.actions}`}>
          <a className={`${s.btn} ${s.btnLg} ${s.btnFull}`} href={order.app.returnUrl}>
            Voltar ao app
          </a>
        </section>
      ) : null}
      <p className={s.foot}>Pedido #{order.code}</p>
    </main>
  );
}

function Expired({ order }: { order: OrderPublic }) {
  const pixAgain = retryHref(order);
  const cardAgain = order.offer.methods.includes("card") ? retryHref(order, true) : null;
  return (
    <main className={`${s.main} ${s.mainCenter}`}>
      <div className={s.hero}>
        <div className={s.heroIcon} data-tone="neutral">
          <Icon name="timer-off" size={30} />
        </div>
        <h1 className={`${s.heroTitle} ${s.heroTitleSm}`}>Este Pix expirou</h1>
        <p className={s.heroText}>
          O código passou da validade e não foi pago a tempo. <b>Nenhum valor foi cobrado.</b>
        </p>
      </div>
      <section className={`${s.card} ${s.actions}`}>
        {order.items.map((i) => (
          <div className={s.li} key={i.name}>
            <span className={s.muted}>{i.name}</span>
            <b className={s.money}>{brl(i.priceCents)}</b>
          </div>
        ))}
        {pixAgain ? (
          <Link className={`${s.btn} ${s.btnLg} ${s.btnFull}`} href={pixAgain}>
            <Icon name="refresh-cw" size={20} />
            Gerar novo Pix
          </Link>
        ) : (
          <BackToApp order={order} />
        )}
        {cardAgain ? (
          <Link className={`${s.btn} ${s.btnLg} ${s.btnFull} ${s.btnSecondary}`} href={cardAgain}>
            <Icon name="credit-card" size={20} />
            Pagar com cartão
          </Link>
        ) : null}
      </section>
      <p className={s.infoBox}>
        <Icon name="info" />
        <span>
          <b>Pagou e mesmo assim apareceu esta tela?</b> Fale com a loja informando o pedido #{order.code}. Não pague de novo.
        </span>
      </p>
    </main>
  );
}

function Closed({ order }: { order: OrderPublic }) {
  const text: Record<string, { title: string; body: string }> = {
    declined: { title: "Pagamento não aprovado", body: "Nenhum valor foi cobrado. Você pode tentar de novo." },
    refunded: { title: "Pedido reembolsado", body: "O valor deste pedido foi devolvido." },
    disputed: { title: "Pedido em contestação", body: "O pagamento está em análise com o banco." },
  };
  const t = text[order.status] ?? { title: "Pedido encerrado", body: "Este pedido não está mais aguardando pagamento." };
  return (
    <main className={`${s.main} ${s.mainCenter}`}>
      <div className={s.hero}>
        <div className={s.heroIcon} data-tone={order.status === "declined" ? "danger" : "neutral"}>
          <Icon name={order.status === "declined" ? "credit-card" : "info"} size={30} />
        </div>
        <h1 className={`${s.heroTitle} ${s.heroTitleSm}`}>{t.title}</h1>
        <p className={s.heroText}>{t.body}</p>
      </div>
      {order.status === "declined" ? (
        <section className={`${s.card} ${s.actions}`}>
          {retryHref(order) ? (
            <Link className={`${s.btn} ${s.btnLg} ${s.btnFull}`} href={retryHref(order)!}>
              Tentar de novo
            </Link>
          ) : (
            <BackToApp order={order} />
          )}
        </section>
      ) : null}
      <p className={s.foot}>Pedido #{order.code}</p>
    </main>
  );
}
