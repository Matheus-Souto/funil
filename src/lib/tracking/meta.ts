// Meta: conexão (Pixel ID + token da API de Conversões), dados do comprador em hash e o job `meta_event`, que manda
// `Purchase` e `InitiateCheckout` à API de Conversões com o MESMO event id do Pixel no navegador (o Meta deduplica):
//   - InitiateCheckout: `eventId` gerado na página do checkout (enviado em `checkout.start`);
//   - Purchase: `purchase:<publicId>` (nunca o id interno do pedido: a página pública também dispara com este id);
//   - StartTrial: início do teste de um app (`apps.registerTrial`), com o `event_id` do registro de teste
//     (`trial:<id>` ou o que o app mandou para deduplicar com o Pixel dele); marca em `conversion` por `trial_id`.
// Reembolso não é enviado ao Meta. Nenhuma chamada ao Meta dentro de transação do banco.
//
// Versão da Graph API: v27.0 (a mais recente em 18/11/2026, lançada em 4/11/2026; fonte:
// https://developers.facebook.com/docs/graph-api/changelog/ e
// https://developers.facebook.com/documentation/ads-commerce/conversions-api/using-the-api).
// Normalização dos dados (https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/customer-information-parameters):
// em = minúsculo e sem espaços; ph = só dígitos com código do país; fn/ln = minúsculos, sem pontuação, acentos
// mantidos (UTF-8); country = código ISO de 2 letras minúsculo; tudo em SHA-256. external_id = SHA-256 do id do cliente.
// client_ip_address, client_user_agent, fbc e fbp vão sem hash.
import { createHash } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction } from "@/lib/actions/core";
import { withStore, type Tx } from "@/lib/db/client";
import { appTrial, conversion, customer, integration, offer, orderItem, orders, store } from "@/lib/db/schema";
import { storeBaseUrl } from "@/lib/delivery/links";
import { env } from "@/lib/env";
import { getIntegration, saveIntegration } from "@/lib/integrations";
import { enqueue, type JobHandler } from "@/lib/jobs";
import { log } from "@/lib/log";
import { limitConnectionTest } from "@/lib/mcp/limits";
import { itemOrder } from "@/lib/orders/items";
import { META_EVENT_ID_RE } from "./touch";

export const META_GRAPH_VERSION = "v27.0";
const GRAPH_BASE_URL = "https://graph.facebook.com";
export const PIXEL_ID_RE = /^\d{5,20}$/;
const TIMEOUT_MS = 15_000;
/** O Meta recusa a requisição inteira se `event_time` tiver mais de 7 dias. */
const MAX_EVENT_AGE_S = 7 * 24 * 3600 - 300;

export type MetaEventName = "Purchase" | "InitiateCheckout" | "StartTrial";
export const purchaseEventId = (publicId: string): string => `purchase:${publicId}`;

let fetchOverride: typeof fetch | undefined;
/** Testes: troca o `fetch` usado com o Meta (sem argumento volta ao normal). */
export function setMetaFetchForTests(f?: typeof fetch): void {
  fetchOverride = f;
}

/** Base da Graph API (o env só aceita outra base em loopback: Meta falso do smoke). */
const graphBase = () => (env.META_GRAPH_BASE_URL ?? GRAPH_BASE_URL).replace(/\/+$/, "");

/** Erro da Graph API: só status e códigos (nunca a mensagem do Meta, o token ou o corpo enviado). */
export class MetaApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: number | null,
    public readonly subcode: number | null,
  ) {
    super(status === 0 ? "Meta inacessível" : `Meta respondeu ${status}${code !== null ? ` (código ${code}${subcode !== null ? `/${subcode}` : ""})` : ""}`);
    this.name = "MetaApiError";
  }
}

const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const abortError = (signal: AbortSignal) => (signal.reason instanceof Error ? signal.reason : new Error("cancelado"));

/**
 * Erro que não adianta re-tentar: token inválido/expirado (190), parâmetro inválido (100) ou permissão (200-299).
 * Os demais (5xx, 429, rede, 1/2/4/17/613 e desconhecidos) são transitórios e a fila re-tenta.
 */
export function isPermanentMetaError(e: MetaApiError): boolean {
  if (e.status === 0 || e.status === 429 || e.status >= 500) return false;
  return e.code === 190 || e.code === 100 || (e.code !== null && e.code >= 200 && e.code <= 299);
}

