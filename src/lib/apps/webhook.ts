// Aviso ao app (webhook de saída): o job `notify_app` manda o evento do pedido para a URL que a loja configurou
// (conexão `app_webhook`), assinado com o segredo da conexão. At-least-once: o `id` do evento é estável, e o app
// deduplica por ele. Novas tentativas pelo backoff próprio do aviso (1 min ... 24 h); esgotado, o aviso fica `failed`,
// o vendedor é avisado e o painel oferece "Reenviar aviso ao app".
//
// Ordem por pedido: cada aviso tem a `sequence` do pedido (no corpo, `dados.sequencia`) e só é enviado quando os
// anteriores do mesmo pedido já estão `delivered` ou `failed`; antes disso o job volta para a fila. Assim uma
// confirmação que falhou e ainda vai tentar de novo não chega depois do reembolso. Um aviso `failed` não segura os
// seguintes; "Reenviar aviso ao app" manda o não entregue mais antigo do pedido (com tudo entregue, o último), então
// um `failed` reenviado à mão pode chegar depois de avisos mais novos: é para isso que o app tem a `sequencia`
// (descartar transição antiga). Um aviso `pending` que ficou sem job (o job dele morreu na fila) não trava a fila do
// pedido: o próximo aviso o dá como `failed`, com alerta, e segue.
//
// Saída para um host escolhido pela loja (SSRF): só `https` em endereço público; o nome é resolvido uma vez, TODOS os
// endereços são conferidos e a conexão é FIXADA num deles (`node:https` com `lookup` próprio, como o SMTP fixa o IP
// em `pinSmtpTarget`): o nome original segue no `Host`, no SNI e na validação do certificado, e não há segunda
// resolução para um DNS trocar o destino no meio. Redirecionamento nunca é seguido; o corpo da resposta nunca é lido,
// guardado nem logado (só o código HTTP). Segredo, assinatura, URL e corpo nunca vão para log nem para erro. O corpo
// não leva e-mail, nome, telefone nem CPF/CNPJ: o app já conhece a conta.
import { createHmac } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { and, asc, eq, gt, inArray, lt, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction } from "@/lib/actions/core";
import { alertSeller } from "@/lib/alerts";
import { withStore, type Tx } from "@/lib/db/client";
import { appWebhookDelivery, job, offer, orders } from "@/lib/db/schema";
import { isPublicAddress } from "@/lib/delivery/mailer";
import { env } from "@/lib/env";
import { readIntegration } from "@/lib/integrations";
import { enqueue, type JobHandler, type Timer } from "@/lib/jobs";
import { log } from "@/lib/log";
import { APP_WEBHOOK_BACKOFF_SECONDS, noticeToResend, type AppEventType } from "./events";

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
/** Aviso que espera um anterior do mesmo pedido volta à fila por pelo menos isto (ou até a próxima tentativa do anterior). */
export const APP_WEBHOOK_ORDER_WAIT_SECONDS = 30;

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
  /** No lugar da conexão de verdade (`pinnedPost`): recebe a URL e o endereço já conferido. */
  transport?: Transport;
  now?: () => Date;
  timer?: Timer;
}
let overrides: TestOverrides = {};
/** Só para testes: troca a resolução de nomes, a conexão, o relógio e o tempo-limite (sem argumento, volta ao padrão). */
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

interface Destination {
  url: URL;
  /** O endereço conferido em que a conexão é fixada. */
  address: string;
}

/**
 * A URL e o endereço prontos para o envio, ou `null` se o destino não é aceito: precisa ser `https` sem credencial, e
 * TODOS os endereços do nome precisam ser públicos (`isPublicAddress`). Com `APP_WEBHOOK_ALLOW_LOOPBACK=1` (só testes;
 * o env só a aceita com `BASE_URL` em loopback) um destino inteiro em loopback também vale, em `http` ou `https`.
 */
async function destinationOf(raw: string): Promise<Destination | null> {
  const d = await checkDestination(raw);
  return d === "unresolved" ? null : d;
}

