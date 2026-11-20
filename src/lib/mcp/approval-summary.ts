// Resumo de um pedido da fila de aprovação do MCP, para o painel: um campo por folha da entrada validada, com ids
// trocados por nomes (oferta, produto) ou pelo código do pedido, nunca por dado do comprador, e segredos mascarados.
// Gravado em `approval_request.summary` no pedido; a entrada em si fica só selada.
import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import type { Action } from "@/lib/actions/core";
import type { Tx } from "@/lib/db/client";
import { integration, offer, orders, product, store } from "@/lib/db/schema";
import { brl, orderCode } from "@/lib/format";

/** Campos secretos por ação: no resumo só `••••` + 4 últimos; nunca em resposta, log ou auditoria. */
export const SECRET_FIELDS: Record<string, readonly string[]> = {
  "connections.saveAsaas": ["apiKey"],
  "connections.saveSmtp": ["password"],
  "connections.saveMeta": ["accessToken"],
  "connections.saveResend": ["apiKey", "webhookSecret"],
  "connections.saveTelegram": ["token"],
};

/** Campos com nome de segredo que aparecem inteiros no resumo (`ação.campo` → motivo). */
export const SHOWN_IN_FULL: Record<string, string> = {
  "connections.savePixManual.key": "é para onde vai o dinheiro do Pix: quem aprova precisa conferir a chave inteira",
};

export type ApprovalSummary = { fields: { label: string; value: string }[]; notes: string[] };

const KEEPS_CURRENT = "(mantém o atual)";
const NOT_FOUND = "(não encontrado)";
/** Segredo curto mostraria quase tudo nos 4 últimos: abaixo disto, só a máscara. */
const MIN_SECRET_FOR_LAST4 = 12;

const mask = (v: string) => (v.length >= MIN_SECRET_FOR_LAST4 ? `••••${v.slice(-4)}` : "••••");

type Leaf = { path: string[]; value: unknown };

/** Folhas da entrada: objeto vira caminho (`bump.priceCents`); lista de valores simples é uma folha só. */
function leaves(value: unknown, path: string[] = []): Leaf[] {
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== "object")) return [{ path, value }];
    return value.flatMap((v, i) => leaves(v, [...path, String(i)]));
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return Object.entries(value).flatMap(([k, v]) => leaves(v, [...path, k]));
  }
  return [{ path, value }];
}

/** Nomes por id (oferta ou produto) da loja da transação (RLS). */
async function namesById(tx: Tx, kind: "offer" | "product", ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows =
    kind === "offer"
      ? await tx.select({ id: offer.id, name: offer.name }).from(offer).where(inArray(offer.id, ids))
      : await tx.select({ id: product.id, name: product.name }).from(product).where(inArray(product.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuids = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string" && UUID_RE.test(x));

async function orderCodes(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.select({ id: orders.id, publicId: orders.publicId }).from(orders).where(inArray(orders.id, ids));
  return new Map(rows.map((r) => [r.id, orderCode(r.publicId)]));
}

function plain(key: string, value: unknown): string {
  if (value === undefined) return KEEPS_CURRENT;
  if (value === null) return "(vazio)";
  if (typeof value === "boolean") return value ? "sim" : "não";
  if (typeof value === "number" && key.endsWith("Cents")) return brl(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => plain(key, v)).join(", ");
  return String(value);
}

/**
 * Mesma condição de `connections.saveResend.run`: loja ainda no SMTP padrão e sem conexão SMTP. A tabela `store` não tem
 * RLS: filtra pela loja da transação (o mesmo `app.store_id` que o RLS usa).
 */
async function resendWouldActivate(tx: Tx): Promise<boolean> {
  const [row] = await tx
    .select({ id: store.id })
    .from(store)
    .where(
      and(
        eq(store.id, sql`nullif(current_setting('app.store_id', true), '')::uuid`),
        eq(store.emailProvider, "smtp"),
        notExists(tx.select({ kind: integration.kind }).from(integration).where(and(eq(integration.storeId, store.id), eq(integration.kind, "smtp")))),
      ),
    );
  return row !== undefined;
}

/**
 * Resumo da entrada **validada** de `action` para quem aprova. Roda na transação da loja (RLS): ids de outra loja
 * aparecem como "(não encontrado)".
 */
export async function summarizeRequest(tx: Tx, action: Action<unknown, unknown>, input: unknown): Promise<ApprovalSummary> {
  const secrets = SECRET_FIELDS[action.name] ?? [];
  const found = leaves(input).filter((l) => l.path.length > 0);
  // Segredo omitido também aparece: "(mantém o atual)".
  for (const s of secrets) if (!found.some((l) => l.path.join(".") === s)) found.push({ path: s.split("."), value: undefined });

  const domain = action.name.split(".")[0];
  const key = (l: Leaf) => l.path.at(-1)!;
  const isOfferId = (l: Leaf) => domain === "offers" && l.path.length === 1 && key(l) === "id";
  const isProductId = (l: Leaf) => (domain === "products" && l.path.length === 1 && key(l) === "id") || key(l) === "productIds";
  const isOrderId = (l: Leaf) => key(l) === "orderId";

  const offerNames = await namesById(tx, "offer", found.filter(isOfferId).flatMap((l) => uuids(l.value)));
  const productNames = await namesById(tx, "product", found.filter(isProductId).flatMap((l) => uuids(l.value)));
  const codes = await orderCodes(tx, found.filter(isOrderId).flatMap((l) => uuids(l.value)));
  const named = (names: Map<string, string>, v: unknown) =>
    (Array.isArray(v) ? v : [v]).map((id) => (typeof id === "string" ? (names.get(id) ?? NOT_FOUND) : NOT_FOUND)).join(", ");

  const fields = found.map((l) => {
    const label = l.path.join(".");
    let value: string;
    if (secrets.includes(label)) value = typeof l.value === "string" ? mask(l.value) : KEEPS_CURRENT;
    else if (isOfferId(l)) value = named(offerNames, l.value);
    else if (isProductId(l)) value = named(productNames, l.value);
    else if (isOrderId(l)) value = named(codes, l.value);
    else value = plain(key(l), l.value);
    return { label, value };
  });

  const notes: string[] = [];
  if (action.name === "connections.saveResend" && (await resendWouldActivate(tx))) notes.push("Também passa a usar o Resend para enviar os e-mails da loja");
  if (action.name === "offers.update" && (input as { active?: unknown } | null)?.active === true) notes.push("Reativa a oferta: o link volta a vender");
  return { fields, notes };
}
