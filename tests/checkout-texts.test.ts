// Textos do checkout que dependem da loja (CPF ou CNPJ) e da entrega (PDF ou app): src/app/c/[slug]/texts.ts.
import { describe, expect, test } from "bun:test";
import { APP_ACCESS_TEXT, docLabel, emailHint, needsDocMessage, pixConfirmedText, productSubtitle } from "@/app/c/[slug]/texts";

describe("textos do checkout", () => {
  test("Pix manual indisponível: o aviso usa o mesmo rótulo do campo (CPF ou CPF ou CNPJ)", () => {
    expect(docLabel(false)).toBe("CPF");
    expect(docLabel(true)).toBe("CPF ou CNPJ");
    expect(needsDocMessage(false)).toBe("O Pix direto da loja está indisponível agora. Informe o CPF para gerar o Pix automático.");
    expect(needsDocMessage(true)).toBe("O Pix direto da loja está indisponível agora. Informe o CPF ou CNPJ para gerar o Pix automático.");
  });

  test("oferta de app não promete arquivo nem acesso por e-mail; a de download continua como antes", () => {
    const app = { delivery: "app" as const, includes: null, productName: "Plano Start anual" };
    for (const t of [productSubtitle(app), pixConfirmedText("app")]) {
      expect(t).toBe(APP_ACCESS_TEXT);
      expect(t).not.toMatch(/PDF|e-mail|baixar/i);
    }
    expect(emailHint("app")).toBeUndefined();
    expect(productSubtitle({ delivery: "download", includes: null, productName: "Guia" })).toBe("Guia · PDF para baixar");
    expect(productSubtitle({ delivery: "download", includes: "Inclui: A · B", productName: "Combo" })).toBe("Inclui: A · B");
    expect(emailHint("download")).toBe("É para este e-mail que enviamos o seu acesso.");
    expect(pixConfirmedText("download")).toBe("Assim que o banco confirmar, o acesso chega no seu e-mail.");
  });
});
