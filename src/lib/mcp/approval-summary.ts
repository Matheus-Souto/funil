// Resumo de um pedido da fila de aprovação do MCP, para o painel: um campo por folha da entrada validada, com ids
// trocados por algo que o aprovador reconhece (oferta, produto, aviso) ou pelo código do pedido, nunca por dado do
// comprador, e segredos mascarados. Gravado em `approval_request.summary` no pedido; a entrada em si fica só selada.
//
// Identificação: nome sozinho não basta (o agente cria produto por link e renomeia produto sem aprovação). Oferta sai
// como `nome (/c/slug) · #<8 primeiros do id>`; produto como `nome — arquivo · tamanho · enviado em <data> · #<id>`, com
// o selo "enviado pelo agente <token> em <data>" quando veio de um link de upload. As referências {tipo, ids, nomes}
// ficam no resumo (`refs`) para `approvals.list` resolver de novo ao listar e avisar quando algo mudou desde o pedido.
// Todo valor (inclusive nome vindo do banco) passa por `neutralize`: controle, quebra de linha, bidi e invisíveis viram
// `⟨U+XXXX⟩`, para um valor não se disfarçar nem imitar outra linha "rótulo: valor".
import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import type { Action } from "@/lib/actions/core";
import { alertText } from "@/lib/alerts";
import type { Tx } from "@/lib/db/client";
import { integration, mcpToken, offer, orders, product, store, storeAlert, uploadLink } from "@/lib/db/schema";
import { brl, dateSP, dateTimeSP, fileSize, orderCode } from "@/lib/format";

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

type RefKind = "offer" | "product";
/** Oferta/produto citado num campo: ids na ordem e a identidade (nome; produto: nome — arquivo) no momento do pedido. */
export type SummaryRef = { label: string; kind: RefKind; ids: string[]; was: (string | null)[] };
export type SummaryField = { label: string; value: string };
export type ApprovalSummary = { fields: SummaryField[]; notes: string[]; refs?: SummaryRef[] };

const KEEPS_CURRENT = "(mantém o atual)";
const NOT_FOUND = "(não encontrado)";
const NONE = "(nenhum)";
/** Separa itens de uma lista de ofertas/produtos (cada item já neutralizado: a quebra é só nossa). */
const ITEM_SEP = "\n";
const PAYMENT_PAGE_ALERT = "monitor_pagina_pagamento";

// Controle C0/C1, marcas de direção e separadores invisíveis, bidi (embed/override/isolate) e BOM.
const HIDDEN_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** Troca caractere de controle, quebra de linha, bidi e invisível por um marcador visível `⟨U+XXXX⟩`. */
export function neutralize(text: string): string {
  return text.replace(HIDDEN_CHARS, (c) => `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`);
}

const shortId = (id: string) => `#${id.slice(0, 8)}`;
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

type Resolved = { text: string; identity: string };

/** Ofertas da loja da transação (RLS): `nome (/c/slug) · #id`. */
async function resolveOffers(tx: Tx, ids: string[]): Promise<Map<string, Resolved>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.select({ id: offer.id, name: offer.name, slug: offer.slug }).from(offer).where(inArray(offer.id, ids));
  return new Map(rows.map((r) => [r.id, { identity: r.name, text: `${neutralize(r.name)} (/c/${neutralize(r.slug)}) · ${shortId(r.id)}` }]));
}

/** Produtos da loja da transação (RLS): nome, arquivo, tamanho, data, id curto e o selo do link de upload do agente. */
async function resolveProducts(tx: Tx, ids: string[]): Promise<Map<string, Resolved>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      id: product.id,
      name: product.name,
      fileName: product.fileName,
      fileSize: product.fileSize,
      createdAt: product.createdAt,
      deletedAt: product.deletedAt,
      uploadedAt: uploadLink.usedAt,
      agent: mcpToken.name,
    })
    .from(product)
    .leftJoin(uploadLink, eq(uploadLink.productId, product.id))
    .leftJoin(mcpToken, eq(mcpToken.id, uploadLink.tokenId))
    .where(inArray(product.id, ids));
  const map = new Map<string, Resolved>();
  for (const r of rows) {
    if (map.has(r.id)) continue;
    const parts = [`${neutralize(r.name)} — ${neutralize(r.fileName)}`, fileSize(r.fileSize), `enviado em ${dateSP(r.createdAt)}`, shortId(r.id)];
    if (r.deletedAt) parts.push("excluído");
    if (r.agent !== null && r.uploadedAt !== null) parts.push(`enviado pelo agente ${neutralize(r.agent)} em ${dateSP(r.uploadedAt)}`);
    map.set(r.id, { identity: `${r.name} — ${r.fileName}`, text: parts.join(" · ") });
  }
  return map;
}

/** Avisos da loja (RLS): tipo legível do aviso, data e id curto; marca o já confirmado. */
async function resolveAlerts(tx: Tx, ids: string[]): Promise<Map<string, { text: string; kind: string }>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      id: storeAlert.id,
      kind: storeAlert.kind,
      detail: storeAlert.detail,
      createdAt: storeAlert.createdAt,
      acknowledgedAt: storeAlert.acknowledgedAt,
      publicId: orders.publicId,
    })
    .from(storeAlert)
    .leftJoin(orders, eq(orders.id, storeAlert.orderId))
    .where(inArray(storeAlert.id, ids));
  return new Map(
    rows.map((r) => {
      const { title } = alertText(r.kind, r.detail as object, r.publicId ? orderCode(r.publicId) : null);
      const parts = [neutralize(title), `criado em ${dateTimeSP(r.createdAt)}`, shortId(r.id)];
      if (r.acknowledgedAt) parts.push("já confirmado");
      return [r.id, { text: parts.join(" · "), kind: r.kind }];
    }),
  );
}

