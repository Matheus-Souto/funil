// Quando o checkout chama o servidor para guardar o contato (lógica pura, src/app/c/[slug]/lead-capture.ts).
import { describe, expect, test } from "bun:test";
import { nextLeadSend } from "@/app/c/[slug]/lead-capture";

const none = { optedOut: false, sent: { email: null, phone: null } };
const withEmail = { optedOut: false, sent: { email: "ana@exemplo.com.br", phone: null } };
const values = { email: "ana@exemplo.com.br", phone: "(11) 98765-4321" };

describe("nextLeadSend", () => {
  test("e-mail inválido → null", () => {
    expect(nextLeadSend(none, "email", { email: "ana@", phone: "" })).toBeNull();
    expect(nextLeadSend(none, "email", { email: "", phone: "" })).toBeNull();
  });

  test("e-mail válido → { email }", () => {
    expect(nextLeadSend(none, "email", { email: " Ana@Exemplo.com.br ", phone: "" })).toEqual({ email: "ana@exemplo.com.br" });
  });

  test("mesmo e-mail de novo → null", () => {
    expect(nextLeadSend(withEmail, "email", values)).toBeNull();
  });

  test("e-mail novo depois de outro → { email }", () => {
    expect(nextLeadSend(withEmail, "email", { email: "bia@exemplo.com.br", phone: "" })).toEqual({ email: "bia@exemplo.com.br" });
  });

  test("celular antes de e-mail → null", () => {
    expect(nextLeadSend(none, "phone", values)).toBeNull();
  });

  test("celular válido depois do e-mail → { phone }", () => {
    expect(nextLeadSend(withEmail, "phone", values)).toEqual({ phone: "11987654321" });
  });

  test("celular inválido ou repetido → null", () => {
    expect(nextLeadSend(withEmail, "phone", { ...values, phone: "(11) 1234" })).toBeNull();
    expect(nextLeadSend({ optedOut: false, sent: { email: "ana@exemplo.com.br", phone: "11987654321" } }, "phone", values)).toBeNull();
  });

  test("optedOut → sempre null", () => {
    const out = { optedOut: true, sent: { email: "ana@exemplo.com.br", phone: null } };
    expect(nextLeadSend(out, "email", { email: "bia@exemplo.com.br", phone: "" })).toBeNull();
    expect(nextLeadSend(out, "phone", values)).toBeNull();
    expect(nextLeadSend({ ...none, optedOut: true }, "email", values)).toBeNull();
  });
});
