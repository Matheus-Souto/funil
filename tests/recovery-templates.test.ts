import { describe, expect, test } from "bun:test";
import { recoveryEmail } from "@/lib/delivery/templates";

const base = {
  storeName: "Maná Kids",
  brandColor: null,
  productName: "Maná bíblico",
  totalCents: 4790,
  actionUrl: "https://loja.exemplo.com/checkout/abc?x=1&y=2",
  unsubscribeUrl: "https://loja.exemplo.com/sair/tok-123",
};
// 2026-11-21 17:30 UTC = 14:30 em São Paulo (UTC-3).
const pixExpiresAt = new Date("2026-11-21T17:30:00Z");

const cases = [
  {
    kind: "lead" as const,
    subject: "Sua compra de Maná bíblico ficou pela metade",
    title: "Ainda dá tempo de garantir Maná bíblico",
    button: "Concluir minha compra",
    motivo: "digitou este e-mail no checkout",
  },
  {
    kind: "pix" as const,
    subject: "Seu Pix de R$ 47,90 ainda não foi pago",
    title: "Seu Pix está pronto para pagar",
    button: "Ver o Pix",
    motivo: "iniciou uma compra",
  },
  {
    kind: "card" as const,
    subject: "Sua compra de Maná bíblico não foi concluída",
    title: "O pagamento não foi concluído",
    button: "Tentar de novo",
    motivo: "iniciou uma compra",
  },
];

describe("recoveryEmail", () => {
  for (const c of cases) {
    test(`${c.kind}: assunto, título, botão, links e rodapé`, () => {
      const m = recoveryEmail(c.kind, { ...base, pixExpiresAt });
      expect(m.subject.replace(/\u00a0/g, " ")).toBe(c.subject.replace(/\u00a0/g, " "));
      expect(m.html).toContain(c.title);
      expect(m.html).toContain(`>${c.button}</a>`);
      expect(m.html).toContain('href="https://loja.exemplo.com/checkout/abc?x=1&amp;y=2"');
      expect(m.html).toContain('href="https://loja.exemplo.com/sair/tok-123"');
      expect(m.html).toContain("Não quero receber lembretes da Maná Kids");
      expect(m.html).toContain(`porque ${c.motivo} na Maná Kids. Se não foi você, ignore este e-mail.`);
      expect(m.text).toContain(c.title);
      expect(m.text).toContain(c.button);
      expect(m.text).toContain(base.actionUrl);
      expect(m.text).toContain(base.unsubscribeUrl);
      expect(m.text).toContain(`porque ${c.motivo} na Maná Kids. Se não foi você, ignore este e-mail.`);
      expect(m.text).toContain("Não quero receber lembretes da Maná Kids");
      expect(m.headers).toEqual({ "List-Unsubscribe": `<${base.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    });
  }

  test("cartão não diz que foi recusado", () => {
    const m = recoveryEmail("card", base);
    expect(m.subject + m.html + m.text).not.toContain("recusad");
    expect(m.text).toContain("nada foi cobrado");
  });

  test("pix mostra a validade em horário de São Paulo", () => {
    const m = recoveryEmail("pix", { ...base, pixExpiresAt });
    expect(m.html).toContain("O código vale até 21/11/2026 às 14:30.");
    expect(m.text).toContain("O código vale até 21/11/2026 às 14:30.");
  });

  test("nome do produto com <script> sai escapado no HTML; com quebra de linha sai numa linha no texto", () => {
    const html = recoveryEmail("lead", { ...base, productName: "<script>alert(1)</script>" });
    expect(html.html).not.toContain("<script>");
    expect(html.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    const text = recoveryEmail("lead", { ...base, productName: "Curso\nTotal pago: R$ 0,00" });
    expect(text.text).toContain("Curso Total pago: R$ 0,00");
    expect(text.text).not.toContain("Curso\nTotal");
    expect(text.subject).not.toContain("\n");
  });

  test("quebra de linha na URL de descadastro não vaza para o cabeçalho", () => {
    const m = recoveryEmail("lead", { ...base, unsubscribeUrl: "https://x.co/sair/a\r\nBcc: y@z.co" });
    expect(m.headers!["List-Unsubscribe"]).not.toMatch(/[\r\n]/);
  });
});
