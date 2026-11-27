// Aviso ao app (webhook de saída): o job `notify_app` manda o evento do pedido para a URL que a loja configurou
// (conexão `app_webhook`), assinado com o segredo da conexão. At-least-once: o `id` do evento é estável, e o app
// deduplica por ele. Novas tentativas pelo backoff próprio do aviso (1 min ... 24 h); esgotado, o aviso fica `failed`,
// o vendedor é avisado e o painel oferece "Reenviar aviso ao app".
//
// Saída para um host escolhido pela loja (SSRF): só `https` em endereço público, conferido logo antes de conectar;
// redirecionamento nunca é seguido; o corpo da resposta nunca é lido, guardado nem logado (só o código HTTP). O que
// sobra: entre a conferência e a conexão o nome pode resolver para outro endereço (o `fetch` resolve de novo). Com
// `https` obrigatório, o destino trocado ainda precisaria apresentar um certificado válido para o nome da URL.
// Segredo, assinatura, URL e corpo nunca vão para log nem para erro. O corpo não leva e-mail, nome, telefone nem
// CPF/CNPJ: o app já conhece a conta.
import { createHmac } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction } from "@/lib/actions/core";
import { alertSeller } from "@/lib/alerts";
import { withStore, type Tx } from "@/lib/db/client";
import { appWebhookDelivery, job, offer, orders, payment } from "@/lib/db/schema";
import { isPublicAddress } from "@/lib/delivery/mailer";
import { env } from "@/lib/env";
import { readIntegration } from "@/lib/integrations";
import { enqueue, type JobHandler, type Timer } from "@/lib/jobs";
import { log } from "@/lib/log";
import { APP_WEBHOOK_BACKOFF_SECONDS, type AppEventType } from "./events";

export {
  APP_WEBHOOK_BACKOFF_SECONDS,
  APP_WEBHOOK_MAX_ATTEMPTS,
  appEventId,
  enqueueAppNotice,
  type AppEventType,
  type AppPaymentEventType,
} from "./events";

/** O app precisa responder 2xx neste prazo (resolução do nome incluída). */
export const APP_WEBHOOK_TIMEOUT_MS = 10_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cabeçalho `Funil-Assinatura`: `t=<unix>,v1=<hex HMAC-SHA256(segredo, t + "." + corpo)>`. */
export function signAppWebhook(secret: string, body: string, t: number): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

// ---- testes: rede, relógio e tempo-limite injetados ------------------------------------------------------------

type Lookup = (host: string) => Promise<string[]>;
interface TestOverrides {
  /** No lugar de `APP_WEBHOOK_ALLOW_LOOPBACK` (o `env` é lido uma vez por processo). */
  allowLoopback?: boolean;
  lookup?: Lookup;
  fetch?: typeof fetch;
  now?: () => Date;
  timer?: Timer;
}
let overrides: TestOverrides = {};
/** Só para testes: troca a resolução de nomes, o `fetch`, o relógio e o tempo-limite (sem argumento, volta ao padrão). */
export function setAppWebhookForTests(o: TestOverrides = {}): void {
  overrides = o;
}

const defaultLookup: Lookup = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);
const realTimer: Timer = (ms, onTimeout) => {
  const h = setTimeout(onTimeout, ms);
  h.unref?.();
  return () => clearTimeout(h);
};
const clockNow = (): Date => (overrides.now ?? (() => new Date()))();
const allowLoopback = (): boolean => overrides.allowLoopback ?? env.APP_WEBHOOK_ALLOW_LOOPBACK === "1";

// ---- destino permitido -----------------------------------------------------------------------------------------

