// Semeadura para os testes do aviso ao app (papel dono): oferta `app`, sessão de pagamento, pedido com `app_account`,
// a conexão `app_webhook` (pelo helper de integrações, como o painel grava) e um app falso em HTTP local.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { ownerDb, withStore } from "@/lib/db/client";
import { appCheckoutSession, customer, offer, orders } from "@/lib/db/schema";
import { saveIntegration } from "@/lib/integrations";

/** Comprador fictício: os testes procuram estas strings no corpo do aviso (nenhuma pode sair). */
export const APP_BUYER = { name: "Helena Prado Teixeira", email: "helena.prado@exemplo.com", phone: "11987654321", cpf: "52998224725" } as const;

/** Oferta `app` (à vista, Pix do Asaas e cartão, sem bump nem produtos), como o check da 0038 exige. */
export async function seedAppOffer(storeId: string, appCode = "start_anual", priceCents = 49_700): Promise<{ id: string; appCode: string; priceCents: number }> {
  const [row] = await ownerDb
    .insert(offer)
    .values({
      storeId,
      slug: `app-${randomBytes(4).toString("hex")}`,
      name: "Plano Start anual",
      priceCents,
      methods: ["pix", "card"],
      pixMode: "asaas",
      maxInstallments: 1,
      delivery: "app",
      appCode,
    })
    .returning({ id: offer.id });
  return { id: row!.id, appCode, priceCents };
}

export interface SeedAppOrder {
  status?: "pending" | "paid" | "refunded" | "disputed" | "expired";
  method?: "pix_asaas" | "card_asaas";
  account?: string;
  totalCents?: number;
}

/** Pedido de app (com a sessão que o originou). Estado livre: quem testa a máquina de estados parte de `pending`. */
export async function seedAppOrder(storeId: string, offerId: string, o: SeedAppOrder = {}) {
  const account = o.account ?? `conta_${randomBytes(5).toString("hex")}`;
  const status = o.status ?? "pending";
  const total = o.totalCents ?? 49_700;
  const [c] = await ownerDb
    .insert(customer)
    .values({ storeId, email: APP_BUYER.email, name: APP_BUYER.name, phone: APP_BUYER.phone, cpf: APP_BUYER.cpf })
    .onConflictDoUpdate({ target: [customer.storeId, customer.email], set: { name: APP_BUYER.name } })
    .returning({ id: customer.id });
  const [session] = await ownerDb
    .insert(appCheckoutSession)
    .values({ storeId, offerId, account, buyerName: APP_BUYER.name, buyerEmail: APP_BUYER.email, buyerPhone: APP_BUYER.phone, expiresAt: new Date(Date.now() + 3_600_000) })
    .returning({ id: appCheckoutSession.id });
  const [row] = await ownerDb
    .insert(orders)
    .values({
      storeId,
      publicId: randomBytes(12).toString("base64url"),
      offerId,
      customerId: c!.id,
      buyerName: APP_BUYER.name,
      buyerPhone: APP_BUYER.phone,
      buyerCpf: APP_BUYER.cpf,
      status,
      method: o.method ?? "pix_asaas",
      subtotalCents: total,
      totalCents: total,
      appAccount: account,
      appSessionId: session!.id,
      paidAt: status === "paid" || status === "refunded" || status === "disputed" ? new Date() : null,
      clientIp: "127.0.0.1",
      userAgent: "bun-test",
    })
    .returning();
  await ownerDb.update(appCheckoutSession).set({ orderId: row!.id }).where(eq(appCheckoutSession.id, session!.id));
  return { ...row!, account };
}

/**
 * Transforma em pedido de app um pedido criado pelo checkout comum (os testes do Asaas criam o pedido pelas ações de
 * hoje; a criação do pedido de app pela sessão é de outra tarefa): marca a oferta como `app` e liga a sessão.
 */
export async function makeAppOrder(storeId: string, offerId: string, orderId: string, appCode = "creditos_50"): Promise<{ account: string }> {
  const account = `conta_${randomBytes(5).toString("hex")}`;
  await ownerDb.update(offer).set({ delivery: "app", appCode }).where(eq(offer.id, offerId));
  const [session] = await ownerDb
    .insert(appCheckoutSession)
    .values({ storeId, offerId, account, buyerName: APP_BUYER.name, buyerEmail: APP_BUYER.email, expiresAt: new Date(Date.now() + 3_600_000), orderId })
    .returning({ id: appCheckoutSession.id });
  await ownerDb.update(orders).set({ appAccount: account, appSessionId: session!.id }).where(eq(orders.id, orderId));
  return { account };
}

/** Conexão `app_webhook` da loja (URL pública na config, segredo selado), gravada pelo helper de integrações. */
export const connectAppWebhook = (storeId: string, url: string, secret: string) =>
  withStore(storeId, (tx) => saveIntegration(tx, storeId, "app_webhook", { url }, secret));

export interface AppHit {
  path: string;
  method: string;
  headers: IncomingHttpHeaders;
  body: string;
}
/** O que o app falso responde a cada chamada de um caminho: um status, ou `hang` (recebe e não responde). */
export type AppReply = number | "hang";

export interface FakeApp {
  /** `http://127.0.0.1:<porta>` */
  base: string;
  hits: AppHit[];
  /** Respostas do caminho, em ordem; esgotadas, 200. 3xx responde com `Location` para `/destino-do-redirect`. */
  plan(path: string, replies: AppReply[]): void;
  hitsOf(path: string): AppHit[];
  /** Chamado quando uma requisição `hang` chega (o teste dispara aqui o tempo-limite injetado). */
  onHang: (() => void) | null;
  close(): Promise<void>;
}

/** App falso: servidor HTTP em loopback que guarda o que recebeu (cabeçalhos e corpo cru). */
export async function startFakeApp(): Promise<FakeApp> {
  const hits: AppHit[] = [];
  const plans = new Map<string, AppReply[]>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "";
      hits.push({ path, method: req.method ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      const next = plans.get(path)?.shift() ?? 200;
      if (next === "hang") {
        app.onHang?.();
        return;
      }
      if (next >= 300 && next < 400) res.writeHead(next, { Location: `${app.base}/destino-do-redirect` }).end();
      else res.writeHead(next, { "Content-Type": "text/plain" }).end("resposta do app");
    });
  });
  const app: FakeApp = {
    base: "",
    hits,
    plan: (path, replies) => void plans.set(path, [...replies]),
    hitsOf: (path) => hits.filter((h) => h.path === path),
    onHang: null,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  app.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return app;
}
