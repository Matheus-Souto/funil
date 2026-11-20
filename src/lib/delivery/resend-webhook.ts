// Webhook de status do Resend (assinado no padrão Svix): grava entregue/devolvido/spam no `email_log` da loja.
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { defineAction, runAction } from "@/lib/actions/core";
import { withStore } from "@/lib/db/client";
import { emailLog } from "@/lib/db/schema";
import { log } from "@/lib/log";
import { loadResend } from "./resend";
import { verifySvix } from "./svix";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS = { "email.delivered": "delivered", "email.bounced": "bounced", "email.complained": "complained" } as const;
type EventType = keyof typeof STATUS;
/** Segredo de mentira: sem conexão/segredo a loja ainda gasta um HMAC (não vaza por tempo qual caso ocorreu). */
const DECOY_SECRET = "whsec_ZGVjb3ktc2VjcmV0LW5vLXN0b3Jl";

const eventBody = z.object({
  type: z.string(),
  created_at: z.string().refine((s) => !Number.isNaN(Date.parse(s))),
  data: z.object({ email_id: z.string().max(100) }),
});

/**
 * Grava o estado de entrega da mensagem. Precedência no SQL: `delivered` só entra se não há estado; `bounced` e
 * `complained` sempre entram (o último vence entre os dois). Idempotente.
 */
export const applyResendEvent = defineAction({
  name: "email.applyResendEvent",
  description: "Grava no e-mail enviado pelo Resend o estado de entrega informado pelo webhook.",
  input: z.object({
    type: z.enum(["email.delivered", "email.bounced", "email.complained"]),
    emailId: z.string().min(1).max(100),
    at: z.date(),
  }),
  permission: "system",
  audit: false,
  async run(ctx, p) {
    const status = STATUS[p.type];
    const rows = await ctx.tx
      .update(emailLog)
      .set({ deliveryStatus: status, deliveryStatusAt: p.at })
      .where(
        and(
          // Defesa em profundidade: além da RLS, só e-mails da loja do webhook.
          eq(emailLog.storeId, ctx.storeId),
          eq(emailLog.provider, "resend"),
          eq(emailLog.providerMessageId, p.emailId),
          status === "delivered" ? sql`${emailLog.deliveryStatus} is null` : undefined,
        ),
      )
      .returning({ id: emailLog.id });
    return { updated: rows.length };
  },
});

export async function handleResendWebhook(storeId: string, headers: Headers, body: string): Promise<{ status: number }> {
  if (!UUID.test(storeId)) return { status: 404 };
  const conn = await withStore(storeId, (tx) => loadResend(tx, storeId));
  const secret = conn?.webhookSecret ?? null;
  const sig = {
    id: headers.get("svix-id") ?? "",
    timestamp: headers.get("svix-timestamp") ?? "",
    signature: headers.get("svix-signature") ?? "",
  };
  // Calcula sempre (mesmo sem segredo) para não vazar por tempo qual caso ocorreu.
  const ok = verifySvix(secret ?? DECOY_SECRET, sig, body);
  if (!secret || !sig.id || !sig.timestamp || !sig.signature || !ok) return { status: 401 };

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { status: 200 };
  }
  const parsed = eventBody.safeParse(json);
  if (!parsed.success || !Object.hasOwn(STATUS, parsed.data.type)) return { status: 200 };

  try {
    await runAction(
      applyResendEvent,
      { storeId, actor: { kind: "system" }, origin: "webhook" },
      { type: parsed.data.type as EventType, emailId: parsed.data.data.email_id, at: new Date(parsed.data.created_at) },
    );
  } catch (e) {
    log.error("webhook Resend: falha ao gravar estado de entrega", { storeId, error: e });
    return { status: 500 };
  }
  return { status: 200 };
}