/** `::ffff:a00:1` (como o `URL` normaliza um IPv4 mapeado) -> `10.0.0.1`; o resto volta igual. */
function unmapV4(ip: string): string {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (dotted) return dotted[1]!;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (!hex) return ip;
  const hi = parseInt(hex[1]!, 16);
  const lo = parseInt(hex[2]!, 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

const isLoopbackAddress = (ip: string): boolean => ip === "::1" || (isIP(ip) === 4 && ip.startsWith("127."));

/**
 * A URL pronta para o envio, ou `null` se o destino não é aceito: precisa ser `https` sem credencial, e TODOS os
 * endereços do nome precisam ser públicos (`isPublicAddress`). Com `APP_WEBHOOK_ALLOW_LOOPBACK=1` (só testes; o env só
 * a aceita com `BASE_URL` em loopback) um destino inteiro em loopback também vale, em `http` ou `https`.
 */
async function destinationOf(raw: string): Promise<URL | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await (overrides.lookup ?? defaultLookup)(host);
  } catch {
    addresses = [];
  }
  addresses = addresses.map(unmapV4);
  if (addresses.length === 0) return null;
  if (allowLoopback() && addresses.every(isLoopbackAddress)) return url;
  if (url.protocol !== "https:") return null;
  return addresses.every(isPublicAddress) ? url : null;
}

/** O destino seria aceito agora? (A configuração do webhook no painel usa a mesma regra do envio.) */
export async function appWebhookDestinationAllowed(url: string): Promise<boolean> {
  return (await destinationOf(url)) !== null;
}

// ---- envio -----------------------------------------------------------------------------------------------------

export interface AppWebhookResult {
  ok: boolean;
  /** Código HTTP da resposta; `null` quando não houve resposta (destino recusado, rede, tempo-limite). */
  httpStatus: number | null;
  reason: "ok" | "http" | "blocked" | "network" | "timeout" | "not_configured";
}

/** Rejeita quando `signal` aborta (a resolução de nomes não é cancelável). */
function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("cancelado"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("cancelado"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Manda um evento ao app: POST do corpo cru com `Funil-Assinatura` (do instante do envio) e `Funil-Evento`. Entregue só
 * com 2xx dentro do prazo; 3xx é falha (o redirecionamento não é seguido). Nunca lança por falha do app ou da rede
 * (o erro do runtime pode trazer a URL e é descartado); só repassa o cancelamento do worker (`signal`).
 */
export async function sendAppWebhook(target: { url: string; secret: string }, event: { id: string; body: string }, signal?: AbortSignal): Promise<AppWebhookResult> {
  const ctrl = new AbortController();
  let timedOut = false;
  const cancel = (overrides.timer ?? realTimer)(APP_WEBHOOK_TIMEOUT_MS, () => {
    timedOut = true;
    ctrl.abort(new Error("tempo-limite do aviso ao app"));
  });
  const all = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
  try {
    const url = await untilAbort(destinationOf(target.url), all);
    if (!url) return { ok: false, httpStatus: null, reason: "blocked" };
    const res = await (overrides.fetch ?? fetch)(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "funil-webhook/1",
        "Funil-Evento": event.id,
        "Funil-Assinatura": signAppWebhook(target.secret, event.body, Math.floor(clockNow().getTime() / 1000)),
      },
      body: event.body,
      // Nunca seguir: o destino de um redirecionamento não passou pela conferência de endereço.
      redirect: "manual",
      signal: all,
    });
    // O corpo da resposta não interessa: descartado sem ler.
    await res.body?.cancel().catch(() => undefined);
    const ok = res.status >= 200 && res.status < 300;
    return { ok, httpStatus: res.status, reason: ok ? "ok" : "http" };
  } catch {
    if (signal?.aborted && !timedOut) throw signal.reason instanceof Error ? signal.reason : new Error("job cancelado");
    return { ok: false, httpStatus: null, reason: timedOut ? "timeout" : "network" };
  } finally {
    cancel();
  }
}

// ---- job notify_app --------------------------------------------------------------------------------------------

type Delivery = typeof appWebhookDelivery.$inferSelect;

/** O método como o app o vê: sem o nome do provedor. */
const METHOD: Record<string, string> = { pix_asaas: "pix", pix_manual: "pix", card_asaas: "cartao" };

