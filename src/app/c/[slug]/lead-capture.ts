// Captura do contato no checkout (abandono antes de comprar): decide, puro e sem rede, o que mandar ao servidor quando
// a pessoa sai de um campo. Só vão valores válidos e diferentes do último enviado; o celular só depois de um e-mail
// enviado (o servidor não cria contato só com celular); depois de "Não salvar meus dados" nada mais é enviado.
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
    return email === state.sent.email ? null : { email };
  }
  if (state.sent.email === null) return null;
  const phone = normalizeBrMobile(values.phone);
  return phone === null || phone === state.sent.phone ? null : { phone };
}
