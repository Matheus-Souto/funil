// E-mail do convite da equipe: textos fixos da spec (seção 5), escape no HTML, uma linha no texto e horário de SP.
import { describe, expect, test } from "bun:test";
import { teamInviteEmail } from "@/lib/delivery/templates";

// 2026-11-29 17:30 UTC = 14:30 em São Paulo (UTC-3).
const expiresAt = new Date("2026-11-29T17:30:00Z");
const link = "https://loja.exemplo.com/admin/convite/abc-123_xyz";
const base = { storeName: "Maná Kids", brandColor: null, inviterName: "Ana Souza", roleLabel: "Atendimento", acceptUrl: link, expiresAt };

describe("teamInviteEmail", () => {
  test("assunto, corpo, botão e rodapé exatos", () => {
    const m = teamInviteEmail(base);
    expect(m.subject).toBe("Ana Souza convidou você para a equipe da Maná Kids");
    const corpo = "Ana Souza convidou você para ajudar na Maná Kids como Atendimento. O convite vale até 29/11/2026 às 14:30.";
    expect(m.html).toContain(corpo);
    expect(m.text).toContain(corpo);
    expect(m.html).toContain("Aceitar convite");
    expect(m.text).toContain(`Aceitar convite: ${link}`);
    const rodape = "Se você não esperava este convite, ignore este e-mail. Ninguém entra na loja sem abrir este link.";
    expect(m.html).toContain(rodape);
    expect(m.text).toContain(rodape);
  });

  test("o href do botão é o acceptUrl (escapado)", () => {
    const m = teamInviteEmail({ ...base, acceptUrl: "https://loja.exemplo.com/admin/convite/a_b-c?x=1&y=2" });
    expect(m.html).toContain('href="https://loja.exemplo.com/admin/convite/a_b-c?x=1&amp;y=2"');
  });

  test("href do acceptUrl simples", () => {
    expect(teamInviteEmail(base).html).toContain(`<a href="${link}"`);
  });

  test("nome do convidante e da loja saem escapados no HTML", () => {
    const m = teamInviteEmail({ ...base, inviterName: "<script>alert(1)</script>", storeName: 'Loja "A" & <b>B</b>' });
    expect(m.html).not.toContain("<script>");
    expect(m.html).not.toContain("<b>B</b>");
    expect(m.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(m.html).toContain("Loja &quot;A&quot; &amp; &lt;b&gt;B&lt;/b&gt;");
  });

  test("quebra de linha no nome sai numa linha só no texto e no assunto", () => {
    const m = teamInviteEmail({ ...base, inviterName: "Ana\nTotal pago: R$ 1,00\r\nFim", storeName: "Loja\nDois" });
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.subject).toBe("Ana Total pago: R$ 1,00 Fim convidou você para a equipe da Loja Dois");
    const linhas = m.text.split("\n");
    expect(linhas).toContain("Ana Total pago: R$ 1,00 Fim convidou você para ajudar na Loja Dois como Atendimento. O convite vale até 29/11/2026 às 14:30.");
    expect(linhas.some((l) => l.startsWith("Total pago"))).toBe(false);
  });

  test("validade em horário de São Paulo (virada de dia)", () => {
    // 2026-12-01 02:10 UTC = 30/11 23:10 em São Paulo.
    const m = teamInviteEmail({ ...base, expiresAt: new Date("2026-12-01T02:10:00Z") });
    expect(m.text).toContain("O convite vale até 30/11/2026 às 23:10.");
  });

  test("sem cabeçalho de descadastro (e-mail transacional)", () => {
    expect("headers" in teamInviteEmail(base)).toBe(false);
  });
});