/** Dados do pedido para o corpo: só a conta, o pedido público, o código do app, o valor, o método e quando pagou. */
async function orderData(tx: Tx, d: Delivery): Promise<Record<string, unknown> | null> {
  const [row] = await tx
    .select({
      account: orders.appAccount,
      publicId: orders.publicId,
      totalCents: orders.totalCents,
      method: orders.method,
      paidAt: orders.paidAt,
      appCode: offer.appCode,
    })
    .from(orders)
    .innerJoin(offer, eq(offer.id, orders.offerId))
    .where(eq(orders.id, d.orderId!));
  if (!row || row.account === null) return null;
  const dados: Record<string, unknown> = {
    conta: row.account,
    pedido: row.publicId,
    app_code: row.appCode,
    valor_centavos: row.totalCents,
    metodo: METHOD[row.method] ?? row.method,
    pago_em: row.paidAt ? row.paidAt.toISOString() : null,
  };
  if (d.eventType === "pagamento.reembolso_parcial") {
    // Soma já devolvida ao comprador, como o webhook do Asaas a registrou (`notePartialRefund`).
    const pays = await tx.select({ raw: payment.raw }).from(payment).where(eq(payment.orderId, d.orderId!));
    const back = pays.map((p) => (p.raw as { partialRefundCents?: unknown } | null)?.partialRefundCents).filter((v): v is number => typeof v === "number" && Number.isInteger(v));
    dados.valor_estornado_centavos = back.length > 0 ? Math.max(...back) : 0;
  }
  return dados;
}

/**
 * Grava o resultado da tentativa numa transação curta. Só vale se o aviso ainda está `pending` (e, na falha, com a
 * mesma contagem lida antes do envio): um reenvio ou outro job no meio não gera nova tentativa nem alerta em dobro.
 */
async function recordAttempt(tx: Tx, storeId: string, d: Delivery, r: AppWebhookResult, at: Date): Promise<"delivered" | "retry" | "failed" | "stale"> {
  const pending = and(eq(appWebhookDelivery.id, d.id), eq(appWebhookDelivery.status, "pending"));
  const attempts = sql`${appWebhookDelivery.attempts} + 1`;
  if (r.ok) {
    const done = await tx
      .update(appWebhookDelivery)
      .set({ status: "delivered", attempts, lastHttpStatus: r.httpStatus, deliveredAt: at })
      .where(pending)
      .returning({ id: appWebhookDelivery.id });
    return done.length > 0 ? "delivered" : "stale";
  }
  const wait = APP_WEBHOOK_BACKOFF_SECONDS[d.attempts];
  const failed = await tx
    .update(appWebhookDelivery)
    .set({ status: wait === undefined ? "failed" : "pending", attempts, lastHttpStatus: r.httpStatus })
    .where(and(pending, eq(appWebhookDelivery.attempts, d.attempts)))
    .returning({ id: appWebhookDelivery.id });
  if (failed.length === 0) return "stale";
  if (wait === undefined) {
    await alertSeller(tx, storeId, "app_webhook_falhou", {
      ...(d.orderId ? { orderId: d.orderId } : {}),
      ...(r.httpStatus !== null ? { httpStatus: r.httpStatus } : {}),
    });
    return "failed";
  }
  await enqueue(tx, { storeId, type: "notify_app", payload: { deliveryId: d.id }, runAt: new Date(at.getTime() + wait * 1000) });
  return "retry";
}

/**
 * Job `notify_app` {deliveryId}. At-least-once e idempotente: só envia um aviso `pending`; o `id` do evento é o da linha
 * (estável), então um envio repetido é deduplicado pelo app. HTTP fora de transação. Falha do app (ou loja sem a conexão
 * configurada) não lança: conta a tentativa na linha e agenda a próxima pelo backoff do aviso.
 */
