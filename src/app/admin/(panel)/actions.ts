"use server";

// Server actions do painel. TODAS começam por requirePanelActor() (o layout não protege ações: elas são endpoints POST)
// e só chamam runAction com o ator da sessão. Nenhuma regra de negócio aqui.
import { redirect } from "next/navigation";
import { ActionError, runAction, type Action } from "@/lib/actions/core";
import { ackAlert } from "@/lib/alerts";
import { rotateAppWebhookSecret, saveAppWebhook, testAppWebhook } from "@/lib/apps/connection";
import { resendAppNotice } from "@/lib/apps/webhook";
import { changePassword, revokeMemberSessions } from "@/lib/auth/account";
import { PASSWORD_REFUSALS } from "@/lib/auth/confirm";
import { destroySession, renewSessionCookie, requirePanelActor, type PanelActor } from "@/lib/auth/session";
import { archiveCoupon, createCoupon, updateCoupon } from "@/lib/coupons/actions";
import { createOffer, setOfferPixel, setOfferProducts, setOfferSlug, updateOffer, updateOfferPrice } from "@/lib/catalog/offers";
import { saveSmtp, testSmtp } from "@/lib/delivery/mailer";
import { deleteLead, forgetLeadEmail, markLeadContacted } from "@/lib/leads/panel";
import { approveRequest, rejectRequest } from "@/lib/mcp/approvals";
import { createMcpToken, revokeMcpToken } from "@/lib/mcp/tokens";
import { removeTelegram, saveTelegram, testTelegram } from "@/lib/notify/telegram-connection";
import { saveResend, setEmailProvider, testResend } from "@/lib/delivery/resend";
import { resendOrder } from "@/lib/delivery/jobs";
import { saveAsaas } from "@/lib/payments/asaas/pix";
import { releaseOrder, savePixManual } from "@/lib/payments/manual";
import { refundOrder } from "@/lib/payments/refund";
import { updateStoreSettings } from "@/lib/store-settings";
import { inviteMember, inviteStatus, resendInvite, revokeInvite } from "@/lib/team/invites";
import { changeRole, leaveStore, removeMember } from "@/lib/team/members";
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
  // A senha errada (ou que faltou) ao dar um papel é uma recusa `forbidden` que não fala do papel: vai como veio.
  if (e.code === "forbidden") return PASSWORD_REFUSALS.has(e.message) ? `${e.message}.` : "Seu papel na loja não permite esta ação.";
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
    if (e instanceof ActionError) {
      const field = fieldOf(e);
      return { ok: false, error: describe(e), code: e.code, ...(field ? { field } : {}) };
    }
    throw e;
  }
}

