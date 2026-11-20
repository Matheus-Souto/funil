// Instalação sem o serviço de cartão (sem CARD_ORIGIN): o app sobe, o cartão fica indisponível e o painel explica.
import { expect, test } from "bun:test";
import { CARD_SETUP_NOTICE, cardSetupNoticeNeeded, cardToggle } from "@/lib/payments/card-messages";

test("aviso do painel: só sem o serviço de cartão e com alguma oferta ativa que tinha cartão", () => {
  const offers = [
    { methods: ["pix"], active: true },
    { methods: ["pix", "card"], active: false },
  ];
  expect(cardSetupNoticeNeeded(false, offers)).toBe(false);
  expect(cardSetupNoticeNeeded(false, [...offers, { methods: ["card"], active: true }])).toBe(true);
  expect(cardSetupNoticeNeeded(true, [...offers, { methods: ["card"], active: true }])).toBe(false);
  expect(CARD_SETUP_NOTICE).toContain("serviço de cartão");
  expect(CARD_SETUP_NOTICE).toContain("docs/instalacao.md, seção 12");
});

test("editor de oferta: sem o serviço, o cartão não liga (desligar continua possível) e o motivo aparece", () => {
  expect(cardToggle(true, false)).toEqual({ disabled: false, notice: null });
  expect(cardToggle(true, true)).toEqual({ disabled: false, notice: null });
  expect(cardToggle(false, false)).toEqual({ disabled: true, notice: CARD_SETUP_NOTICE });
  expect(cardToggle(false, true)).toEqual({ disabled: false, notice: CARD_SETUP_NOTICE });
});
