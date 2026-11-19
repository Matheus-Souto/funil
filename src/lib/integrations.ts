import { and, eq } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { integration } from "@/lib/db/schema";
import { open, seal } from "@/lib/crypto";

export type IntegrationKind = "pix_manual" | "asaas" | "smtp" | "meta";
export type IntegrationConfig = Record<string, unknown>;

/** Devolve a conexão com o segredo já aberto. O segredo nunca deve ser logado nem enviado ao navegador. */
export async function getIntegration<K extends IntegrationKind>(
  tx: Tx,
  storeId: string,
  kind: K,
): Promise<{ config: IntegrationConfig; secret: string | null } | null> {
  const [row] = await tx.select().from(integration).where(and(eq(integration.storeId, storeId), eq(integration.kind, kind)));
  if (!row) return null;
  return { config: row.config as IntegrationConfig, secret: row.secret === null ? null : open(row.secret) };
}

/**
 * Grava (upsert) a conexão. `secret` omitido mantém o segredo atual; `null` apaga; texto é selado com seal().
 */
export async function saveIntegration(
  tx: Tx,
  storeId: string,
  kind: IntegrationKind,
  config: IntegrationConfig,
  secret?: string | null,
): Promise<void> {
  const sealed = secret === undefined ? undefined : secret === null ? null : seal(secret);
  await tx
    .insert(integration)
    .values({ storeId, kind, config, secret: sealed ?? null })
    .onConflictDoUpdate({
      target: [integration.storeId, integration.kind],
      set: { config, updatedAt: new Date(), ...(sealed === undefined ? {} : { secret: sealed }) },
    });
}