/** Chamada à Graph API. O token vai SÓ no header `Authorization: Bearer` (nunca em URL, corpo ou log). */
async function graph(
  method: "GET" | "POST",
  path: string,
  opts: { token: string; query?: Record<string, string>; body?: unknown; signal?: AbortSignal },
): Promise<unknown> {
  const url = new URL(`${graphBase()}/${META_GRAPH_VERSION}/${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  if (opts.signal?.aborted) throw abortError(opts.signal);
  let res: Response;
  try {
    res = await (fetchOverride ?? fetch)(url, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${opts.token}`,
        ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      signal,
    });
  } catch {
    // Nunca repassa o erro da rede (texto do runtime; pode trazer detalhes da requisição).
    if (opts.signal?.aborted) throw abortError(opts.signal);
    throw new MetaApiError(0, null, null);
  }
  const json = (await res.json().catch(() => null)) as { error?: { code?: unknown; error_subcode?: unknown } } | null;
  if (!res.ok) throw new MetaApiError(res.status, numOrNull(json?.error?.code), numOrNull(json?.error?.error_subcode));
  return json;
}

// ---------------------------------------------------------------------------------------------------------------
// Dados do comprador

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export interface MetaUserData {
  em?: string[];
  ph?: string[];
  fn?: string[];
  ln?: string[];
  country?: string[];
  external_id?: string[];
  client_ip_address?: string;
  client_user_agent?: string;
  fbc?: string;
  fbp?: string;
}

/** Celular brasileiro só com dígitos e com 55 (10/11 dígitos ganham o 55; 12/13 começando com 55 ficam). */
function normPhone(raw: string): string | null {
  const d = raw.replace(/\D/g, "").replace(/^0+/, "");
  if (d.length === 10 || d.length === 11) return `55${d}`;
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) return d;
  return null;
}

/** Minúsculo, sem pontuação nem dígitos; acentos mantidos (UTF-8, NFC). */
const nameParts = (raw: string) =>
  raw
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean);

export function buildMetaUserData(c: {
  email: string;
  phone: string;
  name: string;
  ip: string;
  ua: string;
  fbc?: string | null;
  fbp?: string | null;
  externalId?: string;
}): MetaUserData {
  const u: MetaUserData = {};
  const em = c.email.trim().toLowerCase();
  if (em) u.em = [sha256(em)];
  const ph = normPhone(c.phone);
  if (ph) u.ph = [sha256(ph)];
  const parts = nameParts(c.name);
  if (parts[0]) u.fn = [sha256(parts[0])];
  if (parts.length > 1) u.ln = [sha256(parts[parts.length - 1]!)];
  u.country = [sha256("br")];
  if (c.externalId) u.external_id = [sha256(c.externalId)];
  if (c.ip && c.ip !== "unknown") u.client_ip_address = c.ip;
  if (c.ua) u.client_user_agent = c.ua;
  if (c.fbc) u.fbc = c.fbc;
  if (c.fbp) u.fbp = c.fbp;
  return u;
}

// ---------------------------------------------------------------------------------------------------------------
// Conexão

interface MetaConfig {
  pixelId?: string;
  testEventCode?: string;
}

const validPixel = (v: unknown): string | null => (typeof v === "string" && PIXEL_ID_RE.test(v) ? v : null);

/** Pixel da página/evento: o da oferta (se houver) sobrescreve o da conexão da loja. Só lê a config (sem abrir o segredo). */
export async function pixelIdFor(tx: Tx, storeId: string, offerPixelId: string | null | undefined): Promise<string | null> {
  const own = validPixel(offerPixelId);
  if (own) return own;
  const [row] = await tx
    .select({ config: integration.config })
    .from(integration)
    .where(and(eq(integration.storeId, storeId), eq(integration.kind, "meta")));
  return validPixel((row?.config as MetaConfig | undefined)?.pixelId);
}

/**
 * Subcódigos do Meta para "parâmetro inválido no evento" da API de Conversões (2804xxx; ex.: 2804019 = falta
 * `event_time`). O Meta só valida o corpo DEPOIS de aceitar o token e a permissão de enviar ao Pixel.
 */
const EVENT_PARAM_SUBCODES = { min: 2_804_000, max: 2_804_999 } as const;