/** Como `destinationOf`, mas distingue o nome que não resolveu (`"unresolved"`) do destino recusado (`null`). */
async function checkDestination(raw: string): Promise<Destination | "unresolved" | null> {
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
  if (addresses.length === 0) return "unresolved";
  const address = addresses[0]!;
  if (allowLoopback() && addresses.every(isLoopbackAddress)) return { url, address };
  if (url.protocol !== "https:") return null;
  return addresses.every(isPublicAddress) ? { url, address } : null;
}

/** O destino seria aceito agora? (A configuração do webhook no painel usa a mesma regra do envio.) */
export async function appWebhookDestinationAllowed(url: string): Promise<boolean> {
  return (await destinationOf(url)) !== null;
}

/** Por que o destino não seria aceito agora: `null` (aceito), `"unresolved"` (o nome não resolveu) ou `"blocked"`. */
export async function appWebhookDestinationProblem(url: string): Promise<null | "unresolved" | "blocked"> {
  const d = await checkDestination(url);
  return d === "unresolved" ? "unresolved" : d === null ? "blocked" : null;
}

// ---- envio -----------------------------------------------------------------------------------------------------

export interface AppWebhookResult {
  ok: boolean;
  /** Código HTTP da resposta; `null` quando não houve resposta (destino recusado, rede, tempo-limite). */
  httpStatus: number | null;
  reason: "ok" | "http" | "blocked" | "network" | "timeout" | "not_configured";
}

type Transport = (req: { url: URL; address: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<number>;

/**
 * POST com a conexão fixada em `address`: o `lookup` do socket devolve só o endereço já conferido (nenhuma consulta de
 * DNS acontece aqui), e o nome da URL continua valendo para o `Host`, o SNI e o certificado. Sem agente compartilhado
 * (conexão nova a cada envio, nunca um socket reaproveitado de outro destino). Não segue redirecionamento (o
 * `node:http` não segue) e descarta o corpo da resposta sem ler: devolve só o código HTTP.
 */
const pinnedPost: Transport = ({ url, address, headers, body, signal }) =>
  new Promise<number>((resolve, reject) => {
    const family = isIP(address) === 6 ? 6 : 4;
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    };
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      { method: "POST", agent: false, lookup, signal, headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) } },
      (res) => {
        const status = res.statusCode ?? 0;
        res.destroy();
        resolve(status);
      },
    );
    const onAbort = () => req.destroy(new Error("cancelado"));
    signal.addEventListener("abort", onAbort, { once: true });
    req.on("close", () => signal.removeEventListener("abort", onAbort));
    req.on("error", reject);
    req.end(body);
  });

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
    const dest = await untilAbort(destinationOf(target.url), all);
    if (!dest) return { ok: false, httpStatus: null, reason: "blocked" };
    const status = await (overrides.transport ?? pinnedPost)({
      url: dest.url,
      address: dest.address,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "funil-webhook/1",
        "Funil-Evento": event.id,
        "Funil-Assinatura": signAppWebhook(target.secret, event.body, Math.floor(clockNow().getTime() / 1000)),
      },
      body: event.body,
      signal: all,
    });
    const ok = status >= 200 && status < 300;
    return { ok, httpStatus: status, reason: ok ? "ok" : "http" };
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

/**
 * Dados do pedido para o corpo: só a conta, o pedido público, o código do app, o valor, o método, quando pagou e a
 * sequência. Não dependem do estado de agora (uma confirmação enviada depois do reembolso é a mesma confirmação).
 */
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
    // Ordem do aviso dentro do pedido: o app descarta um aviso com sequência menor que a última que aplicou.
    sequencia: d.sequence,
  };
  // Soma devolvida até esta ocorrência, gravada na linha quando ela nasceu: as novas tentativas mandam o mesmo valor.
  if (d.eventType === "pagamento.reembolso_parcial") dados.valor_estornado_centavos = d.refundedCents;
  return dados;
}

