"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ActionError } from "@/lib/actions/core";
import { createSession, login, MAX_EMAIL_LENGTH, MAX_PASSWORD_LENGTH, setSessionCookie } from "@/lib/auth/session";
import { resolveStore, setupFirstRun } from "@/lib/stores";

const field = (f: FormData, k: string) => (typeof f.get(k) === "string" ? (f.get(k) as string) : "");

export async function loginAction(form: FormData): Promise<void> {
  // Limites de tamanho antes de qualquer consulta ou hash.
  if (field(form, "email").length > MAX_EMAIL_LENGTH || field(form, "password").length > MAX_PASSWORD_LENGTH) {
    redirect("/admin/login?erro=credenciais");
  }
  const h = await headers();
  const found = await resolveStore(h.get("host") ?? "");
  let token: string | null = null;
  if (found) {
    try {
      token = await login({ email: field(form, "email"), password: field(form, "password"), storeId: found.id });
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
