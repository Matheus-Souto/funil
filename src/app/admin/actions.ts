"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ActionError, runAction } from "@/lib/actions/core";
import { createSession, destroySession, login, loginOnPanelHost, MAX_EMAIL_LENGTH, MAX_PASSWORD_LENGTH, setSessionCookie } from "@/lib/auth/session";
import { clientIpFrom } from "@/lib/client-ip";
import { env } from "@/lib/env";
import { isPanelHost, resolveStore, setupFirstRun } from "@/lib/stores";
import { acceptInvite } from "@/lib/team/accept";

const field = (f: FormData, k: string) => (typeof f.get(k) === "string" ? (f.get(k) as string) : "");

export async function loginAction(form: FormData): Promise<void> {
  // Limites de tamanho antes de qualquer consulta ou hash.
  if (field(form, "email").length > MAX_EMAIL_LENGTH || field(form, "password").length > MAX_PASSWORD_LENGTH) {
    redirect("/admin/login?erro=credenciais");
  }
  const h = await headers();
  const host = h.get("host") ?? "";
  const found = await resolveStore(host);
  const credentials = { email: field(form, "email"), password: field(form, "password") };
  let token: string | null = null;
  // Host de loja: entra nela. Host do painel da plataforma (MODE=multi, BASE_URL que não é loja): entra numa loja da
  // pessoa. Qualquer outro host: erro genérico, sem consulta.
  if (found || isPanelHost(host)) {
    try {
      token = found ? await login({ ...credentials, storeId: found.id }) : await loginOnPanelHost(credentials);
    } catch (e) {
      if (!(e instanceof ActionError)) throw e;
    }
  }
  if (!token) redirect("/admin/login?erro=credenciais");
  await setSessionCookie(token);
  redirect("/admin");
}

export async function setupAction(form: FormData): Promise<void> {
  if (
    field(form, "email").length > MAX_EMAIL_LENGTH ||
    field(form, "password").length > MAX_PASSWORD_LENGTH ||
    field(form, "name").length > 100 ||
    field(form, "storeName").length > 100 ||
    field(form, "setupToken").length > 200
  ) {
    redirect("/admin/setup?erro=dados");
  }
  let target = "/admin";
  try {
    const { storeId, userId } = await setupFirstRun({
      storeName: field(form, "storeName"),
      name: field(form, "name"),
      email: field(form, "email"),
      password: field(form, "password"),
      setupToken: field(form, "setupToken"),
    });
    await setSessionCookie(await createSession(userId, storeId));
  } catch (e) {
    if (!(e instanceof ActionError)) throw e;
    target = e.code === "invalid_input" ? "/admin/setup?erro=dados" : e.code === "forbidden" ? "/admin/setup?erro=codigo" : "/admin/login";
  }
  redirect(target);
}

/**
 * Estado do formulário de aceite do convite (`useActionState`): os erros voltam para a própria página, sem ir para a URL
 * (nome e senha nunca aparecem no endereço). `gone`: o convite não vale mais; `hasAccount`: o e-mail já tem conta, e a
 * página passa ao formulário de senha.
 */
export type AcceptState = { error?: string; gone?: boolean; hasAccount?: boolean; name?: string } | null;

const ACCEPT_ERROR: Record<string, string> = {
  forbidden: "Senha incorreta. Depois de 5 tentativas erradas, o acesso fica bloqueado por 15 minutos.",
  rate_limited: "Muitas tentativas. Espere alguns minutos e tente de novo.",
  invalid_input: "Confira os dados: nome de 1 a 100 caracteres e senha de 10 a 256.",
};
const ACCEPT_FAILED = "Não foi possível aceitar o convite agora. Tente de novo em alguns minutos.";

/**
 * POST da página /admin/convite/<token>. A regra fica toda em `team.acceptInvite`; aqui só a sessão, como no login: a
 * sessão anterior deste navegador (de quem quer que seja) é apagada e a nova pertence a quem aceitou.
 */
export async function acceptInviteAction(_prev: AcceptState, form: FormData): Promise<AcceptState> {
  const token = field(form, "token");
  const mode = field(form, "mode") === "existing" ? "existing" : "new";
  const password = field(form, "password");
  const name = field(form, "name");
  // Limites de tamanho antes de qualquer consulta ou hash.
  // O nome volta para o formulário depois de um erro (as senhas, nunca).
  const keep = mode === "new" && name.length <= 100 ? { name } : {};
  if (token.length > 200 || password.length > MAX_PASSWORD_LENGTH || name.length > 100) return { error: ACCEPT_ERROR.invalid_input, ...keep };
  if (mode === "new" && password !== field(form, "confirmPassword")) return { error: "As senhas não conferem.", ...keep };
  const h = await headers();
  const found = await resolveStore(h.get("host") ?? "");
  if (!found) return { gone: true };
  let out: { userId: string; storeId: string };
  try {
    out = await runAction(
      acceptInvite,
      { storeId: found.id, actor: { kind: "public" }, origin: "public", server: { ip: clientIpFrom(h, env.TRUST_PROXY) } },
      mode === "new" ? { token, mode, name, password } : { token, mode, password },
    );
  } catch (e) {
    if (!(e instanceof ActionError)) throw e;
    if (e.code === "not_found") return { gone: true };
    if (e.code === "conflict" && (e.details as { hasAccount?: boolean } | undefined)?.hasAccount) {
      return { hasAccount: true, error: "Você já tem conta na plataforma. Entre com a sua senha para aceitar." };
    }
    return { error: ACCEPT_ERROR[e.code] ?? ACCEPT_FAILED, ...(mode === "existing" ? { hasAccount: true } : keep) };
  }
  await destroySession();
  await setSessionCookie(await createSession(out.userId, out.storeId));
  redirect("/admin");
}
