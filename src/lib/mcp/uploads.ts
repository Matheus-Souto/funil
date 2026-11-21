// Upload de PDF por link (D12 e D13). O agente pede `products.createUploadLink` (nome do produto e do arquivo) e recebe
// uma URL de uso único: `PUT <BASE_URL>/api/mcp/upload/<chave>` com o PDF no corpo cria o produto pelo mesmo caminho de
// `products.create`. A chave é a única autenticação do PUT (capacidade de uso único, 15 min, só PDF).
//
// Chave: `upl_` + storeId (32 hex, sem hífens) + `_` + 32 bytes aleatórios em base64url (43 caracteres). Só o sha256 da
// chave inteira é guardado; a URL aparece uma vez, na resposta da ferramenta, e nunca vai para log nem auditoria.
// A resolução tira a loja da própria chave e consulta SÓ dentro do RLS dela. A chave só é gasta quando o produto é
// criado: arquivo inválido devolve o erro e a chave segue valendo, até 5 tentativas na validade.
//
// Memória: cada PUT pode guardar até 50 MB. A rota reserva a tentativa no banco ANTES de ler o corpo (sem reserva, 429
// sem ler) e só lê corpo com vaga no semáforo do processo: 2 corpos ao mesmo tempo no total e 1 por link (acima disso,
// 429 com retry-after). A vaga é solta no `finally`, no sucesso ou no erro.
import { and, count, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction, runAction, type Actor } from "@/lib/actions/core";
import type { Role } from "@/lib/actions/permissions";
import {
  assertProductPdf,
  insertProductRow,
  MAX_PDF_BYTES,
  pdfBytes,
  productFileName,
  productName,
  putProductFile,
  removeProductFile,
} from "@/lib/catalog/products";
import { clientIpFrom, UNKNOWN_IP } from "@/lib/client-ip";
import { randomToken, sha256 } from "@/lib/crypto";
import { withStore } from "@/lib/db/client";
import { mcpToken, uploadLink } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { readBytesCapped, UPLOAD_ERROR_STATUS } from "@/lib/http";
import { checkRateLimit, ipRateKey } from "@/lib/payments/ratelimit";
import { toUuid } from "./tokens";

const PREFIX = "upl_";
const KEY_RE = /^upl_([0-9a-f]{32})_[A-Za-z0-9_-]{43}$/;
const OPEN_PER_STORE = 10;
const LINKS_PER_TOKEN_PER_HOUR = 20;
const MAX_ATTEMPTS = 5;
const IP_LIMIT = 30;
/** Sem IP conhecido (`TRUST_PROXY=0` ou sem cabeçalho do proxy), todos os PUTs dividem um balde global. */
const GLOBAL_KEY = "mcp:upload:global";
const GLOBAL_LIMIT = 60;
const IP_WINDOW_SEC = 60;
/** Corpos de upload lidos ao mesmo tempo no processo (cada um até 50 MB) e por link. */
const MAX_BODIES = 2;
const BUSY_RETRY_SEC = 10;
/** Loja usada na consulta quando a chave nem tem o formato: a mesma consulta roda e não acha nada. */
const NIL_STORE = "00000000-0000-0000-0000-000000000000";

export function mintUploadKey(storeId: string): { key: string; hash: string } {
  const key = `${PREFIX}${storeId.replaceAll("-", "").toLowerCase()}_${randomToken(32)}`;
  return { key, hash: sha256(key) };
}

/**
 * Loja, link, token, papel do token e tentativas já feitas, ou `null` (formato inválido, loja inexistente, hash desconhecido, vencido, usado ou
 * token revogado: o chamador não distingue os casos). Uma consulta só, a mesma em todo caso (inclusive formato
 * inválido, na loja nula): o tempo de resposta não diz qual caso foi.
 */
