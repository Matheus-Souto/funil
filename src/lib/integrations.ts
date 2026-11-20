import { and, eq } from "drizzle-orm";
import { db, withStore, type Tx } from "@/lib/db/client";
import { integration, store } from "@/lib/db/schema";
import { createAsaasSealer, createSealer, type Sealer } from "@/lib/crypto";
import { env, requireSecret } from "@/lib/env";
import { log } from "@/lib/log";

export type IntegrationKind = "pix_manual" | "asaas" | "smtp" | "meta";
export type IntegrationConfig = Record<string, unknown>;

/**
 * Abre e sela segredos de conexão conforme o tipo. `asaas` é gravado com a chave própria (`a1.`, ASAAS_SEAL_KEY) sempre
 * que ela existe, para o serviço de cartão abri-la sem o SECRET; sem ela, em `v1.`. As demais (SMTP, Meta...) sempre
 * usam o SECRET (`v1.`) e nunca abrem com a chave do Asaas. Abrir: `a1.` com a chave (se ela existir), `v1.` com o SECRET.
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

/** Regra do processo a partir do ambiente: `asaas` em `a1.` sempre que há ASAAS_SEAL_KEY (a mesma condição da re-selagem no boot). */
export function integrationSecretsFor(e: { SECRET?: string; ASAAS_SEAL_KEY?: string }): IntegrationSecrets {
  return createIntegrationSecrets({ secret: e.SECRET, asaasKey: e.ASAAS_SEAL_KEY });
}

let processSecrets: IntegrationSecrets | undefined;
/** As chaves do ambiente do processo, lidas no primeiro uso (o import nunca falha). */
const defaultSecrets = (): IntegrationSecrets =>
  (processSecrets ??= integrationSecretsFor(env));

/**
 * Segredo de conexão que as chaves do processo não abrem (ex.: `v1.` no serviço de cartão, que não tem o SECRET, ou
 * `a1.` com a ASAAS_SEAL_KEY trocada). A mensagem não leva valores; a causa original fica em `cause`.
 */
export class IntegrationSecretUnreadable extends Error {
  override name = "IntegrationSecretUnreadable";
  constructor(kind: string, options?: { cause?: unknown }) {
    super(`o segredo da conexão ${kind} não pode ser aberto com as chaves deste processo`, options);
  }
}

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
  if (row.secret === null) return { config: row.config as IntegrationConfig, secret: null };
  let secret: string;
  try {
    secret = openIntegrationSecret(kind, row.secret);
  } catch (e) {
    throw new IntegrationSecretUnreadable(kind, { cause: e });
  }
  return { config: row.config as IntegrationConfig, secret };
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
 * (`asaas` em `a1.` com ASAAS_SEAL_KEY; o resto, e `asaas` sem a chave, em `v1.`).
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
 * Regrava, loja a loja, os segredos `asaas` que começam com `from` usando `convert` (abrir e selar de novo). Percorre as
 * lojas com o papel `app` (RLS: a conexão é da loja); só troca se ninguém regravou a conexão no meio (comparação com o
 * valor lido). Erro numa loja não impede as demais: vai para o log com a loja e o objeto do erro, nunca a mensagem crua
 * (o log.ts troca erro de consulta, com SQL e os selos nos `params`, por um texto genérico com o código do Postgres).
 */
async function rewriteAsaasSecrets(from: "v1." | "a1.", convert: (sealed: string) => string, failure: string): Promise<{ changed: number; failed: number }> {
  const stores = await db.select({ id: store.id }).from(store);
  let changed = 0;
  let failed = 0;
  for (const s of stores) {
    try {
      changed += await withStore(s.id, async (tx) => {
        const where = and(eq(integration.storeId, s.id), eq(integration.kind, "asaas"));
        const [row] = await tx.select({ secret: integration.secret }).from(integration).where(where);
        if (!row?.secret?.startsWith(from)) return 0;
        const done = await tx
          .update(integration)
          .set({ secret: convert(row.secret) })
          .where(and(where, eq(integration.secret, row.secret)))
          .returning({ storeId: integration.storeId });
        return done.length;
      });
    } catch (e) {
      failed++;
      log.error(failure, { storeId: s.id, error: e });
    }
  }
  return { changed, failed };
}

/**
 * Re-sela em `a1.` os segredos `asaas` ainda em `v1.` (gravados antes da ASAAS_SEAL_KEY). Roda no boot do app.
 * Sem a chave, não faz nada. Idempotente; devolve quantas conexões mudaram; o total de falhas vai no erro final.
 * `secrets` existe para os testes.
 */
