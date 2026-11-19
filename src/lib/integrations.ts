import { and, eq } from "drizzle-orm";
import { db, withStore, type Tx } from "@/lib/db/client";
import { integration, store } from "@/lib/db/schema";
import { asaasSealer, createAsaasSealer, createSealer, open, seal, type Sealer } from "@/lib/crypto";
import { env, requireSecret } from "@/lib/env";
import { log } from "@/lib/log";

export type IntegrationKind = "pix_manual" | "asaas" | "smtp" | "meta";
export type IntegrationConfig = Record<string, unknown>;

/**
 * Abre e sela segredos de conexão conforme o tipo. `asaas` usa a chave própria (`a1.`, ASAAS_SEAL_KEY) quando ela
 * existe, para o serviço de cartão abri-la sem o SECRET; as demais (SMTP, Meta...) sempre usam o SECRET (`v1.`) e
 * nunca abrem com a chave do Asaas. Um `v1.` de `asaas` (gravado antes da chave) continua abrindo com o SECRET.
 */
export interface IntegrationSecrets {
  open(kind: string, sealed: string): string;
  seal(kind: string, plain: string): string;
  /** `true` quando há ASAAS_SEAL_KEY: `asaas` é gravado em `a1.`. */
  readonly asaasOwnKey: boolean;
}

function secretsFrom(v1: () => Sealer, a1: (() => Sealer) | null): IntegrationSecrets {
  return {
    asaasOwnKey: a1 !== null,
    open(kind, sealed) {
      if (sealed.startsWith("a1.")) {
        if (kind !== "asaas") throw new Error(`Valor selado inválido: a chave do Asaas não abre a conexão ${kind}`);
        if (a1 === null) throw new Error("ASAAS_SEAL_KEY não definida: o segredo da conexão Asaas em a1 precisa dela");
        return a1().open(sealed);
      }
      if (sealed.startsWith("v1.")) return v1().open(sealed);
      throw new Error("Valor selado inválido");
    },
    seal(kind, plain) {
      return kind === "asaas" && a1 !== null ? a1().seal(plain) : v1().seal(plain);
    },
  };
}

function once<T>(make: () => T): () => T {
  let v: T | undefined;
  return () => (v ??= make());
}

/** Versão pura (sem ler o ambiente): `secret` ausente = processo sem SECRET (serviço de cartão), e `v1.` lança. */
export function createIntegrationSecrets(keys: { secret?: string; asaasKey?: string }): IntegrationSecrets {
  const asaasKey = keys.asaasKey;
  return secretsFrom(
    once(() => createSealer(requireSecret({ SECRET: keys.secret }))),
    asaasKey === undefined ? null : once(() => createAsaasSealer(asaasKey)),
  );
}

let processSecrets: IntegrationSecrets | undefined;
/** As chaves do ambiente do processo, lidas no primeiro uso (o import nunca falha). */
const defaultSecrets = (): IntegrationSecrets =>
  (processSecrets ??= secretsFrom(() => ({ seal, open }), env.ASAAS_SEAL_KEY === undefined ? null : asaasSealer));

/** Abre o segredo de uma conexão com as chaves do processo (ver `IntegrationSecrets`). */
export const openIntegrationSecret = (kind: string, sealed: string): string => defaultSecrets().open(kind, sealed);

/** Devolve a conexão com o segredo já aberto. O segredo nunca deve ser logado nem enviado ao navegador. */
export async function getIntegration<K extends IntegrationKind>(
  tx: Tx,
  storeId: string,
  kind: K,
): Promise<{ config: IntegrationConfig; secret: string | null } | null> {
  const [row] = await tx.select().from(integration).where(and(eq(integration.storeId, storeId), eq(integration.kind, kind)));
  if (!row) return null;
  return { config: row.config as IntegrationConfig, secret: row.secret === null ? null : openIntegrationSecret(kind, row.secret) };
}

/**
 * Grava (upsert) a conexão. `secret` omitido mantém o segredo atual; `null` apaga; texto é selado conforme o tipo
 * (`asaas` em `a1.` com ASAAS_SEAL_KEY; o resto em `v1.` com o SECRET).
 */
export async function saveIntegration(
  tx: Tx,
  storeId: string,
  kind: IntegrationKind,
  config: IntegrationConfig,
  secret?: string | null,
): Promise<void> {
  const sealed = secret === undefined ? undefined : secret === null ? null : defaultSecrets().seal(kind, secret);
  await tx
    .insert(integration)
    .values({ storeId, kind, config, secret: sealed ?? null })
    .onConflictDoUpdate({
      target: [integration.storeId, integration.kind],
      set: { config, updatedAt: new Date(), ...(sealed === undefined ? {} : { secret: sealed }) },
    });
}

/**
 * Re-sela em `a1.` os segredos `asaas` ainda em `v1.` (gravados antes da ASAAS_SEAL_KEY). Roda no boot do app.
 * Sem a chave, não faz nada. Idempotente; devolve quantas conexões mudaram. Percorre as lojas com o papel `app`
 * (RLS: a conexão é da loja); erro numa loja não impede as demais, e o total de falhas vai no erro final.
 * `secrets` existe para os testes.
 */
export async function resealAsaasSecrets(secrets: IntegrationSecrets = defaultSecrets()): Promise<number> {
  if (!secrets.asaasOwnKey) return 0;
  const stores = await db.select({ id: store.id }).from(store);
  let changed = 0;
  let failed = 0;
  for (const s of stores) {
    try {
      changed += await withStore(s.id, async (tx) => {
        const where = and(eq(integration.storeId, s.id), eq(integration.kind, "asaas"));
        const [row] = await tx.select({ secret: integration.secret }).from(integration).where(where);
        if (!row?.secret?.startsWith("v1.")) return 0;
        const resealed = secrets.seal("asaas", secrets.open("asaas", row.secret));
        // Só troca se ninguém regravou a conexão no meio (comparação com o valor lido).
        const done = await tx
          .update(integration)
          .set({ secret: resealed })
          .where(and(where, eq(integration.secret, row.secret)))
          .returning({ storeId: integration.storeId });
        return done.length;
      });
    } catch (e) {
      failed++;
      // Só a mensagem: nunca o valor selado nem o aberto.
      log.error("re-selagem da conexão Asaas falhou na loja", { storeId: s.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (failed > 0) throw new Error(`re-selagem da conexão Asaas falhou em ${failed} loja(s); ${changed} re-selada(s)`);
  return changed;
}
