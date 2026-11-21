// Prazos, janelas e tetos da recuperação de vendas por e-mail (fixos no código) e o hash do e-mail.
import { sha256 } from "@/lib/crypto";

export const RECOVERY = {
  /** Contato do checkout: lembrete 60 min depois da captura. */
  leadAfterMin: 60,
  /** Pix: 30 min depois de gerado... */
  pixAfterMin: 30,
  /** Cartão: 30 min depois da 1ª recusa. */
  cardAfterMin: 30,
  /** Só candidatos dos casos criados (ou recusados) nas últimas 6 h: ligar a recuperação não manda e-mail para abandonos antigos. */
  lookbackHours: 6,
  /** ...e só se faltar pelo menos 1 h para o Pix vencer. */
  pixMinLeftMin: 60,
  /** Por endereço, na loja: no máximo 1 lembrete a cada 24 h... */
  addressGapHours: 24,
  /** ...e 3 em 30 dias, contando os três casos juntos. */
  addressMaxPer30d: 3,
  /** Pula quem já comprou a mesma oferta (pago, contestado ou reembolsado) nos últimos 30 dias. */
  boughtLookbackDays: 30,
  /** Teto da loja: 60 lembretes por hora (todos os casos)... */
  storePerHour: 60,
  /** ...dentro deles, no máximo 10 do caso cartão. */
  cardPerHour: 10,
  /** Cartão: mais que isto de recusas no pedido é suspeito (teste de cartão). */
  cardMaxDeclines: 3,
  /** Cartão: mais que isto de recusas do IP do pedido na janela de suspeita é suspeito. */
  cardIpDeclinesMax: 3,
  /** Janela do disjuntor da loja e das recusas por IP. */
  cardSuspicionWindowHours: 2,
  /** Envio: erro temporário tenta de novo só até 2 h depois do horário previsto. */
  sendGraceMin: 120,
  /** Retenção de `recovery_email`. */
  retentionDays: 90,
  /** Venda recuperada: pedido pago da mesma oferta e do mesmo e-mail até 7 dias depois do envio. */
  attributionDays: 7,
} as const;

/** sha256 em hex do e-mail normalizado: o mesmo de `email_log.to_hash` e `checkout_lead.email_hash`. */
export const recoveryEmailHash = (email: string): string => sha256(email.trim().toLowerCase());
