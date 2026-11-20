// Detector de dados de cartão do E2E e do smoke de deploy (e2e/card-leaks.ts): acha os quatro itens no corpo que vai ao
// serviço de cartão e não acusa números soltos que coincidem por acaso (ex.: content-length igual ao CVV).
import { expect, test } from "bun:test";
import { cardLeaks, headersText } from "../e2e/card-leaks";

const card = { number: "4111 1111 1111 1111", holder: "MARIA A SOUZA", expiry: "09/31", cvv: "582" };
const leaks = cardLeaks(card);

test("controle positivo: o corpo do POST ao serviço de cartão tem os quatro itens", () => {
  const body = JSON.stringify({
    ticket: "t",
    card: { holderName: "MARIA A SOUZA", number: "4111111111111111", expiryMonth: "09", expiryYear: "31", ccv: "582" },
  });
  expect(leaks(body)).toEqual(["CVV", "nome impresso", "número", "validade"]);
});

test("cada item sozinho é achado", () => {
  expect(leaks("cardNumber=4111%201111%201111%201111")).toEqual(["número"]);
  expect(leaks('{"cvv":"0"}')).toEqual(["CVV"]);
  expect(leaks("x 582 y")).toEqual(["CVV"]);
  expect(leaks("validade 09%2F31")).toEqual(["validade"]);
  expect(leaks("ano 2031")).toEqual(["validade"]);
  expect(leaks("Maria a Souza")).toEqual(["nome impresso"]);
});

test("content-length igual ao CVV ou ao ano não acusa; outro cabeçalho com o CVV acusa", () => {
  for (const len of ["582", "2031"]) {
    const h = { "content-length": len, "content-type": "text/plain;charset=UTF-8", accept: "*/*" };
    expect(leaks(JSON.stringify(h)).length).toBeGreaterThan(0); // sem o filtro, falso positivo
    expect(leaks(headersText(h))).toEqual([]);
    expect(leaks(headersText({ "Content-Length": len }))).toEqual([]);
  }
  expect(leaks(headersText({ "content-length": "10", "x-card-cvv": "582" }))).toEqual(["CVV"]);
});

test("números que só contêm o CVV ou o ano dentro de outro número não acusam", () => {
  expect(leaks('{"id":"a5821b","port":"41582","n":"20311"}')).toEqual([]);
});