/**
 * Pergunta ao Meta se o token pode enviar eventos a este Pixel, sem criar evento nenhum: manda um evento de propósito
 * incompleto (sem `event_time`). "Falta parâmetro do evento" (código 100, subcódigo 2804xxx) prova que o token e a
 * permissão valem; token inválido (190) ou sem permissão no Pixel ("(#100) Missing Permission", sem subcódigo 2804xxx)
 * é recusado. Não usa leitura (`GET /{pixel}`): o token padrão da API de Conversões, gerado no Gerenciador de Eventos,
 * envia eventos mas não pode ler o Pixel (o Meta responde "Missing Permission"), e a leitura recusava todo token
 * legítimo (visto em produção em 21/11/2026).
 */
async function checkToken(pixelId: string, token: string, storeId: string): Promise<void> {
  try {
    // Aceito (não deveria acontecer sem event_time): o token também serve.
    await graph("POST", `${pixelId}/events`, { token, body: { data: [{ event_name: "FunilTesteDeConexao" }] } });
  } catch (e) {
    if (!(e instanceof MetaApiError)) throw e;
    if (e.code === 100 && e.subcode !== null && e.subcode >= EVENT_PARAM_SUBCODES.min && e.subcode <= EVENT_PARAM_SUBCODES.max) return;
    log.warn("Meta recusou o teste da conexão", { storeId, status: e.status, code: e.code, subcode: e.subcode });
    if (e.status === 0) throw new ActionError("provider_error", "Não foi possível falar com o Meta agora. Tente de novo em instantes.");
    throw new ActionError(
      "provider_error",
      `O Meta não aceitou o token para este Pixel${e.code !== null ? ` (código ${e.code})` : ""}. Confira o Pixel ID e o token da API de Conversões.`,
    );
  }
}

/**
 * Pixel novo de uma oferta (offers.setPixel): validado com o token guardado PELO DONO da loja (saveMeta exige
 * connections.write). Sem token guardado não há como saber se o Pixel é da loja: recusado. Fora de transação.
 */
export async function validatePixelWithStoredToken(storeId: string, pixelId: string): Promise<void> {
  const token = (await withStore(storeId, (tx) => getIntegration(tx, storeId, "meta")))?.secret ?? null;
  if (!token) {
    throw new ActionError(
      "conflict",
      "Para usar um Pixel próprio na oferta, o dono da loja precisa conectar o Meta (Pixel ID e token da API de Conversões) em Conexões.",
    );
  }
  await checkToken(pixelId, token, storeId);
}

const pixelIdInput = z.string().trim().regex(PIXEL_ID_RE, "Pixel ID: só números (5 a 20)");

/**
 * Conecta o Meta: Pixel ID (navegador e API de Conversões), token da API de Conversões (selado) e, opcional, o código
 * de teste do Events Manager. Token omitido mantém o guardado. Com token, `prepare` o valida no Meta (fora de
 * transação) antes de salvar.
 */
export const saveMeta = defineAction({
  name: "connections.saveMeta",
  description: "Conecta o Meta da loja (Pixel ID e token da API de Conversões): testa o token e só então salva.",
  input: z.object({
    pixelId: pixelIdInput,
    /** Omitido: mantém o token já guardado. */
    accessToken: z.string().trim().min(8).max(1000).optional(),
    testEventCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,64}$/, "Código de teste inválido")
      .optional(),
  }),
  // Quem controla o token e o Pixel da loja controla para onde vão os dados dos compradores (API de Conversões e Pixel
  // na página do cartão): só o dono (connections.write); MCP/IA precisam de aprovação.
  permission: "connections.write",
  sensitive: true,
  auditInput: (i) => ({ pixelId: i.pixelId, testEventCode: i.testEventCode ?? null, accessToken: i.accessToken ? "[novo]" : "[mantido]" }),
  async prepare(call, input) {
    const token = input.accessToken ?? (await withStore(call.storeId, (tx) => getIntegration(tx, call.storeId, "meta")))?.secret ?? null;
    if (token) await checkToken(input.pixelId, token, call.storeId);
    return { hasToken: token !== null };
  },
  async run(ctx, input, { hasToken }) {
    const config: MetaConfig = { pixelId: input.pixelId, ...(input.testEventCode ? { testEventCode: input.testEventCode } : {}) };
    await saveIntegration(ctx.tx, ctx.storeId, "meta", config as Record<string, unknown>, input.accessToken);
    return { pixelId: input.pixelId, testEventCode: input.testEventCode ?? null, hasAccessToken: hasToken };
  },
});

