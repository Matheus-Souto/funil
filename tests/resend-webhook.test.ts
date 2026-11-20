import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runAction } from "@/lib/actions/core";
import { listAlerts } from "@/lib/alerts";
import { withStore } from "@/lib/db/client";
import { emailLog } from "@/lib/db/schema";
import { saveResend } from "@/lib/delivery/resend";
import { POST } from "@/app/api/webhooks/resend/[storeId]/route";
import { handleResendWebhook } from "@/lib/delivery/resend-webhook";
import { svixSignature, verifySvix } from "@/lib/delivery/svix";
import { getOrderDetail } from "@/lib/orders/panel";
import { createTestDb, seedStore, type TestDb } from "./db";
import { panelCall, seedOrder, seedPanelStore } from "./panel-helpers";
import { randomBytes } from "node:crypto";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const secretOf = () => `whsec_${randomBytes(24).toString("base64")}`;
const ID = "msg_abc123";
const nowSec = (offset = 0) => String(Math.floor(Date.now() / 1000) + offset);
const sign = (secret: string, id: string, ts: string, body: string) => `v1,${svixSignature(secret, id, ts, body)}`;

describe("verifySvix", () => {
  const secret = secretOf();
  const body = '{"type":"email.delivered"}';
  const ts = nowSec();
  const good = sign(secret, "m1", ts, body);
  const h = (signature = good, timestamp = ts) => ({ id: "m1", timestamp, signature });

  test("aceita a assinatura certa e a certa como segunda entrada", () => {
    expect(verifySvix(secret, h(), body)).toBe(true);
    expect(verifySvix(secret, h(`v1,${Buffer.from("outra").toString("base64")} ${good}`), body)).toBe(true);
  });
  test("recusa corpo alterado, segredo de outra loja, relógio fora de 5 min e cabeçalho sem v1,", () => {
    expect(verifySvix(secret, h(), body + " ")).toBe(false);
    expect(verifySvix(secretOf(), h(), body)).toBe(false);
    const old = nowSec(-6 * 60);
    expect(verifySvix(secret, h(sign(secret, "m1", old, body), old), body)).toBe(false);
    const future = nowSec(6 * 60);
    expect(verifySvix(secret, h(sign(secret, "m1", future, body), future), body)).toBe(false);
    expect(verifySvix(secret, h(good.slice(3)), body)).toBe(false);
    expect(verifySvix(secret, h("v1,curto"), body)).toBe(false);
    expect(verifySvix(secret, h(good, "abc"), body)).toBe(false);
  });
});

async function seedResendStore(): Promise<{ storeId: string; secret: string }> {
  const { storeId } = await seedStore();
  const secret = secretOf();
  await runAction(saveResend, panelCall(storeId), { fromEmail: "v@loja.com", apiKey: "re_chave_1234", webhookSecret: secret });
  return { storeId, secret };
}
function signed(secret: string, payload: object, over: { ts?: string } = {}): { headers: Headers; body: string } {
  const body = JSON.stringify(payload);
  const ts = over.ts ?? nowSec();
  const headers = new Headers({ "svix-id": "evt_1", "svix-timestamp": ts, "svix-signature": sign(secret, "evt_1", ts, body) });
  return { headers, body };
}
const event = (type: string, emailId = ID) => ({ type, created_at: "2026-11-20T12:00:00.000Z", data: { email_id: emailId } });
const send = (storeId: string, secret: string, type: string, emailId = ID) => {
  const { headers, body } = signed(secret, event(type, emailId));
  return handleResendWebhook(storeId, headers, body);
};
const rowsOf = (storeId: string) => withStore(storeId, (tx) => tx.select().from(emailLog));
async function seedMail(storeId: string, orderId: string | null, messageId = ID) {
  await t.ownerDb.insert(emailLog).values({ storeId, orderId, toHash: "x", kind: "delivery", status: "sent", provider: "resend", providerMessageId: messageId });
}

