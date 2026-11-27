// Qual tela o checkout mostra diante do `?s=` (sessão de pagamento do app), decidido antes de qualquer formulário ou
// analytics. Só chama `runAction` (a regra fica em `checkout.appSession`, src/lib/apps/sessions.ts).
import { ActionError, runAction } from "@/lib/actions/core";
import { SESSION_INVALID_MESSAGE, checkoutAppSession } from "@/lib/apps/sessions";
import { APP_SESSION_REQUIRED_MESSAGE } from "@/lib/checkout";

/** Dados travados da sessão que o formulário mostra (o mesmo formato de `AppSession` em checkout-form.tsx). */
export interface AppSessionView {
  sessionId: string;
  name: string;
  email: string;
  hasPhone: boolean;
}

/**
 * - Oferta de app: só abre com a sessão válida. Sem `s`: "Abra o pagamento pelo app"; `s` vencido, pago, de outra
 *   oferta ou malformado: link vencido. Válida: os dados travados.
 * - Oferta de download com `s` (link trocado ou copiado): link vencido, sem formulário e sem Pixel (que mandaria a URL
 *   com o `s` ao Meta).
 * - Oferta de download sem `s`: `null` (checkout normal).
 */
export async function appGate(
  storeId: string,
  slug: string,
  delivery: "download" | "app",
  s: string | undefined,
  now?: Date,
): Promise<{ session: AppSessionView } | { blocked: string } | null> {
  if (delivery !== "app") return s === undefined ? null : { blocked: SESSION_INVALID_MESSAGE };
  if (!s) return { blocked: APP_SESSION_REQUIRED_MESSAGE };
  try {
    const call = { storeId, actor: { kind: "public" } as const, origin: "public" as const, ...(now ? { server: { now } } : {}) };
    const r = await runAction(checkoutAppSession, call, { slug, sessionId: s });
    return { session: { sessionId: s, name: r.buyerName, email: r.buyerEmail, hasPhone: r.hasPhone } };
  } catch (e) {
    if (e instanceof ActionError && (e.code === "conflict" || e.code === "invalid_input")) return { blocked: SESSION_INVALID_MESSAGE };
    throw e;
  }
}