const resolvers: Record<RefKind, (tx: Tx, ids: string[]) => Promise<Map<string, Resolved>>> = { offer: resolveOffers, product: resolveProducts };

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
  if (Array.isArray(value)) return value.length === 0 ? NONE : value.map((v) => plain(key, v)).join(", ");
  return neutralize(String(value));
}

/** Lista de ids → um item por linha, na ordem; id que não existe (ou não é desta loja) vira "(não encontrado)". */
function listed(v: unknown, text: (id: string) => string | undefined): string {
  const ids = Array.isArray(v) ? v : [v];
  if (ids.length === 0) return NONE;
  return ids.map((id) => (typeof id === "string" ? (text(id) ?? NOT_FOUND) : NOT_FOUND)).join(ITEM_SEP);
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
  const topId = (l: Leaf) => l.path.length === 1 && key(l) === "id";
  const refKind = (l: Leaf): RefKind | null =>
    domain === "offers" && topId(l) ? "offer" : (domain === "products" && topId(l)) || key(l) === "productIds" ? "product" : null;
  const isAlertId = (l: Leaf) => domain === "alerts" && topId(l);
  const isOrderId = (l: Leaf) => key(l) === "orderId";

  const idsOf = (kind: RefKind) => found.filter((l) => refKind(l) === kind).flatMap((l) => uuids(l.value));
  const resolved: Record<RefKind, Map<string, Resolved>> = { offer: await resolveOffers(tx, idsOf("offer")), product: await resolveProducts(tx, idsOf("product")) };
  const alerts = await resolveAlerts(tx, found.filter(isAlertId).flatMap((l) => uuids(l.value)));
  const codes = await orderCodes(tx, found.filter(isOrderId).flatMap((l) => uuids(l.value)));

  const refs: SummaryRef[] = [];
  const fields = found.map((l) => {
    const label = neutralize(l.path.join("."));
    const kind = refKind(l);
    let value: string;
    if (secrets.includes(l.path.join("."))) value = typeof l.value === "string" ? mask(l.value) : KEEPS_CURRENT;
    else if (kind) {
      const names = resolved[kind];
      value = listed(l.value, (id) => names.get(id)?.text);
      const ids = (Array.isArray(l.value) ? l.value : [l.value]).filter((x): x is string => typeof x === "string");
      refs.push({ label, kind, ids, was: ids.map((id) => names.get(id)?.identity ?? null) });
    } else if (isAlertId(l)) value = listed(l.value, (id) => alerts.get(id)?.text);
    else if (isOrderId(l)) value = listed(l.value, (id) => codes.get(id));
    else value = plain(key(l), l.value);
    return { label, value };
  });

  const notes: string[] = [];
  if (action.name === "connections.saveResend" && (await resendWouldActivate(tx))) notes.push("Também passa a usar o Resend para enviar os e-mails da loja");
  if (action.name === "offers.update" && (input as { active?: unknown } | null)?.active === true) notes.push("Reativa a oferta: o link volta a vender");
  if ([...alerts.values()].some((a) => a.kind === PAYMENT_PAGE_ALERT)) {
    notes.push(
      "Este é o aviso de segurança da página de pagamento: fechá-lo tira do painel o sinal de que o checkout, a página do pedido ou o formulário do cartão mudaram. Só aprove se você já investigou.",
    );
  }
  return refs.length > 0 ? { fields, notes, refs } : { fields, notes };
}

const KIND_LABEL: Record<RefKind, string> = { offer: "A oferta", product: "O produto" };

/**
 * Resumo de um pedido pendente com ofertas e produtos resolvidos de novo (estado atual) e um aviso por item cuja
 * identidade (nome; produto: nome — arquivo) mudou desde o pedido. Sem `refs` (pedido antigo), devolve o gravado.
 * Nunca devolve `refs` (só servem para esta conta).
 */
export async function refreshSummary(tx: Tx, summary: ApprovalSummary): Promise<{ fields: SummaryField[]; notes: string[] }> {
  const refs = summary.refs ?? [];
  if (refs.length === 0) return { fields: summary.fields, notes: summary.notes };
  const now: Record<RefKind, Map<string, Resolved>> = { offer: new Map(), product: new Map() };
  for (const kind of ["offer", "product"] as const) {
    const ids = refs.filter((r) => r.kind === kind).flatMap((r) => r.ids.filter((id) => UUID_RE.test(id)));
    now[kind] = await resolvers[kind](tx, [...new Set(ids)]);
  }
  const changed: string[] = [];
  const values = new Map<string, string>();
  for (const r of refs) {
    const names = now[r.kind];
    values.set(r.label, listed(r.ids, (id) => names.get(id)?.text));
    r.ids.forEach((id, i) => {
      const was = r.was[i] ?? null;
      const current = names.get(id)?.identity ?? null;
      if (was === current) return;
      changed.push(
        `${KIND_LABEL[r.kind]} ${shortId(id)} mudou desde o pedido: era “${was === null ? NOT_FOUND : neutralize(was)}”, agora “${current === null ? NOT_FOUND : neutralize(current)}”. Confira antes de aprovar.`,
      );
    });
  }
  return {
    fields: summary.fields.map((f) => (values.has(f.label) ? { label: f.label, value: values.get(f.label)! } : f)),
    notes: [...changed, ...summary.notes],
  };
}
