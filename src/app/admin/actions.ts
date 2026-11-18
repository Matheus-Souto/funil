"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ActionError } from "@/lib/actions/core";
import { createSession, destroySession, login, setSessionCookie } from "@/lib/auth/session";
import { resolveStore, setupFirstRun } from "@/lib/stores";

const field = (f: FormData, k: string) => (typeof f.get(k) === "string" ? (f.get(k) as string) : "");

export async function loginAction(form: FormData): Promise<void> {
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
  let target = "/admin";
  try {
    const { storeId, userId } = await setupFirstRun({
      storeName: field(form, "storeName"),
      name: field(form, "name"),
      email: field(form, "email"),
      password: field(form, "password"),
    });
    await setSessionCookie(await createSession(userId, storeId));
  } catch (e) {
    if (!(e instanceof ActionError)) throw e;
    target = e.code === "invalid_input" ? "/admin/setup?erro=dados" : "/admin/login";
  }
  redirect(target);
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect("/admin/login");
}
