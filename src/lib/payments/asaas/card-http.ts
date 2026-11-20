// Resposta HTTP da cobrança com cartão no serviço isolado (src/card-service/server.ts): códigos e mensagens nossas,
// nunca o corpo da requisição nem campos do cartão. IP do comprador e HTTPS: src/lib/client-ip.ts.
import { ActionError, type ActionErrorCode } from "@/lib/actions/core";
import { errorFields, log } from "@/lib/log";

const INTERNAL_MESSAGE = "Não foi possível processar o pagamento. Verifique em instantes antes de tentar de novo.";

const STATUS: Record<ActionErrorCode, number> = {
  invalid_input: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  approval_required: 403,
  provider_error: 502,
  rate_limited: 429,
};

/**
 * Resposta HTTP de um erro da cobrança com cartão. Nunca ecoa o corpo nem campos do cartão: `ActionError` vira
 * código + mensagem nossa (+ caminhos dos campos ou `captcha`); o resto, 500 genérico com o erro no `log` (que aplica a
 * máscara de cartão).
 */
export function cardErrorResponse(e: unknown): { status: number; body: object } {
  if (e instanceof ActionError) {
    // Mensagens de ActionError deste fluxo são nossas (as do Asaas no cartão são opacas); detalhes só se seguros.
    const extra =
      e.code === "invalid_input" && Array.isArray(e.details)
        ? { fields: (e.details as { path?: unknown }[]).map((d) => d.path) }
        : e.code === "rate_limited" && (e.details as { captcha?: boolean } | undefined)?.captcha
          ? { captcha: true }
          : {};
    return { status: STATUS[e.code] ?? 400, body: { error: e.code, message: e.message, ...extra } };
  }
  // Sem texto livre do erro (pode trazer dados do comprador; ver `errorFields`). Nunca registramos o corpo da requisição.
  log.error("checkout cartão: erro inesperado", errorFields(e));
  return { status: 500, body: { error: "internal", message: INTERNAL_MESSAGE } };
}