/** Jobs `notify_app` abertos (da loja) de um aviso. O `job` não tem RLS por loja: o filtro de loja é explícito. */
const jobsOfDelivery = (storeId: string, deliveryId: string) =>
  and(eq(job.type, "notify_app"), eq(job.storeId, storeId), sql`${job.payload}->>'deliveryId' = ${deliveryId}`);

const OPEN_JOB = ["queued", "running"];

/**
 * Aviso anterior do mesmo pedido ainda sem desfecho (`pending`)? Então este espera: devolve quando olhar de novo (logo
 * depois da próxima tentativa do anterior, e nunca antes de `APP_WEBHOOK_ORDER_WAIT_SECONDS`). Sem anterior pendente,
 * `null`.
 *
 * Só espera por um anterior que ainda vai ser tentado, isto é, que tem job na fila ou rodando. Um anterior `pending`
 * SEM job aberto (o job dele falhou de vez na fila) nunca teria desfecho, e este aviso voltaria à fila para sempre:
 * ele é dado como `failed`, com o alerta ao vendedor (que pode reenviá-lo), e a conferência segue para o próximo.
 */
async function waitForEarlier(tx: Tx, storeId: string, d: Delivery, at: Date): Promise<Date | null> {
  if (d.orderId === null || d.sequence === null) return null;
  const floor = at.getTime() + APP_WEBHOOK_ORDER_WAIT_SECONDS * 1000;
  // Cada volta resolve um anterior ou termina; o teto é só defesa contra uma corrida que não se desfaz.
  for (let i = 0; i < 100; i++) {
    const [earlier] = await tx
      .select({ id: appWebhookDelivery.id, orderId: appWebhookDelivery.orderId })
      .from(appWebhookDelivery)
      .where(and(eq(appWebhookDelivery.orderId, d.orderId), lt(appWebhookDelivery.sequence, d.sequence), eq(appWebhookDelivery.status, "pending")))
      .orderBy(asc(appWebhookDelivery.sequence))
      .limit(1);
    if (!earlier) return null;
    const open = and(jobsOfDelivery(storeId, earlier.id), inArray(job.status, OPEN_JOB));
    const jobs = await tx.select({ status: job.status, runAt: job.runAt }).from(job).where(open);
    if (jobs.length > 0) {
      const next = jobs.filter((x) => x.status === "queued").map((x) => x.runAt.getTime());
      return new Date(Math.max(floor, next.length > 0 ? Math.min(...next) + 1000 : 0));
    }
    // Numa instrução só: continua `pending` E sem job aberto (um job que entrou neste meio-tempo o mantém na fila).
    const abandoned = await tx
      .update(appWebhookDelivery)
      .set({ status: "failed" })
      .where(and(eq(appWebhookDelivery.id, earlier.id), eq(appWebhookDelivery.status, "pending"), notExists(tx.select({ one: sql`1` }).from(job).where(open))))
      .returning({ id: appWebhookDelivery.id });
    if (abandoned.length > 0) {
      await alertSeller(tx, storeId, "app_webhook_falhou", { orderId: d.orderId });
      log.warn("aviso ao app pendente sem job na fila; dado como falho para não travar os seguintes", { deliveryId: earlier.id, orderId: d.orderId });
    }
  }
  return new Date(floor);
}

