"use server";

// Server actions do painel. TODAS começam por requirePanelActor() (o layout não protege ações: elas são endpoints POST)
// e só chamam runAction com o ator da sessão. Nenhuma regra de negócio aqui.
import { redirect } from "next/navigation";
import { ActionError, runAction, type Action } from "@/lib/actions/core";
import { ackAlert } from "@/lib/alerts";
import { changePassword, revokeMemberSessions } from "@/lib/auth/account";
import { destroySession, renewSessionCookie, requirePanelActor, type PanelActor } from "@/lib/auth/session";
import { createOffer, setOfferPixel, setOfferProducts, setOfferSlug, updateOffer, updateOfferPrice } from "@/lib/catalog/offers";
import { saveSmtp, testSmtp } from "@/lib/delivery/mailer";
import { removeTelegram, saveTelegram, testTelegram } from "@/lib/notify/telegram-connection";
import { saveResend, setEmailProvider, testResend } from "@/lib/delivery/resend";
import { resendOrder } from "@/lib/delivery/jobs";
import { saveAsaas } from "@/lib/payments/asaas/pix";
import { releaseOrder, savePixManual } from "@/lib/payments/manual";
import { refundOrder } from "@/lib/payments/refund";
import { updateStoreSettings } from "@/lib/store-settings";
import { saveMeta, testMeta } from "@/lib/tracking/meta";
import type { ActionResult } from "../result";

const ISSUE_TEXT: Record<string, string> = {
  too_small: "está vazio ou curto demais",
  too_big: "está longo demais",
  invalid_format: "tem formato inválido",
  invalid_type: "é inválido",
  invalid_value: "tem um valor inválido",
};

/** Mensagem para a pessoa: nunca a pilha; para entrada inválida, a primeira mensagem do schema (as nossas são em pt-BR). */
function describe(e: ActionError): string {
  if (e.code === "forbidden") return "Seu papel na loja não permite esta ação.";
  if (e.code === "invalid_input" && Array.isArray(e.details) && e.details.length > 0) {
    const first = e.details[0] as { path?: unknown[]; message?: string; code?: string };
    if (first.code === "custom" || (first.message && /[ãáçéêíóõú]|Use |Informe|inválid/i.test(first.message))) return first.message ?? e.message;
    const field = (first.path ?? []).join(".");
    return `O campo ${field || "informado"} ${ISSUE_TEXT[first.code ?? ""] ?? "é inválido"}.`;
  }
  return e.message;
}

async function call<I, O>(panel: PanelActor, action: Action<I, O>, input: unknown, message?: (o: O) => string): Promise<ActionResult<O>> {
  try {
    const data = await runAction(action, { storeId: panel.storeId, actor: panel.actor, origin: "panel" }, input);
    return { ok: true, data, ...(message ? { message: message(data) } : {}) };
  } catch (e) {
    if (e instanceof ActionError) return { ok: false, error: describe(e), code: e.code };
    throw e;
  }
}

// ---- conta e equipe --------------------------------------------------------------------------------------------

const formField = (f: FormData, k: string) => (typeof f.get(k) === "string" ? (f.get(k) as string) : "");

/** Tela /admin/senha: troca a senha, encerra todas as sessões do usuário e abre uma sessão nova neste navegador. */
export async function changePasswordFormAction(form: FormData): Promise<void> {
  const panel = await requirePanelActor({ allowPasswordChange: true });
  const next = formField(form, "newPassword");
  if (next !== formField(form, "confirmPassword")) redirect("/admin/senha?erro=confirmacao");
  let target = "/admin/senha?ok=1";
  try {
    await runAction(changePassword, { storeId: panel.storeId, actor: panel.actor, origin: "panel" }, { currentPassword: formField(form, "currentPassword"), newPassword: next });
    await renewSessionCookie(panel);
  } catch (e) {
    if (!(e instanceof ActionError)) throw e;
    target = `/admin/senha?erro=${e.code === "forbidden" ? "atual" : e.code === "rate_limited" ? "limite" : "nova"}`;
  }
  redirect(target);
}

export async function revokeMemberSessionsAction(userId: string) {
  const panel = await requirePanelActor();
  return call(panel, revokeMemberSessions, { userId }, (o) => (o.revoked === 1 ? "1 sessão encerrada." : `${o.revoked} sessões encerradas.`));
}

export async function logoutAction(): Promise<void> {
  // Sair vale também com a senha temporária ainda não trocada (senão a pessoa ficaria presa na troca de senha).
  await requirePanelActor({ allowPasswordChange: true });
  await destroySession();
  redirect("/admin/login");
}

// ---- pedidos ---------------------------------------------------------------------------------------------------

