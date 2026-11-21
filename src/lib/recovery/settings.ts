// Configuração da recuperação de vendas por e-mail: o que a loja precisa ter antes de ligar.
import { and, eq } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { integration, store } from "@/lib/db/schema";
import { smtpConfigUsable } from "@/lib/delivery/resend";

/**
 * Existe conexão salva do provedor ativo da loja (`store.email_provider`)? Olha só a linha e a config, sem abrir o
 * segredo (um segredo ilegível não derruba a tela de configurações; o envio trata isso na hora de mandar).
 * SMTP: host, porta e remetente (os mesmos campos que o envio exige). Resend: remetente e chave guardada.
 */
export async function emailProviderReady(tx: Tx, storeId: string): Promise<boolean> {
  const [s] = await tx.select({ provider: store.emailProvider }).from(store).where(eq(store.id, storeId));
  if (!s) return false;
  const kind = s.provider === "resend" ? "resend" : "smtp";
  const [row] = await tx
    .select({ config: integration.config, hasSecret: integration.secret })
    .from(integration)
    .where(and(eq(integration.storeId, storeId), eq(integration.kind, kind)));
  if (!row) return false;
  const config = row.config as Record<string, unknown>;
  if (kind === "smtp") return smtpConfigUsable(config);
  return row.hasSecret !== null && typeof config.fromEmail === "string" && config.fromEmail !== "";
}
