// Rota de API inexistente (inclusive a rota antiga do cartão, que saiu do app): 404 sem corpo, sem ler a requisição.
import { expect, test } from "bun:test";
import * as route from "@/app/api/[...path]/route";

test("qualquer método numa rota de /api que não existe -> 404 sem corpo, sem ler o corpo (nada do cartão é lido nem ecoado)", async () => {
  const card = JSON.stringify({ card: { number: "4444444444444444", ccv: "987" } });
  for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
    const req = new Request("http://127.0.0.1:3000/api/checkout/card", {
      method,
      ...(method === "GET" || method === "HEAD" ? {} : { body: card, headers: { "content-type": "application/json" } }),
    });
    const res = route[method]();
    expect([method, res.status]).toEqual([method, 404]);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(req.bodyUsed).toBe(false);
  }
});