export async function resealAsaasSecrets(secrets: IntegrationSecrets = defaultSecrets()): Promise<number> {
  if (!secrets.asaasOwnKey) return 0;
  const { changed, failed } = await rewriteAsaasSecrets("v1.", (v) => secrets.seal("asaas", secrets.open("asaas", v)), "re-selagem da conexão Asaas falhou na loja");
  if (failed > 0) throw new Error(`re-selagem da conexão Asaas falhou em ${failed} loja(s); ${changed} re-selada(s)`);
  return changed;
}

/**
 * O inverso de `resealAsaasSecrets` (CLI `asaas:unseal`, rollback do isolamento): regrava em `v1.` (SECRET) os
 * segredos `asaas` em `a1.` (ASAAS_SEAL_KEY), para uma imagem anterior ao isolamento abrir a conexão sem o vendedor
 * colar a chave de novo. Precisa das duas chaves. Idempotente (`v1.` e vazio ficam como estão). Uma conexão que não
 * abre (ou falha ao gravar) não impede as demais: conta em `remaining` e vai para o log só com a loja.
 */
export async function unsealAsaasSecrets(keys: { secret?: string; asaasKey?: string }): Promise<{ unsealed: number; remaining: number }> {
  if (!keys.asaasKey) throw new Error("ASAAS_SEAL_KEY é obrigatória para regravar as conexões Asaas em v1");
  if (!keys.secret) throw new Error("SECRET é obrigatório para regravar as conexões Asaas em v1");
  // sealAsaas false: abre `a1.` com a chave e grava `asaas` em `v1.` com o SECRET.
  const secrets = createIntegrationSecrets({ secret: keys.secret, asaasKey: keys.asaasKey, sealAsaas: false });
  const toV1 = (a1: string) => {
    const v1 = secrets.seal("asaas", secrets.open("asaas", a1));
    if (!v1.startsWith("v1.")) throw new Error("selagem inesperada: esperado v1");
    return v1;
  };
  const { changed, failed } = await rewriteAsaasSecrets("a1.", toV1, "regravação da conexão Asaas em v1 falhou na loja");
  return { unsealed: changed, remaining: failed };
}

/**
 * Confere se as chaves do processo abrem as conexões `asaas` já em `a1.`: `sealed` = quantas estão em a1,
 * `unreadable` = quantas delas não abrem (ASAAS_SEAL_KEY ausente ou diferente), `legacy` = quantas seguem em `v1.`
 * (o serviço de cartão, sem SECRET, não as abre). Usada no boot do app e do serviço de cartão. Erro de banco propaga.
 * `secrets` existe para os testes.
 */
export async function checkAsaasSealKey(
  secrets: IntegrationSecrets = defaultSecrets(),
): Promise<{ sealed: number; unreadable: number; legacy: number }> {
  const stores = await db.select({ id: store.id }).from(store);
  let sealed = 0;
  let unreadable = 0;
  let legacy = 0;
  for (const s of stores) {
    const [row] = await withStore(s.id, (tx) =>
      tx
        .select({ secret: integration.secret })
        .from(integration)
        .where(and(eq(integration.storeId, s.id), eq(integration.kind, "asaas"))),
    );
    if (row?.secret?.startsWith("v1.")) legacy++;
    if (!row?.secret?.startsWith("a1.")) continue;
    sealed++;
    try {
      secrets.open("asaas", row.secret);
    } catch {
      unreadable++;
    }
  }
  return { sealed, unreadable, legacy };
}

/**
 * Passo do boot do app: re-sela `asaas` v1 -> a1 sempre que há ASAAS_SEAL_KEY (sem ela, nada), com falha só no log;
 * depois confere a chave (`checkAsaasSealKey`). Erro na conferência propaga.
 */
export async function prepareAsaasSealOnBoot(
  secrets: IntegrationSecrets = defaultSecrets(),
): Promise<{ resealed: number; sealed: number; unreadable: number; legacy: number }> {
  let resealed = 0;
  try {
    resealed = await resealAsaasSecrets(secrets);
    if (resealed > 0) log.info("conexões Asaas re-seladas com a ASAAS_SEAL_KEY", { count: resealed });
  } catch (e) {
    // Não derruba: um `v1.` continua abrindo com o SECRET no app.
    log.error("re-selagem das conexões Asaas falhou no boot", { error: e });
  }
  return { resealed, ...(await checkAsaasSealKey(secrets)) };
}
