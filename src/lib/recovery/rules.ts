// Prazos, janelas e tetos da recuperação de vendas por e-mail (fixos no código), o hash do e-mail, o endereço simples e
// a chave da caixa de entrada.
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
  /**
   * Envio: o lembrete só sai até 2 h depois de enfileirado (`created_at`); depois, `skipped atrasado`. Erro temporário
   * tenta de novo só até 2 h depois de `max(due_at, created_at)`.
   */
  sendGraceMin: 120,
  /** Retenção de `recovery_email`. */
  retentionDays: 90,
  /** Venda recuperada: pedido pago da mesma oferta e do mesmo e-mail até 7 dias depois do envio. */
  attributionDays: 7,
} as const;

/** sha256 em hex do e-mail normalizado: o mesmo de `email_log.to_hash` e `checkout_lead.email_hash`. */
export const recoveryEmailHash = (email: string): string => sha256(email.trim().toLowerCase());

/**
 * Endereço simples: letras, dígitos e `._%+-` na parte local, domínio com ponto. Sem comentário `(...)`, vírgula, ponto
 * e vírgula, aspas, colchetes, `<>` nem espaço: o nodemailer entrega `"(c1)a@x.com"` ou `"x,a@x.com"` na caixa
 * `a@x.com`, e cada variante passaria como endereço novo no limite por endereço e no descadastro.
 */
const SIMPLE = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** O endereço normalizado (trim + minúsculas) se for simples; `null` se não for (a recuperação não manda para ele). */
export function simpleAddress(email: string): string | null {
  const v = email.trim().toLowerCase();
  return SIMPLE.test(v) ? v : null;
}

const GMAIL = new Set(["gmail.com", "googlemail.com"]);

/**
 * Chave canônica da caixa de entrada: parte local sem o `+sufixo`; no Gmail (`gmail.com` e `googlemail.com`), também
 * sem pontos e com o domínio `gmail.com`. `a+1@gmail.com`, `a.b@googlemail.com` e `ab@gmail.com` caem na mesma caixa.
 * Endereço não simples (pulado na varredura e no envio) fica só normalizado.
 */
export function mailboxKey(email: string): string {
  const v = simpleAddress(email);
  if (v === null) return email.trim().toLowerCase();
  const at = v.lastIndexOf("@");
  let local = v.slice(0, at).split("+")[0]!;
  let domain = v.slice(at + 1);
  if (GMAIL.has(domain)) {
    local = local.replaceAll(".", "");
    domain = "gmail.com";
  }
  return `${local}@${domain}`;
}

/** sha256 em hex da chave da caixa (`recovery_email.mailbox_hash`): limite por endereço e descadastro valem para a caixa. */
export const mailboxHash = (email: string): string => sha256(mailboxKey(email));
