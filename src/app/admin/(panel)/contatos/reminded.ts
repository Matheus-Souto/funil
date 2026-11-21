// Marca do lembrete de recuperação na linha de Contatos, com o formato de data da página (`shortWhenSP`).
import { shortWhenSP } from "@/lib/format";

/** "Lembrete enviado hoje, 14:30" / "… ontem, 14:30" / "… em 18/11, 14:30": nunca "em hoje". */
export function remindedLabel(at: Date, now: Date = new Date()): string {
  const when = shortWhenSP(at, now);
  return /^(hoje|ontem),/.test(when) ? `Lembrete enviado ${when}` : `Lembrete enviado em ${when}`;
}
