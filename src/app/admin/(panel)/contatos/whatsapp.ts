// Link do WhatsApp a partir do celular guardado. Só os dígitos entram na URL (nenhum outro texto do visitante).
import { onlyDigits } from "@/lib/validation/br";

/** 10–11 dígitos: DDD + número, ganha o 55; 12–13 dígitos já com o 55 ficam como estão; o resto não vira link. */
export function whatsappUrl(phone: string | null): string | null {
  if (!phone) return null;
  const d = onlyDigits(phone);
  if (d.length === 10 || d.length === 11) return `https://wa.me/55${d}`;
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) return `https://wa.me/${d}`;
  return null;
}