/** Botão "Testar" do Meta: valida de novo o token guardado contra o pixel da loja. */
export const testMeta = defineAction({
  name: "connections.testMeta",
  description: "Testa a conexão do Meta da loja (o token da API de Conversões pode enviar eventos ao Pixel).",
  input: z.object({}),
  permission: "tracking.write",
  async prepare(call) {
    await limitConnectionTest(call.actor, "testMeta", call.storeId);
    const meta = await withStore(call.storeId, (tx) => getIntegration(tx, call.storeId, "meta"));
    const pixelId = validPixel((meta?.config as MetaConfig | undefined)?.pixelId);
    if (!pixelId || !meta?.secret) throw new ActionError("conflict", "Conecte o Meta (Pixel ID e token) antes de testar.");
    await checkToken(pixelId, meta.secret, call.storeId);
  },
  run: async () => ({ ok: true as const }),
});

// ---------------------------------------------------------------------------------------------------------------
// Fila

/**
 * `checkout.start` (na transação do pedido criado): enfileira o InitiateCheckout do servidor com o id gerado na página,
 * só se a loja tem token da API de Conversões (sem conexão, nada vai para a fila).
 */
export async function enqueueInitiateCheckout(tx: Tx, storeId: string, orderId: string, eventId: string | undefined): Promise<void> {
  if (!eventId || !META_EVENT_ID_RE.test(eventId)) return;
  if (!(await metaConnected(tx, storeId))) return;
  await enqueue(tx, { storeId, type: "meta_event", payload: { event: "InitiateCheckout", orderId, eventId } });
}

/** A loja tem token da API de Conversões guardado? (só a linha; não abre o segredo) */
export async function metaConnected(tx: Tx, storeId: string): Promise<boolean> {
  const [row] = await tx
    .select({ kind: integration.kind })
    .from(integration)
    .where(and(eq(integration.storeId, storeId), eq(integration.kind, "meta"), isNotNull(integration.secret)));
  return row !== undefined;
}

const orderPayloadSchema = z
  .object({
    event: z.enum(["Purchase", "InitiateCheckout"]),
    orderId: z.uuid(),
    eventId: z.string().regex(META_EVENT_ID_RE).optional(),
  })
  .refine((p) => p.event === "Purchase" || p.eventId !== undefined, "InitiateCheckout sem eventId");
/** StartTrial: só o id do registro de teste (o e-mail já está nele em sha256; nada pessoal no payload do job). */
const trialPayloadSchema = z.object({ event: z.literal("StartTrial"), trialId: z.uuid() });
const payloadSchema = z.union([trialPayloadSchema, orderPayloadSchema]);

type Prepared =
  | { skip: string }
  | {
      pixelId: string;
      token: string;
      testEventCode: string | null;
      body: Record<string, unknown>;
      eventId: string;
    };

/**
 * `meta_event` {event, orderId, eventId?}: lê tudo numa transação curta, envia FORA dela (respeitando o AbortSignal do
 * worker) e grava a marca `conversion` (pedido, evento): job repetido ou duplicado não reenvia. Sem conexão (token) ou
 * sem pixel: termina sem erro. Purchase só com o pedido ainda `paid`. Erro do Meta: só status/código vão ao log;
 * transitório -> o job falha e a fila re-tenta; permanente (190, 100, 200-299) -> marca `failed` com o código e encerra.
 */