export async function releaseOrderAction(orderId: string) {
  const panel = await requirePanelActor();
  return call(panel, releaseOrder, { orderId }, () => "Pedido liberado. O acesso vai para o e-mail do comprador agora.");
}

export async function refundOrderAction(orderId: string) {
  const panel = await requirePanelActor();
  return call(panel, refundOrder, { orderId }, (o) => o.message);
}

export async function resendOrderAction(orderId: string, renew: boolean) {
  const panel = await requirePanelActor();
  return call(panel, resendOrder, { orderId, renew }, (o) =>
    o.queued ? `Acesso reenviado${o.revoked > 0 ? " com links novos" : ""}. O e-mail sai em instantes.` : "Já há um envio na fila para este pedido.",
  );
}

export async function ackAlertAction(id: string) {
  const panel = await requirePanelActor();
  return call(panel, ackAlert, { id });
}

// ---- ofertas ---------------------------------------------------------------------------------------------------

export async function createOfferAction(input: unknown) {
  const panel = await requirePanelActor();
  return call(panel, createOffer, input, () => "Oferta criada.");
}

export async function updateOfferAction(input: unknown) {
  const panel = await requirePanelActor();
  return call(panel, updateOffer, input, () => "Oferta salva.");
}

export async function updateOfferPriceAction(input: unknown) {
  const panel = await requirePanelActor();
  return call(panel, updateOfferPrice, input, () => "Preço salvo.");
}

export async function setOfferProductsAction(input: unknown) {
  const panel = await requirePanelActor();
  return call(panel, setOfferProducts, input, () => "Produtos da oferta salvos.");
}

export async function setOfferSlugAction(input: unknown) {
  const panel = await requirePanelActor();
  return call(panel, setOfferSlug, input, () => "Endereço salvo.");
}

export async function setOfferPixelAction(id: string, pixelId: string | null) {
  const panel = await requirePanelActor();
  return call(panel, setOfferPixel, { id, pixelId }, (o) => (o.pixelId ? "Pixel próprio salvo." : "A oferta voltou a usar o Pixel da loja."));
}

// ---- conexões e configurações ----------------------------------------------------------------------------------

export async function savePixManualAction(input: unknown) {
  const panel = await requirePanelActor();
  return call(panel, savePixManual, input, () => "Chave Pix salva.");
}

export async function saveAsaasAction(input: unknown) {
  const panel = await requirePanelActor();
  return call(panel, saveAsaas, input, (o) =>
    o.accountChanged ? "Asaas conectado. A conta mudou: as cobranças abertas da conta anterior foram descartadas." : "Asaas conectado.",
  );
}

export async function saveSmtpAction(input: unknown) {
  const panel = await requirePanelActor();
  return call(panel, saveSmtp, input, () => "SMTP testado e salvo.");
}

export async function testSmtpAction(to: string) {
  const panel = await requirePanelActor();
  return call(panel, testSmtp, { to }, () => `E-mail de teste enviado para ${to}.`);
}

export async function saveResendAction(input: unknown) {
  const panel = await requirePanelActor();
  return call(panel, saveResend, input, (o) => (o.activated ? "Resend salvo e ativado." : "Resend salvo."));
}

export async function testResendAction(to: string) {
  const panel = await requirePanelActor();
  return call(panel, testResend, { to }, () => `E-mail de teste enviado para ${to}.`);
}

export async function setEmailProviderAction(provider: "smtp" | "resend") {
  const panel = await requirePanelActor();
  return call(panel, setEmailProvider, { provider }, () => `Provedor de e-mail trocado para ${provider === "resend" ? "Resend" : "SMTP"}.`);
}

export async function saveTelegramAction(input: unknown) {
  const panel = await requirePanelActor();
  return call(panel, saveTelegram, input, () => "Telegram salvo.");
}

export async function testTelegramAction() {
  const panel = await requirePanelActor();
  return call(panel, testTelegram, {}, () => "Mensagem de teste enviada.");
}

export async function removeTelegramAction() {
  const panel = await requirePanelActor();
  return call(panel, removeTelegram, {}, () => "Telegram desconectado.");
}

export async function saveMetaAction(input: unknown) {
  const panel = await requirePanelActor();
  return call(panel, saveMeta, input, (o) => (o.hasAccessToken ? "Meta conectado: token conferido e salvo." : "Pixel salvo (sem token da API de Conversões)."));
}

export async function testMetaAction() {
  const panel = await requirePanelActor();
  return call(panel, testMeta, {}, () => "Conexão com o Meta funcionando.");
}

export async function updateSettingsAction(input: unknown) {
  const panel = await requirePanelActor();
  return call(panel, updateStoreSettings, input, () => "Configurações salvas.");
}
