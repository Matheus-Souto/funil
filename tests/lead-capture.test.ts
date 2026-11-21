// Quando o checkout chama o servidor para guardar o contato (lógica pura, src/app/c/[slug]/lead-capture.ts).
import { describe, expect, test } from "bun:test";
import { LEAD_OPTOUT_KEY, forgetLeadInput, nextLeadSend, readLeadOptOut, writeLeadOptOut } from "@/app/c/[slug]/lead-capture";

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

describe("forgetLeadInput", () => {
  const key = "0b7c2f5e-5d0a-4c55-9b0e-2a3f4c5d6e7f";
  test("com e-mail válido digitado: manda a chave e o e-mail normalizado", () => {
    expect(forgetLeadInput(key, " Ana@Exemplo.com.br ")).toEqual({ leadKey: key, email: "ana@exemplo.com.br" });
  });
  test("e-mail vazio ou inválido: só a chave", () => {
    expect(forgetLeadInput(key, "")).toEqual({ leadKey: key });
    expect(forgetLeadInput(key, "ana@")).toEqual({ leadKey: key });
  });
});

describe("opt-out guardado no navegador", () => {
  function memory(): Storage {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
      clear: () => m.clear(),
      key: () => null,
      get length() {
        return m.size;
      },
    };
  }
  const broken = (): Storage => {
    throw new Error("SecurityError");
  };
  const failing = (): Storage => ({ ...memory(), getItem: () => { throw new Error("bloqueado"); }, setItem: () => { throw new Error("cheio"); } });

  test("sem marca: false; depois de gravar: true, na chave fixa", () => {
    const st = memory();
    expect(readLeadOptOut(() => st)).toBe(false);
    writeLeadOptOut(() => st);
    expect(readLeadOptOut(() => st)).toBe(true);
    expect(st.getItem(LEAD_OPTOUT_KEY)).not.toBeNull();
    expect(LEAD_OPTOUT_KEY).toBe("funil:lead-optout");
  });

  test("armazenamento indisponível ou que lança: lê false e grava sem erro", () => {
    expect(readLeadOptOut(broken)).toBe(false);
    expect(() => writeLeadOptOut(broken)).not.toThrow();
    expect(readLeadOptOut(failing)).toBe(false);
    expect(() => writeLeadOptOut(failing)).not.toThrow();
  });
});
