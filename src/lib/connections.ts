// Estado das conexões para o painel. Segredos (chave do Asaas, senha do SMTP, token do Meta) nunca saem daqui: só
// "configured". O token do webhook do Asaas precisa ser colado no Asaas, então aparece, mas só para quem pode alterar
// conexões (connections.write); os demais veem que existe.
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { defineAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { env } from "@/lib/env";
import { offer } from "@/lib/db/schema";
import { getIntegration, readIntegration } from "@/lib/integrations";

const str = (v: unknown) => (typeof v === "string" ? v : null);
const webhookUrl = (storeId: string) => `${env.BASE_URL.replace(/\/+$/, "")}/api/webhooks/asaas/${storeId}`;

export const connectionsStatus = defineAction({
  name: "connections.status",
  description: "Conexões da loja (Pix manual, Asaas, SMTP, Meta) sem segredos: segredos aparecem só como configurados.",
  input: z.object({}),
  permission: "connections.read",
  audit: false,
  async run(ctx) {
    const canWrite = ctx.actor.kind === "user" && hasPermission(ctx.actor.role, "connections.write");
    const [pix, smtp, meta] = await Promise.all((["pix_manual", "smtp", "meta"] as const).map((k) => getIntegration(ctx.tx, ctx.storeId, k)));
    // Chave do Asaas que não abre (ASAAS_SEAL_KEY trocada, removida ou rollback) não derruba a tela: aparece como
    // ilegível para o dono colar a chave de novo.
    const asaas = await readIntegration(ctx.tx, ctx.storeId, "asaas");
    const cfg = (c: typeof pix) => (c?.config ?? {}) as Record<string, unknown>;
    // Sem Turnstile, o disjuntor do cartão só limita por IP: com oferta ativa de cartão, o painel recomenda configurar.
    const turnstileConfigured = Boolean(env.TURNSTILE_SECRET);
    const [cardOffer] = await ctx.tx
      .select({ id: offer.id })
      .from(offer)
      .where(and(eq(offer.active, true), sql`'card' = any(${offer.methods})`))
      .limit(1);
    return {
      pixManual: pix ? { key: str(cfg(pix).key) ?? "", name: str(cfg(pix).name) ?? "", city: str(cfg(pix).city) ?? "" } : null,
      asaas: asaas
        ? {
            env: cfg(asaas).env === "production" ? ("production" as const) : ("sandbox" as const),
            apiKey: asaas.unreadable ? ("unreadable" as const) : asaas.secret ? ("configured" as const) : null,
            webhookUrl: webhookUrl(ctx.storeId),
            webhookToken: canWrite ? str(cfg(asaas).webhookToken) : null,
          }
        : null,
      smtp: smtp
        ? {
            host: str(cfg(smtp).host) ?? "",
            port: typeof cfg(smtp).port === "number" ? (cfg(smtp).port as number) : 0,
            secure: cfg(smtp).secure === true,
            user: str(cfg(smtp).user),
            from: str(cfg(smtp).from) ?? "",
            password: smtp.secret ? ("configured" as const) : null,
          }
        : null,
      meta: meta
        ? { pixelId: str(cfg(meta).pixelId) ?? "", testEventCode: str(cfg(meta).testEventCode), accessToken: meta.secret ? ("configured" as const) : null }
        : null,
      turnstile: { configured: turnstileConfigured, recommended: !turnstileConfigured && cardOffer !== undefined },
    };
  },
});