export const notifyAppJob: JobHandler = async (j, signal) => {
  const storeId = j.storeId;
  const deliveryId = (j.payload as { deliveryId?: unknown } | null)?.deliveryId;
  if (!storeId || typeof deliveryId !== "string" || !UUID.test(deliveryId)) {
    log.error("notify_app: payload inválido; job descartado", { id: j.id });
    return;
  }
  const prep = await withStore(storeId, async (tx) => {
    const [d] = await tx.select().from(appWebhookDelivery).where(eq(appWebhookDelivery.id, deliveryId));
    if (!d) return { skip: "inexistente" } as const;
    if (d.status !== "pending") return { skip: d.status } as const;
    const dados = d.orderId ? await orderData(tx, d) : {};
    if (dados === null) return { skip: "pedido_nao_e_de_app" } as const;
    const conn = await readIntegration(tx, storeId, "app_webhook");
    const url = typeof conn?.config.url === "string" ? conn.config.url : null;
    const target = url && conn?.secret ? { url, secret: conn.secret } : null;
    const body = JSON.stringify({ id: d.eventId, tipo: d.eventType as AppEventType, criado_em: d.createdAt.toISOString(), dados });
    return { d, target, body } as const;
  });
  if ("skip" in prep) {
    log.info("notify_app: nada a enviar", { deliveryId, reason: prep.skip });
    return;
  }
  const { d } = prep;
  const result: AppWebhookResult = prep.target
    ? await sendAppWebhook(prep.target, { id: d.eventId, body: prep.body }, signal)
    : { ok: false, httpStatus: null, reason: "not_configured" };
  const outcome = await withStore(storeId, (tx) => recordAttempt(tx, storeId, d, result, clockNow()));
  const fields = { deliveryId, orderId: d.orderId, eventType: d.eventType, attempt: d.attempts + 1, httpStatus: result.httpStatus, reason: result.reason, outcome };
  if (outcome === "delivered") log.info("aviso ao app entregue", fields);
  else log.warn("aviso ao app não entregue", fields);
};

// ---- apps.resendNotice -----------------------------------------------------------------------------------------

export const resendAppNotice = defineAction({
  name: "apps.resendNotice",
  description: "Reenvia ao app o último aviso do pedido, com o mesmo id de evento (o app deduplica por ele).",
  input: z.object({ orderId: z.uuid() }),
  permission: "orders.resend",
  async run(ctx, { orderId }) {
    const [o] = await ctx.tx.select({ id: orders.id, appAccount: orders.appAccount }).from(orders).where(eq(orders.id, orderId)).for("update");
    if (!o) throw new ActionError("not_found", "Pedido não encontrado");
    const [d] = await ctx.tx
      .select({ id: appWebhookDelivery.id })
      .from(appWebhookDelivery)
      .where(eq(appWebhookDelivery.orderId, o.id))
      .orderBy(desc(appWebhookDelivery.createdAt), desc(appWebhookDelivery.id))
      .limit(1)
      .for("update");
    if (o.appAccount === null || !d) throw new ActionError("conflict", "Este pedido não tem aviso ao app para reenviar.");
    const open = await ctx.tx
      .select({ id: job.id, status: job.status })
      .from(job)
      .where(and(eq(job.type, "notify_app"), inArray(job.status, ["queued", "running"]), sql`${job.payload}->>'deliveryId' = ${d.id}`));
    // Um envio em andamento grava o próprio resultado: não mexe no aviso por baixo dele.
    if (open.some((x) => x.status === "running")) return { orderId: o.id, queued: false };
    // Mesma linha, mesmo id de evento; as tentativas recomeçam.
    await ctx.tx.update(appWebhookDelivery).set({ status: "pending", attempts: 0, deliveredAt: null }).where(eq(appWebhookDelivery.id, d.id));
    const now = clockNow();
    // Já há nova tentativa agendada: adianta em vez de criar outro job. Se o worker a pegou neste meio-tempo (nenhuma
    // linha adiantada), entra um job novo: um envio a mais com o mesmo id é inofensivo, um aviso sem job não.
    const advanced =
      open.length > 0
        ? await ctx.tx
            .update(job)
            .set({ runAt: now })
            .where(and(inArray(job.id, open.map((x) => x.id)), eq(job.status, "queued")))
            .returning({ id: job.id })
        : [];
    if (advanced.length === 0) await enqueue(ctx.tx, { storeId: ctx.storeId, type: "notify_app", payload: { deliveryId: d.id }, runAt: now });
    return { orderId: o.id, queued: true };
  },
});