describe("status de entrega do Resend", () => {
  test("entregue grava delivered e a data", async () => {
    const { storeId, secret } = await seedResendStore();
    await seedMail(storeId, null);
    expect(await send(storeId, secret, "email.delivered")).toEqual({ status: 200 });
    const [r] = await rowsOf(storeId);
    expect(r!.deliveryStatus).toBe("delivered");
    expect(r!.deliveryStatusAt?.toISOString()).toBe("2026-11-20T12:00:00.000Z");
  });

  test("bounced entra em deliveryFailures (aviso do painel) e aparece no pedido", async () => {
    const p = await seedPanelStore();
    const secret = secretOf();
    await runAction(saveResend, panelCall(p.storeId), { fromEmail: "v@loja.com", apiKey: "re_chave_1234", webhookSecret: secret });
    const o = await seedOrder(p, { status: "paid" });
    await seedMail(p.storeId, o.id);
    expect((await runAction(listAlerts, panelCall(p.storeId), {})).failedDeliveries).toEqual([]);
    await send(p.storeId, secret, "email.bounced");
    expect((await runAction(listAlerts, panelCall(p.storeId), {})).failedDeliveries.map((f) => f.orderId)).toEqual([o.id]);
    const d = await runAction(getOrderDetail, panelCall(p.storeId), { id: o.id });
    expect(d.emails[0]!.deliveryStatus).toBe("bounced");
  });

  test("delivered depois de bounced mantém bounced; complained depois de delivered vira complained", async () => {
    const { storeId, secret } = await seedResendStore();
    await seedMail(storeId, null);
    await send(storeId, secret, "email.bounced");
    await send(storeId, secret, "email.delivered");
    expect((await rowsOf(storeId))[0]!.deliveryStatus).toBe("bounced");
    const b = await seedResendStore();
    await seedMail(b.storeId, null);
    await send(b.storeId, b.secret, "email.delivered");
    await send(b.storeId, b.secret, "email.complained");
    expect((await rowsOf(b.storeId))[0]!.deliveryStatus).toBe("complained");
  });

  test("mesmo evento duas vezes: mesmo resultado", async () => {
    const { storeId, secret } = await seedResendStore();
    await seedMail(storeId, null);
    await send(storeId, secret, "email.bounced");
    const first = (await rowsOf(storeId))[0]!;
    await send(storeId, secret, "email.bounced");
    expect((await rowsOf(storeId))[0]).toEqual(first);
  });

  test("email_id de outra loja não altera nada (200, updated 0)", async () => {
    const a = await seedResendStore();
    const b = await seedResendStore();
    await seedMail(b.storeId, null, "msg_da_loja_b");
    expect(await send(a.storeId, a.secret, "email.bounced", "msg_da_loja_b")).toEqual({ status: 200 });
    expect((await rowsOf(b.storeId))[0]!.deliveryStatus).toBeNull();
  });
});

describe("rota do webhook do Resend", () => {
  const call = (storeId: string, headers: Headers, body: string) =>
    POST(new Request("http://x/api/webhooks/resend/" + storeId, { method: "POST", headers, body }), { params: Promise.resolve({ storeId }) });

  test("sem cabeçalhos ou assinatura inválida -> 401; loja sem segredo -> 401", async () => {
    const { storeId, secret } = await seedResendStore();
    await seedMail(storeId, null);
    const body = JSON.stringify(event("email.bounced"));
    expect((await call(storeId, new Headers(), body)).status).toBe(401);
    const bad = signed(secretOf(), event("email.bounced"));
    expect((await call(storeId, bad.headers, bad.body)).status).toBe(401);
    const old = signed(secret, event("email.bounced"), { ts: nowSec(-6 * 60) });
    expect((await call(storeId, old.headers, old.body)).status).toBe(401);
    expect((await rowsOf(storeId))[0]!.deliveryStatus).toBeNull();
    const { storeId: bare } = await seedStore();
    const s = signed(secret, event("email.bounced"));
    expect((await call(bare, s.headers, s.body)).status).toBe(401);
    await runAction(saveResend, panelCall(bare), { fromEmail: "v@loja.com", apiKey: "re_chave_1234" });
    expect((await call(bare, s.headers, s.body)).status).toBe(401);
  });

  test("storeId inválido -> 404; corpo > 64 KB -> 413; assinatura certa grava", async () => {
    const { storeId, secret } = await seedResendStore();
    await seedMail(storeId, null);
    expect((await call("nao-e-uuid", new Headers(), "{}")).status).toBe(404);
    expect((await call(storeId, new Headers(), "x".repeat(64 * 1024 + 1))).status).toBe(413);
    const ok = signed(secret, event("email.bounced"));
    expect((await call(storeId, ok.headers, ok.body)).status).toBe(200);
    expect((await rowsOf(storeId))[0]!.deliveryStatus).toBe("bounced");
  });

  test("evento desconhecido (email.opened) e corpo inválido com assinatura válida -> 200 sem mudança", async () => {
    const { storeId, secret } = await seedResendStore();
    await seedMail(storeId, null);
    const opened = signed(secret, event("email.opened"));
    expect((await call(storeId, opened.headers, opened.body)).status).toBe(200);
    for (const type of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const proto = signed(secret, event(type));
      expect((await call(storeId, proto.headers, proto.body)).status).toBe(200);
    }
    const junk = signed(secret, { type: "email.bounced", data: {} });
    expect((await call(storeId, junk.headers, junk.body)).status).toBe(200);
    expect((await rowsOf(storeId))[0]!.deliveryStatus).toBeNull();
  });
});
