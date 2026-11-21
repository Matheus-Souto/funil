// Contatos de quem não finalizou a compra, no painel (dono, admin e suporte; nada disso sai pelo MCP).
// - `leads.list` (leitura, sem auditoria como `orders.list`): 50 por página, mais novos primeiro. `q` é o código do contato
//   (6 hex, qualquer caixa) ou o e-mail exato (normalizado, comparado pelo `email_hash`: nunca busca parcial em e-mail).
//   O contato convertido mostra o código do pedido como o painel já o mostra e não tem e-mail nem celular.
// - `leads.markContacted`, `leads.delete` e `leads.forgetEmail`: a auditoria grava só `{ leadId }` ou `{ emailHash }`.
// - `sweepLeadsJob`: a retenção de 30 dias (`expires_at`), loja a loja, de hora em hora. Entre uma varredura e outra, o
//   contato vencido já não aparece na lista nem pode ser marcado como contatado.
import { createHash } from "node:crypto";
import { and, count, desc, eq, gt, lt, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction } from "@/lib/actions/core";
import { db, withStore } from "@/lib/db/client";
import { checkoutLead, offer, orders, store } from "@/lib/db/schema";
import { orderCode } from "@/lib/format";
import type { JobHandler } from "@/lib/jobs";
import { log } from "@/lib/log";
import { leadCode } from "@/lib/notify/telegram";

export const PAGE_SIZE = 50;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const CODE_FORMAT = /^[0-9a-f]{6}$/i;
const leadStatus = z.enum(["open", "contacted", "converted"]);
const id = z.object({ id: z.uuid() });

/** Ainda dentro dos 30 dias: vencido e não varrido ainda (a varredura é de hora em hora) não aparece nem muda. */
const notExpired = () => gt(checkoutLead.expiresAt, sql`now()`);

/** Mesmo cálculo de `leadCode`, no banco: 6 primeiros hex do UUID sem hífen, minúsculos. */
const codeSql = sql`left(replace(${checkoutLead.id}::text, '-', ''), 6)`;

function where(input: { status?: z.infer<typeof leadStatus>; q?: string }): SQL | undefined {
  const parts: (SQL | undefined)[] = [notExpired()];
  if (input.status) parts.push(eq(checkoutLead.status, input.status));
  if (input.q) {
    parts.push(CODE_FORMAT.test(input.q) ? sql`${codeSql} = ${input.q.toLowerCase()}` : eq(checkoutLead.emailHash, sha256(input.q.toLowerCase())));
  }
  return and(...parts);
}

export const listLeads = defineAction({
  name: "leads.list",
  description: "Lista os contatos de quem não finalizou a compra (50 por página, mais novos primeiro), com filtro de status e busca pelo código ou pelo e-mail exato.",
  input: z.object({
    status: leadStatus.optional(),
    q: z.string().trim().max(254).optional(),
    page: z.number().int().min(1).max(10_000).default(1),
  }),
  permission: "leads.read",
  audit: false,
  async run(ctx, input) {
    const [total] = await ctx.tx.select({ n: count().mapWith(Number) }).from(checkoutLead).where(where(input));
    const rows = await ctx.tx
      .select({
        id: checkoutLead.id,
        createdAt: checkoutLead.createdAt,
        status: checkoutLead.status,
        offerName: offer.name,
        email: checkoutLead.email,
        phone: checkoutLead.phone,
        orderId: orders.id,
        orderPublicId: orders.publicId,
      })
      .from(checkoutLead)
      .innerJoin(offer, eq(offer.id, checkoutLead.offerId))
      .leftJoin(orders, eq(orders.id, checkoutLead.orderId))
      .where(where(input))
      .orderBy(desc(checkoutLead.createdAt), desc(checkoutLead.id))
      .limit(PAGE_SIZE)
      .offset((input.page - 1) * PAGE_SIZE);
    return {
      items: rows.map(({ orderPublicId, ...r }) => ({
        ...r,
        status: r.status as z.infer<typeof leadStatus>,
        code: leadCode(r.id),
        orderCode: orderPublicId ? orderCode(orderPublicId) : null,
      })),
      total: total?.n ?? 0,
      page: input.page,
      pageSize: PAGE_SIZE,
    };
  },
});

export const markLeadContacted = defineAction({
  name: "leads.markContacted",
  description: "Marca o contato como já contatado (aberto vira contatado; repetir não muda nada; convertido não muda).",
  input: id,
  permission: "leads.write",
  auditInput: (i) => ({ leadId: i.id }),
  async run(ctx, { id: leadId }) {
    const [row] = await ctx.tx.select({ status: checkoutLead.status }).from(checkoutLead).where(and(eq(checkoutLead.id, leadId), notExpired())).for("update");
    if (!row) throw new ActionError("not_found", "Contato não encontrado");
    if (row.status === "converted") throw new ActionError("conflict", "Este contato já virou pedido");
    if (row.status === "open") await ctx.tx.update(checkoutLead).set({ status: "contacted", updatedAt: new Date() }).where(eq(checkoutLead.id, leadId));
    return { id: leadId, status: "contacted" as const };
  },
});

export const deleteLead = defineAction({
  name: "leads.delete",
  description: "Exclui um contato guardado.",
  input: id,
  permission: "leads.write",
  auditInput: (i) => ({ leadId: i.id }),
  async run(ctx, { id: leadId }) {
    const [row] = await ctx.tx.delete(checkoutLead).where(eq(checkoutLead.id, leadId)).returning({ id: checkoutLead.id });
    if (!row) throw new ActionError("not_found", "Contato não encontrado");
    return { id: row.id };
  },
});

export const forgetLeadEmail = defineAction({
  name: "leads.forgetEmail",
  description: "Pedido de exclusão do titular: apaga todos os contatos da loja com este e-mail.",
  input: z.object({ email: z.string().trim().toLowerCase().min(1).max(254) }),
  permission: "leads.write",
  auditInput: (i) => ({ emailHash: sha256(i.email) }),
  async run(ctx, { email }) {
    const gone = await ctx.tx.delete(checkoutLead).where(eq(checkoutLead.emailHash, sha256(email))).returning({ id: checkoutLead.id });
    return { deleted: gone.length };
  },
});

/**
 * Retenção: apaga os contatos vencidos (`expires_at < now()`, abertos ou convertidos), loja a loja (a tabela `store` não
 * tem RLS). Falha numa loja não impede as demais; ao final, se alguma falhou, o job falha para tentar de novo.
 * `beforeDelete` existe só para testes. Log só com `storeId` e contagem.
 */
export function createSweepLeadsHandler(beforeDelete?: (storeId: string) => Promise<void>): JobHandler {
  return async () => {
    const stores = await db.select({ id: store.id }).from(store);
    let failed = 0;
    for (const { id: storeId } of stores) {
      try {
        await beforeDelete?.(storeId);
        const gone = await withStore(storeId, (tx) =>
          tx.delete(checkoutLead).where(lt(checkoutLead.expiresAt, sql`now()`)).returning({ id: checkoutLead.id }),
        );
        if (gone.length > 0) log.info("contatos vencidos apagados", { storeId, count: gone.length });
      } catch (e) {
        failed++;
        log.error("falha ao apagar contatos vencidos da loja", { storeId, error: e });
      }
    }
    if (failed > 0) throw new Error(`sweep_leads falhou em ${failed} loja(s)`);
  };
}

export const sweepLeadsJob: JobHandler = createSweepLeadsHandler();
