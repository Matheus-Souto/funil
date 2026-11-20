// Rota de API inexistente (inclusive a rota antiga do cartão, que saiu do app): 404 sem corpo, sem ler a requisição.
import { expect, test } from "bun:test";
import * as route from "@/app/api/[...path]/route";

/** Corpo em stream que registra qualquer leitura (highWaterMark 0: nada é puxado antes de alguém ler). */
function watchedBody(text: string) {
  const pulls = { count: 0 };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        pulls.count++;
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    },
    { highWaterMark: 0 },
  );
  return { body, pulls };
}

test("o detector de leitura do corpo acusa quando alguém lê (controle positivo)", async () => {
  const { body, pulls } = watchedBody("x");
  const req = new Request("http://127.0.0.1:3000/api/x", { method: "POST", body, duplex: "half" } as RequestInit);
  expect(pulls.count).toBe(0);
  await req.text();
  expect(pulls.count).toBeGreaterThan(0);
  expect(req.bodyUsed).toBe(true);
});

test("qualquer método numa rota de /api que não existe -> 404 sem corpo, sem ler o corpo (nada do cartão é lido nem ecoado)", async () => {
  const card = JSON.stringify({ card: { number: "4444444444444444", ccv: "987" } });
  for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
    const withBody = method !== "GET" && method !== "HEAD";
    const { body, pulls } = watchedBody(card);
    const req = new Request("http://127.0.0.1:3000/api/checkout/card", {
      method,
      ...(withBody ? { body, duplex: "half", headers: { "content-type": "application/json" } } : {}),
    } as RequestInit);
    const res = await route[method](req);
    expect([method, res.status]).toEqual([method, 404]);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect([method, pulls.count, req.bodyUsed]).toEqual([method, 0, false]);
  }
});