export async function resolveUploadKey(
  raw: string,
): Promise<{ storeId: string; linkId: string; tokenId: string; role: Role; attempts: number } | null> {
  const m = KEY_RE.exec(raw);
  const storeId = m ? toUuid(m[1]!) : NIL_STORE;
  const hash = sha256(m ? raw : "");
  const [row] = await withStore(storeId, (tx) =>
    tx
      .select({ id: uploadLink.id, tokenId: uploadLink.tokenId, role: mcpToken.role, attempts: uploadLink.attempts })
      .from(uploadLink)
      .innerJoin(mcpToken, eq(mcpToken.id, uploadLink.tokenId))
      .where(and(eq(uploadLink.keyHash, hash), isNull(uploadLink.usedAt), gt(uploadLink.expiresAt, sql`now()`), isNull(mcpToken.revokedAt)))
      .limit(1),
  );
  return m && row ? { storeId, linkId: row.id, tokenId: row.tokenId, role: row.role as Role, attempts: row.attempts } : null;
}

function tokenIdOf(actor: Actor): string {
  if (actor.kind !== "token") throw new ActionError("forbidden", "Só um token MCP usa o upload por link");
  return actor.tokenId;
}

export const createUploadLink = defineAction({
  name: "products.createUploadLink",
  description:
    "Cria um link de upload de uso único (vale 15 minutos) para um produto novo. Envie o PDF com PUT na uploadUrl " +
    "(Content-Type: application/pdf, até 50 MB); o produto é criado quando o PDF chega. Arquivo inválido pode ser " +
    "reenviado no mesmo link (até 5 tentativas).",
  input: z.object({ name: productName, fileName: productFileName }),
  permission: "products.write",
  // Nunca a URL: só o que identifica o pedido.
  auditInput: (i) => ({ name: i.name, fileName: i.fileName }),
  async run(ctx, input) {
    const tokenId = tokenIdOf(ctx.actor);
    // Um link por vez na loja: contagem e inserção sem corrida.
    await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`upload_link:${ctx.storeId}`}))`);
    const [{ n: open } = { n: 0 }] = await ctx.tx
      .select({ n: count() })
      .from(uploadLink)
      .where(and(isNull(uploadLink.usedAt), gt(uploadLink.expiresAt, sql`now()`)));
    if (open >= OPEN_PER_STORE) throw new ActionError("rate_limited", `A loja já tem ${OPEN_PER_STORE} links de upload abertos. Use um deles ou espere vencer.`);
    const [{ n: lastHour } = { n: 0 }] = await ctx.tx
      .select({ n: count() })
      .from(uploadLink)
      .where(and(eq(uploadLink.tokenId, tokenId), gt(uploadLink.createdAt, sql`now() - interval '1 hour'`)));
    if (lastHour >= LINKS_PER_TOKEN_PER_HOUR) throw new ActionError("rate_limited", `Limite de ${LINKS_PER_TOKEN_PER_HOUR} links de upload por hora deste token`);

    const { key, hash } = mintUploadKey(ctx.storeId);
    const [row] = await ctx.tx
      .insert(uploadLink)
      .values({ storeId: ctx.storeId, tokenId, name: input.name, fileName: input.fileName, keyHash: hash, expiresAt: sql`now() + interval '15 minutes'` })
      .returning({ expiresAt: uploadLink.expiresAt });
    return {
      uploadUrl: `${env.BASE_URL}/api/mcp/upload/${key}`,
      method: "PUT" as const,
      contentType: "application/pdf" as const,
      maxBytes: MAX_PDF_BYTES,
      expiresAt: row!.expiresAt,
    };
  },
});

/** Link deste token, não usado, no prazo e de token não revogado (a revogação vale antes da inspeção do PDF). */
const usable = (linkId: string, tokenId: string) =>
  and(
    eq(uploadLink.id, linkId),
    eq(uploadLink.tokenId, tokenId),
    isNull(uploadLink.usedAt),
    gt(uploadLink.expiresAt, sql`now()`),
    sql`exists (select 1 from ${mcpToken} where ${mcpToken.id} = ${tokenId} and ${mcpToken.revokedAt} is null)`,
  );

type ProductView = Awaited<ReturnType<typeof insertProductRow>>;

const tooManyAttempts = () => new ActionError("rate_limited", "Tentativas demais neste link de upload. Peça um link novo.");

const gone = () => new ActionError("conflict", "Este link de upload já foi usado ou venceu.");

export const completeUpload = defineAction({
  name: "products.completeUpload",
  description: "Recebe o PDF de um link de upload (products.createUploadLink) e cria o produto. Chamada pela rota PUT /api/mcp/upload/[key].",
  input: z.object({ linkId: z.uuid(), file: pdfBytes }),
  permission: "products.write",
  // O arquivo nunca vai para a auditoria: o link e o tamanho; nome e nome do arquivo (que vêm do link) saem em `result`.
  auditInput: (i) => ({ linkId: i.linkId, fileSize: i.file.length }),
  auditResult: (out: ProductView) => ({ id: out.id, name: out.name, fileName: out.fileName }),
  // A tentativa já foi reservada pela rota antes de ler o corpo (`reserveUploadAttempt`): aqui só confere o link e valida
  // o PDF antes da transação principal. Fila do Worker de PDF cheia não é culpa do arquivo: devolve a tentativa.
  async prepare(call, input) {
    const tokenId = tokenIdOf(call.actor);
    const [link] = await withStore(call.storeId, (tx) =>
      tx
        .select({ attempts: uploadLink.attempts, name: uploadLink.name, fileName: uploadLink.fileName })
        .from(uploadLink)
        .where(usable(input.linkId, tokenId)),
    );
    if (!link) throw gone();
    if (link.attempts > MAX_ATTEMPTS) throw tooManyAttempts();
    try {
      await assertProductPdf(input.file);
    } catch (e) {
      // O único rate_limited de assertProductPdf é a fila do Worker cheia (PdfBusyError).
      if (e instanceof ActionError && e.code === "rate_limited") await releaseUploadAttempt(call.storeId, input.linkId);
      throw e;
    }
    return { name: link.name, fileName: link.fileName };
  },
  async run(ctx, input, link) {
    const tokenId = tokenIdOf(ctx.actor);
    // Reivindica o link (uso único): um PUT simultâneo espera este commit e não acha mais a linha.
    const [claimed] = await ctx.tx
      .update(uploadLink)
      .set({ usedAt: sql`now()` })
      .where(usable(input.linkId, tokenId))
      .returning({ id: uploadLink.id });
    if (!claimed) throw gone();
    const row = await insertProductRow(ctx, { name: link.name, fileName: link.fileName, bytes: input.file });
    await ctx.tx.update(uploadLink).set({ productId: row.id }).where(eq(uploadLink.id, input.linkId));
    // Último passo: se a gravação falhar, a exceção desfaz a transação (e o link volta a valer).
    await putProductFile(ctx.storeId, row.id, input.file);
    return row;
  },
  compensate: (call, _input, out) => removeProductFile(call.storeId, out.id),
});

/**
 * Reserva uma tentativa do link antes de ler o corpo: `attempts + 1` só se o link ainda vale (não usado, no prazo, token
 * não revogado) e tem tentativa sobrando. `false` = sem reserva (a rota responde 429 sem ler).
 */
export async function reserveUploadAttempt(storeId: string, linkId: string, tokenId: string): Promise<boolean> {
  const rows = await withStore(storeId, (tx) =>
    tx
      .update(uploadLink)
      .set({ attempts: sql`${uploadLink.attempts} + 1` })
      .where(and(usable(linkId, tokenId), lt(uploadLink.attempts, MAX_ATTEMPTS)))
      .returning({ id: uploadLink.id }),
  );
  return rows.length > 0;
}

/** Devolve a tentativa reservada (fila de PDF cheia: o arquivo nem foi avaliado). Nunca abaixo de zero. */
async function releaseUploadAttempt(storeId: string, linkId: string): Promise<void> {
  await withStore(storeId, (tx) =>
    tx
      .update(uploadLink)
      .set({ attempts: sql`greatest(${uploadLink.attempts} - 1, 0)` })
      .where(and(eq(uploadLink.id, linkId), isNull(uploadLink.usedAt))),
  );
}

// Semáforo do processo para corpos de upload: no total e por link.
let bodiesInFlight = 0;
const linksInFlight = new Set<string>();

/** Vaga para ler o corpo de um upload deste link, ou `null` (2 no processo ou 1 neste link já lendo). */
function acquireBodySlot(linkId: string): (() => void) | null {
  if (bodiesInFlight >= MAX_BODIES || linksInFlight.has(linkId)) return null;
  bodiesInFlight++;
  linksInFlight.add(linkId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    bodiesInFlight--;
    linksInFlight.delete(linkId);
  };
}

export interface UploadHttpOptions {
  /** Proxies confiáveis para o IP do cliente (padrão: `TRUST_PROXY`). */
  trustProxy?: number;
  /** Relógio do limite por IP (testes). */
  now?: () => Date;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

/**
 * PUT /api/mcp/upload/[key]. Ordem: método → limite por IP, ou global sem IP conhecido (antes de consultar a chave,
 * contra varredura) → chave (404 com o MESMO corpo em todo caso de falha) → tentativas esgotadas (429) → Content-Type
 * (415) → Content-Length acima do teto (413) → vaga no semáforo do processo (429 com retry-after) → reserva da tentativa
 * no banco (sem reserva, 429) → corpo em streaming com teto de 50 MB → `products.completeUpload` como o token que pediu o
 * link. Nada antes da reserva lê o corpo. A chave nunca vai para log.
 */
export async function handleUploadRequest(req: Request, key: string, opts: UploadHttpOptions = {}): Promise<Response> {
  if (req.method !== "PUT") return json(405, { error: "Método não permitido. Envie o PDF com PUT." }, { allow: "PUT" });
  const now = opts.now ?? (() => new Date());

  const ip = clientIpFrom(req.headers, opts.trustProxy ?? env.TRUST_PROXY);
  const [limitKey, limit] = ip === UNKNOWN_IP ? [GLOBAL_KEY, GLOBAL_LIMIT] : [`mcp:upload:ip:${ipRateKey(ip)}`, IP_LIMIT];
  if (!(await checkRateLimit(limitKey, limit, IP_WINDOW_SEC, now()))) {
    return json(429, { error: "Muitas requisições. Tente de novo em um minuto." }, { "retry-after": String(IP_WINDOW_SEC) });
  }

  const link = await resolveUploadKey(key);
  if (!link) return json(404, { error: "Link de upload inválido ou vencido." });
  // Link que já gastou as tentativas: recusa sem ler o corpo (senão cada PUT ainda guardaria até 50 MB na memória).
  if (link.attempts >= MAX_ATTEMPTS) return json(UPLOAD_ERROR_STATUS.rate_limited, { error: tooManyAttempts().message });
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/pdf")) {
    return json(415, { error: "Envie o PDF com Content-Type application/pdf." });
  }
  const tooBig = () => json(413, { error: "O PDF passa de 50 MB." });
  if (Number(req.headers.get("content-length") ?? 0) > MAX_PDF_BYTES) return tooBig();

  const release = acquireBodySlot(link.linkId);
  if (!release) {
    return json(429, { error: "Outro envio está em andamento. Tente de novo em instantes." }, { "retry-after": String(BUSY_RETRY_SEC) });
  }
  try {
    if (!(await reserveUploadAttempt(link.storeId, link.linkId, link.tokenId))) {
      return json(UPLOAD_ERROR_STATUS.rate_limited, { error: tooManyAttempts().message });
    }
    const file = await readBytesCapped(req, MAX_PDF_BYTES);
    if (file === null) return tooBig();
    const actor = { kind: "token", tokenId: link.tokenId, role: link.role } as const;
    const out = await runAction(completeUpload, { storeId: link.storeId, actor, origin: "mcp" }, { linkId: link.linkId, file });
    return json(201, { id: out.id, name: out.name, fileName: out.fileName, fileSize: out.fileSize });
  } catch (e) {
    if (e instanceof ActionError) return json(UPLOAD_ERROR_STATUS[e.code], { error: e.message });
    throw e;
  } finally {
    release();
  }
}