export const metaEventJob: JobHandler = async (j, signal) => {
  const parsed = payloadSchema.safeParse(j.payload);
  if (!j.storeId || !parsed.success) {
    log.error("meta_event com payload inválido; descartado", { id: j.id });
    return;
  }
  const storeId = j.storeId;
  if (parsed.data.event === "StartTrial") return startTrialJob(storeId, parsed.data.trialId, signal);
  const p = parsed.data;
  if (signal.aborted) throw abortError(signal);

  const prep: Prepared = await withStore(storeId, async (tx) => {
    const [o] = await tx.select().from(orders).where(eq(orders.id, p.orderId));
    if (!o) return { skip: "pedido_inexistente" };
    // Purchase só com o pedido AINDA pago: reembolsado/contestado antes do envio não vira venda no Meta.
    if (p.event === "Purchase" && o.status !== "paid") return { skip: `pedido_${o.status}` };
    const eventId = p.event === "Purchase" ? purchaseEventId(o.publicId) : p.eventId!;
    const [sent] = await tx
      .select({ id: conversion.id })
      .from(conversion)
      .where(and(eq(conversion.orderId, o.id), eq(conversion.event, p.event)));
    if (sent) return { skip: "ja_enviado" };
    const when = p.event === "Purchase" ? o.paidAt : o.createdAt;
    if (!when) return { skip: "nao_pago" };
    const eventTime = Math.floor(when.getTime() / 1000);
    if (Date.now() / 1000 - eventTime > MAX_EVENT_AGE_S) return { skip: "evento_antigo" };

    const conn = await getIntegration(tx, storeId, "meta");
    if (!conn?.secret) return { skip: "sem_conexao" };
    const [of] = await tx.select({ slug: offer.slug, pixelId: offer.pixelId }).from(offer).where(eq(offer.id, o.offerId));
    const pixelId = validPixel(of?.pixelId) ?? validPixel((conn.config as MetaConfig).pixelId);
    if (!of || !pixelId) return { skip: "sem_pixel" };
    const [c] = await tx.select({ email: customer.email, name: customer.name, phone: customer.phone }).from(customer).where(eq(customer.id, o.customerId));
    const [s] = await tx.select({ domain: store.domain, slug: store.slug }).from(store).where(eq(store.id, storeId));
    if (!c || !s) throw new Error("pedido sem cliente ou loja");
    const items = await tx
      .select({ productId: orderItem.productId })
      .from(orderItem)
      .where(eq(orderItem.orderId, o.id))
      .orderBy(...itemOrder); // ordem do pedido: principais e depois o bump, cada grupo na ordem da oferta

    const base = storeBaseUrl(s);
    const event = {
      event_name: p.event,
      event_time: eventTime,
      event_id: eventId,
      action_source: "website",
      event_source_url: p.event === "Purchase" ? `${base}/o/${o.publicId}` : `${base}/c/${of.slug}`,
      user_data: buildMetaUserData({
        email: c.email,
        phone: o.buyerPhone ?? c.phone,
        name: o.buyerName ?? c.name,
        ip: o.clientIp,
        ua: o.userAgent,
        fbc: o.fbc,
        fbp: o.fbp,
        externalId: o.customerId,
      }),
      custom_data: {
        currency: "BRL",
        // Centavos inteiros até aqui; reais só na borda com o Meta.
        value: o.totalCents / 100,
        content_ids: items.map((i) => i.productId),
        content_type: "product",
        ...(p.event === "Purchase" ? { order_id: o.publicId } : {}),
      },
    };
    const testEventCode = (conn.config as MetaConfig).testEventCode ?? null;
    return { pixelId, token: conn.secret, testEventCode, body: event, eventId };
  });

  if ("skip" in prep) {
    log.info("meta_event: nada a enviar", { orderId: p.orderId, event: p.event, reason: prep.skip });
    return;
  }
  if (signal.aborted) throw abortError(signal);
  try {
    await graph("POST", `${prep.pixelId}/events`, {
      token: prep.token,
      body: { data: [prep.body], ...(prep.testEventCode ? { test_event_code: prep.testEventCode } : {}) },
      signal,
    });
  } catch (e) {
    if (!(e instanceof MetaApiError)) throw e;
    const info = { orderId: p.orderId, event: p.event, status: e.status, code: e.code, subcode: e.subcode };
    if (!isPermanentMetaError(e)) {
      log.warn("API de Conversões do Meta falhou; a fila re-tenta", info);
      throw e;
    }
    // Permanente (token, parâmetro, permissão): re-tentar não resolve. Marca `failed` com o código e encerra o job.
    log.error("API de Conversões do Meta recusou o evento (permanente); não será re-tentado", info);
    await withStore(storeId, (tx) =>
      tx
        .insert(conversion)
        .values({ storeId, orderId: p.orderId, event: p.event, eventId: prep.eventId, status: "failed", errorCode: e.code })
        .onConflictDoNothing(),
    );
    return;
  }
  await withStore(storeId, (tx) =>
    tx.insert(conversion).values({ storeId, orderId: p.orderId, event: p.event, eventId: prep.eventId, status: "sent" }).onConflictDoNothing(),
  );
  log.info("meta_event enviado", { orderId: p.orderId, event: p.event });
};

