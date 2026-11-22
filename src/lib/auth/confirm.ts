// Confirmação com a própria senha antes de uma ação que dá muito poder (trocar a senha, dar o papel de dono ou de
// administrador): uma sessão roubada sozinha não basta. As tentativas contam por usuário, no mesmo balde da troca de
// senha (cada uma custa um scrypt), e contam fora da transação da ação: a recusa também gasta a tentativa.
import { eq } from "drizzle-orm";
import { ActionError } from "@/lib/actions/core";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { checkRateLimit } from "@/lib/payments/ratelimit";
import { verifyPassword } from "./password";

export const MAX_PASSWORD = 256;
/** Tentativas de senha por usuário em 15 min. */
const ATTEMPTS = 5;
const WINDOW_SEC = 15 * 60;

/** Confere a senha do próprio usuário. Recusa com `rate_limited` depois de 5 tentativas em 15 min e com `forbidden` se não confere. */
export async function confirmOwnPassword(userId: string, password: string, wrong = "A sua senha não confere"): Promise<void> {
  if (!(await checkRateLimit(`account:password:${userId}`, ATTEMPTS, WINDOW_SEC))) {
    throw new ActionError("rate_limited", "Muitas tentativas. Espere 15 minutos e tente de novo.");
  }
  const [u] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u || !(await verifyPassword(password, u.passwordHash))) throw new ActionError("forbidden", wrong);
}
