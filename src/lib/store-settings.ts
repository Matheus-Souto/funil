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
  description: "Dados da loja para o painel: nome, e-mail de aviso de venda, cor do checkout, endereço do checkout e trecho do t.js.",
  input: z.object({}),
  permission: "connections.read",
  audit: false,
  async run(ctx) {
    const [s] = await ctx.tx.select().from(store).where(eq(store.id, ctx.storeId));
    if (!s) throw new ActionError("not_found", "Loja não encontrada");
    const base = storeBaseUrl(s);
    return { name: s.name, slug: s.slug, notifyEmail: s.notifyEmail, brandColor: s.brandColor, checkoutBaseUrl: base, trackingSnippet: trackingSnippet(base) };
  },
});

export const updateStoreSettings = defineAction({
  name: "store.updateSettings",
  description: "Altera o nome da loja, o e-mail que recebe o aviso de venda e a cor do checkout (#RRGGBB ou null = padrão).",
  input: z.object({
    name: z.string().trim().min(1, "Informe o nome da loja").max(100),
    notifyEmail: z.string().trim().toLowerCase().max(254).pipe(z.email("E-mail inválido")).nullable(),
    /** Omitida: mantém a cor atual. */
    brandColor: z.string().trim().regex(HEX, "Use uma cor no formato #RRGGBB").nullable().optional(),
  }),
  permission: "connections.write",
  // O e-mail de aviso recebe nome e e-mail dos compradores: MCP/IA precisam de aprovação.
  sensitive: true,
  async run(ctx, input) {
    const set = {
      name: input.name,
      notifyEmail: input.notifyEmail,
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
