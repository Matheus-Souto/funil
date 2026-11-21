// Captura do contato no checkout (abandono antes de comprar): decide, puro e sem rede, o que mandar ao servidor quando
// a pessoa sai de um campo. Só vão valores válidos e diferentes do último enviado; o celular só depois de um e-mail
// enviado (o servidor não cria contato só com celular) ou junto com ele, se já estava digitado; depois de "Não salvar meus dados" nada mais é enviado. Também
// monta a entrada do "Não salvar" e guarda essa escolha no navegador (localStorage, sempre em try/catch).
import { normalizeBrMobile, validEmail } from "@/lib/validation/br";

export interface LeadSendState {
  optedOut: boolean;
  sent: { email: string | null; phone: string | null };
}

export function nextLeadSend(
  state: LeadSendState,
  field: "email" | "phone",
  values: { email: string; phone: string },
): { email?: string; phone?: string } | null {
  if (state.optedOut) return null;
  if (field === "email") {
    if (!validEmail(values.email)) return null;
    const email = values.email.trim().toLowerCase();
    if (email === state.sent.email) return null;
    // Celular válido já digitado (antes do e-mail) e ainda não enviado vai junto: sem isso, só iria no próximo blur dele.
    const phone = normalizeBrMobile(values.phone);
    return phone !== null && phone !== state.sent.phone ? { email, phone } : { email };
  }
  if (state.sent.email === null) return null;
  const phone = normalizeBrMobile(values.phone);
  return phone === null || phone === state.sent.phone ? null : { phone };
}

/** Entrada do "Não salvar meus dados": a chave desta visita e, se o e-mail digitado for válido, ele normalizado. */
export function forgetLeadInput(leadKey: string, emailValue: string): { leadKey: string; email?: string } {
  return validEmail(emailValue) ? { leadKey, email: emailValue.trim().toLowerCase() } : { leadKey };
}

/**
 * "Não salvar meus dados" vale para este navegador: a marca fica no `localStorage` (origem da loja, chave fixa). Toda
 * leitura e escrita em try/catch (modo privado, armazenamento bloqueado ou cheio): sem marca, a página segue normal.
 */
export const LEAD_OPTOUT_KEY = "funil:lead-optout";

const browserStorage = (): Storage => window.localStorage;

export function readLeadOptOut(storage: () => Storage = browserStorage): boolean {
  try {
    return storage().getItem(LEAD_OPTOUT_KEY) !== null;
  } catch {
    return false;
  }
}

export function writeLeadOptOut(storage: () => Storage = browserStorage): void {
  try {
    storage().setItem(LEAD_OPTOUT_KEY, "1");
  } catch {
    /* sem armazenamento: vale só para esta página */
  }
}
