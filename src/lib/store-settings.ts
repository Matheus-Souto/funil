// Configurações da loja no painel: nome, e-mail para aviso de venda, cor do checkout e o trecho do t.js.
// A tabela `store` não tem RLS: toda leitura/escrita aqui filtra por `ctx.storeId` (a loja do ator).
import { eq } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction } from "@/lib/actions/core";
import { store } from "@/lib/db/schema";
import { storeBaseUrl } from "@/lib/delivery/links";
import { trackingSnippet } from "@/lib/tracking/touch";

const HEX = /^#[0-9a-f]{6}$/i;

export const getStoreSettings = defineAction({
  name: "store.getSettings",
  description:
    "Dados da loja para o painel: nome, e-mail de aviso de venda, cor do checkout, captura de contato (liga/desliga e e-mail de privacidade), endereço do checkout e trecho do t.js.",
  input: z.object({}),
  permission: "connections.read",
  audit: false,
  async run(ctx) {
    const [s] = await ctx.tx.select().from(store).where(eq(store.id, ctx.storeId));
    if (!s) throw new ActionError("not_found", "Loja não encontrada");
    const base = storeBaseUrl(s);
    return {
      name: s.name,
      slug: s.slug,
      notifyEmail: s.notifyEmail,
      brandColor: s.brandColor,
      leadCapture: s.leadCapture,
      privacyEmail: s.privacyEmail,
      checkoutBaseUrl: base,
      trackingSnippet: trackingSnippet(base),
    };
  },
});

export const updateStoreSettings = defineAction({
  name: "store.updateSettings",
  description:
    "Altera o nome da loja, o e-mail que recebe o aviso de venda, a cor do checkout (#RRGGBB ou null = padrão) e a captura de contato de quem não finaliza a compra (só liga com o e-mail público de privacidade preenchido).",
  input: z.object({
    name: z.string().trim().min(1, "Informe o nome da loja").max(100),
    notifyEmail: z.string().trim().toLowerCase().max(254).pipe(z.email("E-mail inválido")).nullable(),
    /** Omitida: mantém a cor atual. */
    brandColor: z.string().trim().regex(HEX, "Use uma cor no formato #RRGGBB").nullable().optional(),
    /** Omitida: mantém. Ligar exige `privacyEmail` (o do pedido ou o já gravado). */
    leadCapture: z.boolean().optional(),
    /** E-mail público para pedidos de privacidade (aparece no aviso do checkout). Omitido: mantém. */
    privacyEmail: z.string().trim().toLowerCase().max(254).pipe(z.email("E-mail inválido")).nullable().optional(),
  }),
  permission: "connections.write",
  // O e-mail de aviso recebe nome e e-mail dos compradores: MCP/IA precisam de aprovação.
  sensitive: true,
  async run(ctx, input) {
    // O banco recusa captura ligada sem e-mail de privacidade (check); aqui o erro vem no campo, antes de gravar.
    const [cur] = await ctx.tx.select({ leadCapture: store.leadCapture, privacyEmail: store.privacyEmail }).from(store).where(eq(store.id, ctx.storeId));
    if (!cur) throw new ActionError("not_found", "Loja não encontrada");
    const leadCapture = input.leadCapture ?? cur.leadCapture;
    const privacyEmail = input.privacyEmail === undefined ? cur.privacyEmail : input.privacyEmail;
    if (leadCapture && !privacyEmail) {
      const message = "Informe o e-mail de privacidade para guardar o contato de quem não finaliza a compra";
      throw new ActionError("invalid_input", message, [{ path: ["privacyEmail"], message }]);
    }
    const set = {
      name: input.name,
      notifyEmail: input.notifyEmail,
      ...(input.leadCapture !== undefined ? { leadCapture } : {}),
      ...(input.privacyEmail !== undefined ? { privacyEmail } : {}),
      ...(input.brandColor !== undefined ? { brandColor: input.brandColor === null ? null : input.brandColor.toUpperCase() } : {}),
    };
    const [row] = await ctx.tx
      .update(store)
      .set(set)
      .where(eq(store.id, ctx.storeId))
      .returning({ name: store.name, notifyEmail: store.notifyEmail, brandColor: store.brandColor });
    if (!row) throw new ActionError("not_found", "Loja não encontrada");
    return row;
  },
});