/** Um aviso teve desfecho (entregue ou falho de vez): os seguintes do pedido que esperavam por ele saem agora. */
async function wakeLater(tx: Tx, storeId: string, d: Delivery, at: Date): Promise<void> {
  if (d.orderId === null || d.sequence === null) return;
  const later = await tx
    .select({ id: appWebhookDelivery.id })
    .from(appWebhookDelivery)
    .where(and(eq(appWebhookDelivery.orderId, d.orderId), gt(appWebhookDelivery.sequence, d.sequence), eq(appWebhookDelivery.status, "pending")));
  if (later.length === 0) return;
  await tx
    .update(job)
    .set({ runAt: at })
    .where(
      and(
        eq(job.type, "notify_app"),
        eq(job.storeId, storeId),
        eq(job.status, "queued"),
        gt(job.runAt, at),
        inArray(sql`${job.payload}->>'deliveryId'`, later.map((x) => x.id)),
      ),
    );
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
    if (done.length === 0) return "stale";
    await wakeLater(tx, storeId, d, at);
    return "delivered";
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
    await wakeLater(tx, storeId, d, at);
    return "failed";
  }
  await enqueue(tx, { storeId, type: "notify_app", payload: { deliveryId: d.id }, runAt: new Date(at.getTime() + wait * 1000) });
  return "retry";
}

/**
 * Job `notify_app` {deliveryId}. At-least-once e idempotente: só envia um aviso `pending`; o `id` do evento é o da linha
 * (estável), então um envio repetido é deduplicado pelo app. HTTP fora de transação. Falha do app (ou loja sem a conexão
 * configurada) não lança: conta a tentativa na linha e agenda a próxima pelo backoff do aviso. Em ordem por pedido: com
 * um aviso anterior ainda pendente, este volta para a fila sem contar tentativa.
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
    const again = await waitForEarlier(tx, storeId, d, clockNow());
    if (again) {
      // Não é uma tentativa: o aviso só troca de job (este termina, o próximo olha de novo).
      await enqueue(tx, { storeId, type: "notify_app", payload: { deliveryId: d.id }, runAt: again });
      return { skip: "aguardando_aviso_anterior" } as const;
    }
    const dados = d.orderId ? await orderData(tx, d) : {};
    if (dados === null) {
      // O pedido do aviso não é (mais) de app: não há o que mandar. O aviso tem desfecho (`failed`, com alerta) em vez
      // de ficar `pending` sem job, segurando os seguintes do pedido.
      const closed = await tx
        .update(appWebhookDelivery)
        .set({ status: "failed" })
        .where(and(eq(appWebhookDelivery.id, d.id), eq(appWebhookDelivery.status, "pending")))
        .returning({ id: appWebhookDelivery.id });
      if (closed.length > 0) {
        await alertSeller(tx, storeId, "app_webhook_falhou", { orderId: d.orderId! });
        await wakeLater(tx, storeId, d, clockNow());
      }
      return { skip: "pedido_nao_e_de_app" } as const;
    }
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
  description:
    "Reenvia ao app o aviso não entregue mais antigo do pedido (com tudo entregue, o último), com o mesmo id de evento (o app deduplica por ele).",
  input: z.object({ orderId: z.uuid() }),
  permission: "orders.resend",
  async run(ctx, { orderId }) {
    const [o] = await ctx.tx.select({ id: orders.id, appAccount: orders.appAccount }).from(orders).where(eq(orders.id, orderId)).for("update");
    if (!o) throw new ActionError("not_found", "Pedido não encontrado");
    // O pedido está travado (acima): nenhum aviso novo nasce no meio. Um `failed` que não é o último também é alcançado.
    const d = await noticeToResend(ctx.tx, o.id);
    if (o.appAccount === null || !d) throw new ActionError("conflict", "Este pedido não tem aviso ao app para reenviar.");
    const open = await ctx.tx
      .select({ id: job.id, status: job.status })
      .from(job)
      // Só jobs DESTA loja: um job de outra loja com o mesmo `deliveryId` no payload nunca é adiantado nem conta.
      .where(and(jobsOfDelivery(ctx.storeId, d.id), inArray(job.status, ["queued", "running"])));
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
            .where(and(inArray(job.id, open.map((x) => x.id)), eq(job.storeId, ctx.storeId), eq(job.status, "queued")))
            .returning({ id: job.id })
        : [];
    if (advanced.length === 0) await enqueue(ctx.tx, { storeId: ctx.storeId, type: "notify_app", payload: { deliveryId: d.id }, runAt: now });
    return { orderId: o.id, queued: true };
  },
});