/** Caminho do primeiro campo recusado (só nomes de campo do schema; nunca o valor digitado). */
function fieldOf(e: ActionError): string | undefined {
  if (e.code !== "invalid_input" || !Array.isArray(e.details)) return undefined;
  const path = (e.details[0] as { path?: unknown[] } | undefined)?.path;
  if (!Array.isArray(path) || path.length === 0) return undefined;
  return path.every((k) => typeof k === "string" || typeof k === "number") ? path.join(".") : undefined;
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

// ---- página Equipe: convites, papéis e saída (spec "Equipe e convites", seções 5 e 7) ------------------------------

/**
 * O e-mail sai no `afterCommit`, que já terminou quando `runAction` volta: o resultado do envio vem de `team.inviteStatus`.
 * O convite já existe nesse ponto: uma recusa dessa leitura vira "não enviado" com o motivo padrão, nunca um erro 500.
 */
async function sendResult(panel: PanelActor, inviteId: string): Promise<{ sent: boolean; reason?: string }> {
  try {
    const st = await runAction(inviteStatus, { storeId: panel.storeId, actor: panel.actor, origin: "panel" }, { inviteId });
    return st.sendStatus === "sent" ? { sent: true } : { sent: false, reason: st.sendError ?? NO_REASON };
  } catch (e) {
    if (!(e instanceof ActionError)) throw e;
    return { sent: false, reason: NO_REASON };
  }
}

const NO_REASON = "o provedor não respondeu";

/**
 * Convida por e-mail. A resposta traz só se o e-mail saiu e o motivo curto da falha: nem o e-mail do convidado, nem o
 * token, nem o link (a tela monta a mensagem com o e-mail que já está no formulário).
 */
export async function inviteAction(input: { email: string; role: string; password?: string }) {
  const panel = await requirePanelActor();
  const r = await call(panel, inviteMember, input);
  if (!r.ok) return r;
  return { ok: true as const, data: await sendResult(panel, r.data.inviteId) };
}

export async function resendInviteAction(inviteId: string) {
  const panel = await requirePanelActor();
  const r = await call(panel, resendInvite, { inviteId });
  if (!r.ok) return r;
  return { ok: true as const, data: await sendResult(panel, inviteId) };
}

export async function revokeInviteAction(inviteId: string) {
  const panel = await requirePanelActor();
  return call(panel, revokeInvite, { inviteId }, () => "Convite revogado. O link deixou de valer.");
}

const tokensText = (n: number) => (n === 0 ? "" : n === 1 ? " 1 token MCP revogado." : ` ${n} tokens MCP revogados.`);

/** `password`: a senha de quem troca, obrigatória para promover a Dono ou Administrador (`needsPassword`). */
export async function changeRoleAction(userId: string, role: string, password?: string) {
  const panel = await requirePanelActor();
  const r = await call(panel, changeRole, { userId, role, ...(password === undefined ? {} : { password }) }, (o) => `Papel trocado.${tokensText(o.tokensRevoked)}`);
  // Deixar de ser dono: a página Equipe deixa de existir para esta pessoa (404 no refresh); vai para o início do painel.
  if (r.ok && userId === panel.actor.userId && role !== "owner") redirect("/admin");
  return r;
}

export async function removeMemberAction(userId: string) {
  const panel = await requirePanelActor();
  return call(panel, removeMember, { userId }, (o) => `Pessoa removida da equipe.${tokensText(o.tokensRevoked)}`);
}

/** Sair da loja: a ação apaga o vínculo e as sessões desta loja; aqui só o cookie e a ida para o login. */
export async function leaveStoreAction() {
  const panel = await requirePanelActor();
  const r = await call(panel, leaveStore, {});
  if (!r.ok) return r;
  await destroySession();
  redirect("/admin/login");
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

export async function resendAppNoticeAction(orderId: string) {
  const panel = await requirePanelActor();
  return call(panel, resendAppNotice, { orderId }, (o) =>
    o.queued ? "Aviso reenviado. O app recebe em instantes, com o mesmo identificador." : "Já há um envio em andamento para este aviso.",
  );
}

export async function ackAlertAction(id: string) {
  const panel = await requirePanelActor();
  return call(panel, ackAlert, { id });
}

// ---- cupons (aba Cupons de Ofertas) ----------------------------------------------------------------------------

export async function createCouponAction(input: unknown) {
  const panel = await requirePanelActor();
  return call(panel, createCoupon, input, () => "Cupom criado.");
}

export async function updateCouponAction(input: unknown) {
  const panel = await requirePanelActor();
  return call(panel, updateCoupon, input, () => "Cupom salvo.");
}

export async function archiveCouponAction(id: string) {
  const panel = await requirePanelActor();
  return call(panel, archiveCoupon, { id }, () => "Cupom arquivado.");
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

// ---- app (integração): webhook, segredo e chaves da API. O segredo e a chave voltam só no `data`, uma vez, para o
// cartão mostrar e esquecer; nunca na mensagem (que vai para a região aria-live). ---------------------------------

export async function saveAppWebhookAction(input: unknown) {
  const panel = await requirePanelActor();
  return call(panel, saveAppWebhook, input, (o) => (o.secret ? "Webhook do app salvo e segredo gerado." : "Webhook do app salvo."));
}

export async function rotateAppWebhookSecretAction() {
  const panel = await requirePanelActor();
  return call(panel, rotateAppWebhookSecret, {}, () => "Segredo novo gerado. O anterior parou de valer.");
}

export async function testAppWebhookAction() {
  const panel = await requirePanelActor();
  return call(panel, testAppWebhook, {}, (o) => `O app recebeu o teste (HTTP ${o.httpStatus}).`);
}

/** Chave da API de integração = token da loja com o papel `integration` (a mesma ação dos tokens MCP). */
export async function createIntegrationKeyAction(name: string) {
  const panel = await requirePanelActor();
  return call(panel, createMcpToken, { name, role: "integration" }, () => "Chave criada.");
}

export async function revokeIntegrationKeyAction(id: string) {
  const panel = await requirePanelActor();
  return call(panel, revokeMcpToken, { id, onlyRole: "integration" }, () => "Chave revogada. O app deixou de acessar a API.");
}

export async function updateSettingsAction(input: unknown) {
  const panel = await requirePanelActor();
  return call(panel, updateStoreSettings, input, () => "Configurações salvas.");
}

// ---- agentes de IA (tokens MCP) --------------------------------------------------------------------------------

/** O retorno traz o token uma única vez: quem chama o guarda só em estado de componente. */
export async function createMcpTokenAction(input: unknown) {
  const panel = await requirePanelActor();
  return call(panel, createMcpToken, input, () => "Token criado.");
}

export async function revokeMcpTokenAction(id: string) {
  const panel = await requirePanelActor();
  return call(panel, revokeMcpToken, { id }, () => "Token revogado.");
}

// ---- aprovações (fila do MCP) ----------------------------------------------------------------------------------

export async function approveRequestAction(id: string) {
  const panel = await requirePanelActor();
  return call(panel, approveRequest, { id }, () => "Pedido aprovado e executado.");
}

export async function rejectRequestAction(id: string) {
  const panel = await requirePanelActor();
  return call(panel, rejectRequest, { id }, () => "Pedido recusado.");
}

// ---- contatos de quem não finalizou a compra (a auditoria grava só o id ou o hash do e-mail) -----------------------

export async function markLeadContactedAction(id: string) {
  const panel = await requirePanelActor();
  return call(panel, markLeadContacted, { id }, () => "Marcado como contatado.");
}

export async function deleteLeadAction(id: string) {
  const panel = await requirePanelActor();
  return call(panel, deleteLead, { id }, () => "Contato excluído.");
}

/** Pedido de exclusão do titular. O e-mail vai no corpo do POST da server action, nunca na URL. */
export async function forgetLeadEmailAction(email: string) {
  const panel = await requirePanelActor();
  return call(panel, forgetLeadEmail, { email }, (o) => `${o.deleted} contato(s) excluído(s).`);
}