/**
 * `StartTrial` do registro de teste: mesmo fluxo do pedido (lê numa transação curta, envia fora dela, marca
 * `conversion` por `trial_id`). Quando o envio termina (enviado, recusado de vez ou nada a enviar) o registro perde ip e
 * user agent, que só existiam para o Meta (§7.3); erro transitório mantém os dois para a nova tentativa.
 */
async function startTrialJob(storeId: string, trialId: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError(signal);
  const forgetClient = (tx: Tx) => tx.update(appTrial).set({ clientIp: null, userAgent: null }).where(eq(appTrial.id, trialId));

  const prep: Prepared = await withStore(storeId, async (tx) => {
    const [tr] = await tx.select().from(appTrial).where(eq(appTrial.id, trialId));
    if (!tr) return { skip: "teste_inexistente" };
    const [sent] = await tx
      .select({ id: conversion.id })
      .from(conversion)
      .where(and(eq(conversion.trialId, tr.id), eq(conversion.event, "StartTrial")));
    if (sent) return { skip: "ja_enviado" };
    const eventTime = Math.floor(tr.startedAt.getTime() / 1000);
    const conn = await getIntegration(tx, storeId, "meta");
    const pixelId = validPixel((conn?.config as MetaConfig | undefined)?.pixelId);
    const skip = Date.now() / 1000 - eventTime > MAX_EVENT_AGE_S ? "evento_antigo" : !conn?.secret ? "sem_conexao" : !pixelId ? "sem_pixel" : null;
    if (skip) {
      await forgetClient(tx);
      return { skip };
    }
    const [s] = await tx.select({ domain: store.domain, slug: store.slug }).from(store).where(eq(store.id, storeId));
    if (!s) throw new Error("teste sem loja");
    const userData: MetaUserData = { em: [tr.emailHash], external_id: [sha256(tr.account)] };
    if (tr.clientIp) userData.client_ip_address = tr.clientIp;
    if (tr.userAgent) userData.client_user_agent = tr.userAgent;
    if (tr.fbc) userData.fbc = tr.fbc;
    if (tr.fbp) userData.fbp = tr.fbp;
    const event = {
      event_name: "StartTrial",
      event_time: eventTime,
      event_id: tr.eventId,
      action_source: "website",
      // O cadastro aconteceu no site do app, que o funil não conhece: vale a origem pública da loja (exigida no website).
      event_source_url: `${storeBaseUrl(s)}/`,
      user_data: userData,
      custom_data: { value: 0, currency: "BRL" },
    };
    return { pixelId: pixelId!, token: conn!.secret!, testEventCode: (conn!.config as MetaConfig).testEventCode ?? null, body: event, eventId: tr.eventId };
  });

  if ("skip" in prep) {
    log.info("meta_event: nada a enviar", { trialId, event: "StartTrial", reason: prep.skip });
    return;
  }
  if (signal.aborted) throw abortError(signal);
  const mark = (status: "sent" | "failed", errorCode: number | null = null) =>
    withStore(storeId, async (tx) => {
      await tx.insert(conversion).values({ storeId, trialId, event: "StartTrial", eventId: prep.eventId, status, errorCode }).onConflictDoNothing();
      await forgetClient(tx);
    });
  try {
    await graph("POST", `${prep.pixelId}/events`, {
      token: prep.token,
      body: { data: [prep.body], ...(prep.testEventCode ? { test_event_code: prep.testEventCode } : {}) },
      signal,
    });
  } catch (e) {
    if (!(e instanceof MetaApiError)) throw e;
    const info = { trialId, event: "StartTrial", status: e.status, code: e.code, subcode: e.subcode };
    if (!isPermanentMetaError(e)) {
      log.warn("API de Conversões do Meta falhou; a fila re-tenta", info);
      throw e;
    }
    log.error("API de Conversões do Meta recusou o evento (permanente); não será re-tentado", info);
    await mark("failed", e.code);
    return;
  }
  await mark("sent");
  log.info("meta_event enviado", { trialId, event: "StartTrial" });
}
