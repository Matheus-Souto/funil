import { and, eq } from "drizzle-orm";
import { db, withStore, type Tx } from "@/lib/db/client";
import { integration, store } from "@/lib/db/schema";
import { createAsaasSealer, createSealer, type Sealer } from "@/lib/crypto";
import { env, requireSecret } from "@/lib/env";
import { log } from "@/lib/log";

export type IntegrationKind = "pix_manual" | "asaas" | "smtp" | "meta";
export type IntegrationConfig = Record<string, unknown>;

/**
 * Abre e sela segredos de conexão conforme o tipo. `asaas` é gravado com a chave própria (`a1.`, ASAAS_SEAL_KEY) só
 * com o isolamento ligado (CARD_ISOLATED=1), para o serviço de cartão abri-la sem o SECRET; com ele desligado, segue
 * em `v1.` (uma imagem anterior ao isolamento continua abrindo). As demais (SMTP, Meta...) sempre usam o SECRET (`v1.`)
 * e nunca abrem com a chave do Asaas. Abrir: `a1.` com a chave (se ela existir), `v1.` com o SECRET.
 */
export interface IntegrationSecrets {
  open(kind: string, sealed: string): string;
  seal(kind: string, plain: string): string;
  /** `true` quando `asaas` é gravado em `a1.` (há ASAAS_SEAL_KEY e a selagem própria está ligada). */
  readonly asaasOwnKey: boolean;
}

function secretsFrom(v1: () => Sealer, a1: (() => Sealer) | null, sealAsaas: boolean): IntegrationSecrets {
  const sealA1 = sealAsaas ? a1 : null;
  return {
    asaasOwnKey: sealA1 !== null,
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
      return kind === "asaas" && sealA1 !== null ? sealA1().seal(plain) : v1().seal(plain);
    },
  };
}

function once<T>(make: () => T): () => T {
  let v: T | undefined;
  return () => (v ??= make());
}

/**
 * Versão pura (sem ler o ambiente): `secret` ausente = processo sem SECRET (serviço de cartão), e `v1.` lança.
 * `sealAsaas` (padrão `true`): grava `asaas` em `a1.` quando há `asaasKey`; `false` grava em `v1.` e só abre `a1.`.
 */
export function createIntegrationSecrets(keys: { secret?: string; asaasKey?: string; sealAsaas?: boolean }): IntegrationSecrets {
  const asaasKey = keys.asaasKey;
  return secretsFrom(
    once(() => createSealer(requireSecret({ SECRET: keys.secret }))),
    asaasKey === undefined ? null : once(() => createAsaasSealer(asaasKey)),
    keys.sealAsaas ?? true,
  );
}

/**
 * Regra do processo a partir do ambiente: `asaas` em `a1.` só com CARD_ISOLATED=1 (a mesma condição da re-selagem
 * no boot). Assim, definir a ASAAS_SEAL_KEY antes de ligar o isolamento não tranca a loja num rollback de imagem.
 */
export function integrationSecretsFor(e: { SECRET?: string; ASAAS_SEAL_KEY?: string; CARD_ISOLATED: boolean }): IntegrationSecrets {
  return createIntegrationSecrets({ secret: e.SECRET, asaasKey: e.ASAAS_SEAL_KEY, sealAsaas: e.CARD_ISOLATED });
}

let processSecrets: IntegrationSecrets | undefined;
/** As chaves do ambiente do processo, lidas no primeiro uso (o import nunca falha). */
const defaultSecrets = (): IntegrationSecrets =>
  (processSecrets ??= integrationSecretsFor(env));

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
 * Como `getIntegration`, mas um segredo que não abre (ASAAS_SEAL_KEY trocada ou ausente, rollback) não lança: volta
 * `secret: null` e `unreadable: true`. Só para o painel e para regravar a conexão; pagamento usa `getIntegration`.
 */
export async function readIntegration(
  tx: Tx,
  storeId: string,
  kind: IntegrationKind,
): Promise<{ config: IntegrationConfig; secret: string | null; unreadable: boolean } | null> {
  const [row] = await tx.select().from(integration).where(and(eq(integration.storeId, storeId), eq(integration.kind, kind)));
  if (!row) return null;
  const config = row.config as IntegrationConfig;
  if (row.secret === null) return { config, secret: null, unreadable: false };
  try {
    return { config, secret: openIntegrationSecret(kind, row.secret), unreadable: false };
  } catch (e) {
    log.warn("segredo da conexão não pode ser aberto", { storeId, kind, error: e });
    return { config, secret: null, unreadable: true };
  }
}

/**
 * Grava (upsert) a conexão. `secret` omitido mantém o segredo atual; `null` apaga; texto é selado conforme o tipo
 * (`asaas` em `a1.` com ASAAS_SEAL_KEY e CARD_ISOLATED=1; o resto, e `asaas` com o isolamento desligado, em `v1.`).
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
      // O objeto do erro, nunca a mensagem crua: o log.ts troca erro de consulta (SQL + params com os selos) por um
      // texto genérico com o código do Postgres.
      log.error("re-selagem da conexão Asaas falhou na loja", { storeId: s.id, error: e });
    }
  }
  if (failed > 0) throw new Error(`re-selagem da conexão Asaas falhou em ${failed} loja(s); ${changed} re-selada(s)`);
  return changed;
}

/**
 * Confere se as chaves do processo abrem as conexões `asaas` já em `a1.`: `sealed` = quantas estão em a1,
 * `unreadable` = quantas delas não abrem (ASAAS_SEAL_KEY ausente ou diferente). Usada no boot do app e do serviço de
 * cartão. Erro de banco propaga. `secrets` existe para os testes.
 */
export async function checkAsaasSealKey(secrets: IntegrationSecrets = defaultSecrets()): Promise<{ sealed: number; unreadable: number }> {
  const stores = await db.select({ id: store.id }).from(store);
  let sealed = 0;
  let unreadable = 0;
  for (const s of stores) {
    const [row] = await withStore(s.id, (tx) =>
      tx
        .select({ secret: integration.secret })
        .from(integration)
        .where(and(eq(integration.storeId, s.id), eq(integration.kind, "asaas"))),
    );
    if (!row?.secret?.startsWith("a1.")) continue;
    sealed++;
    try {
      secrets.open("asaas", row.secret);
    } catch {
      unreadable++;
    }
  }
  return { sealed, unreadable };
}

/**
 * Passo do boot do app: re-sela `asaas` v1 -> a1 só com CARD_ISOLATED=1 (o passo é irreversível; no fluxo antigo não
 * há por que dar), com falha só no log; depois confere a chave (`checkAsaasSealKey`). Erro na conferência propaga.
 */
export async function prepareAsaasSealOnBoot(
  opts: { cardIsolated: boolean },
  secrets: IntegrationSecrets = defaultSecrets(),
): Promise<{ resealed: number; sealed: number; unreadable: number }> {
  let resealed = 0;
  if (opts.cardIsolated) {
    try {
      resealed = await resealAsaasSecrets(secrets);
      if (resealed > 0) log.info("conexões Asaas re-seladas com a ASAAS_SEAL_KEY", { count: resealed });
    } catch (e) {
      // Não derruba: um `v1.` continua abrindo com o SECRET no app.
      log.error("re-selagem das conexões Asaas falhou no boot", { error: e });
    }
  }
  return { resealed, ...(await checkAsaasSealKey(secrets)) };
}
