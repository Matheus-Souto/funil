// Registro de e-mails enviados (`email_log`) e a mensagem fixa de "provedor não configurado". Fica fora do mailer e do
// Resend porque os dois precisam dele (o Resend registra o teste; o mailer, os envios): evita ciclo de importação.
import { sha256 } from "@/lib/crypto";
import type { Tx } from "@/lib/db/client";
import { emailLog } from "@/lib/db/schema";
import { safeErrorMessage } from "@/lib/log";

export const NOT_CONFIGURED = "E-mail não configurado";

export type EmailKind = "delivery" | "seller_notice" | "test" | "recovery" | "team_invite";

/** Registra um envio (destinatário só como sha256). Erro com no máximo 500 caracteres e sem dados de cartão. */
export async function logEmail(
  tx: Tx,
  row: {
    storeId: string;
    orderId?: string | null;
    jobId?: string | null;
    to: string;
    kind: EmailKind;
    status: "sent" | "failed";
    error?: unknown;
    /** Provedor que enviou (ou tentou enviar); nulo quando a falha veio antes de saber qual era. */
    provider?: "smtp" | "resend" | null;
    /** Id da mensagem no provedor (só o Resend devolve). */
    messageId?: string | null;
  },
): Promise<void> {
  const error = row.error === undefined ? null : safeErrorMessage(row.error).slice(0, 500);
  await tx.insert(emailLog).values({
    storeId: row.storeId,
    orderId: row.orderId ?? null,
    jobId: row.jobId ?? null,
    toHash: sha256(row.to.trim().toLowerCase()),
    kind: row.kind,
    status: row.status,
    error,
    provider: row.provider ?? null,
    providerMessageId: row.messageId ?? null,
  });
}
