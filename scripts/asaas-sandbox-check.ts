// Verificação manual contra o sandbox real do Asaas (não roda no CI): ASAAS_SANDBOX_KEY=... bun scripts/asaas-sandbox-check.ts
// Cria um cliente, uma cobrança Pix de R$ 5,00 e lê o QR Code; depois cartão de teste aprovado (4444...) e recusado
// (5184019740373151), à vista e parcelado em 2x (installmentCount + totalValue).
import { ActionError } from "@/lib/actions/core";
import { asaasAccountKey, asaasDueDate, createAsaasClient } from "@/lib/payments/asaas/client";

const apiKey = process.env.ASAAS_SANDBOX_KEY;
if (!apiKey) {
  console.error("Defina ASAAS_SANDBOX_KEY (chave do sandbox do Asaas).");
  process.exit(1);
}

// CPF válido gerado na hora (cada execução cria um cliente novo).
function cpf(): string {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  for (const n of [9, 10]) {
    const sum = d.reduce((acc, v, i) => acc + v * (n + 1 - i), 0);
    d.push(((sum * 10) % 11) % 10);
  }
  return d.join("");
}

const client = createAsaasClient({ apiKey, env: "sandbox" });
const { balance } = await client.getBalance();
console.log("saldo:", balance);
// Identificação da conta usada por connections.saveAsaas (GET /wallets/).
console.log("conta:", await asaasAccountKey(client, "sandbox", apiKey));
const customer = await client.createCustomer({
  name: "Cliente Teste",
  email: `teste+${Date.now()}@example.com`,
  cpfCnpj: cpf(),
  mobilePhone: "11999999999",
  externalReference: `sandbox-${Date.now()}`,
});
console.log("cliente:", customer.id);
const pay = await client.createPayment({
  customer: customer.id,
  billingType: "PIX",
  value: 5,
  dueDate: asaasDueDate(new Date(), 1),
  externalReference: `sandbox-order-${Date.now()}`,
});
console.log("cobrança:", pay.id, pay.status);
const qr = await client.getPixQrCode(pay.id);
console.log("QR ok:", qr.payload.slice(0, 20) + "...", "expira:", qr.expirationDate);

const holderInfo = {
  name: "Cliente Teste",
  email: "teste@example.com",
  cpfCnpj: cpf(),
  postalCode: "01310100",
  addressNumber: "100",
  phone: "11999999999",
  mobilePhone: "11999999999",
};
const card = (number: string) => ({ holderName: "Cliente Teste", number, expiryMonth: "12", expiryYear: "2034", ccv: "123" });
const base = { customer: customer.id, billingType: "CREDIT_CARD" as const, dueDate: asaasDueDate(), creditCardHolderInfo: holderInfo, remoteIp: "203.0.113.10" };

const ok = await client.createPayment({ ...base, value: 5, externalReference: `sandbox-card-${Date.now()}`, creditCard: card("4444444444444444") }, { timeoutMs: 60_000 });
console.log("cartão aprovado:", ok.id, ok.status);
const parc = await client.createPayment(
  { ...base, installmentCount: 2, totalValue: 10, externalReference: `sandbox-card2-${Date.now()}`, creditCard: card("4444444444444444") },
  { timeoutMs: 60_000 },
);
console.log("cartão parcelado:", parc.id, parc.status, "parcelamento:", parc.installment, "valor da parcela:", parc.value);
if (typeof parc.installment === "string") console.log("parcelamento total:", (await client.getInstallment(parc.installment)).value);
try {
  await client.createPayment({ ...base, value: 5, externalReference: `sandbox-card3-${Date.now()}`, creditCard: card("5184019740373151") }, { timeoutMs: 60_000 });
  console.log("ERRO: cartão de recusa foi aprovado");
} catch (e) {
  // Só status e códigos: nunca a descrição (pode ecoar o cartão).
  console.log("cartão recusado:", e instanceof ActionError ? e.details : "erro inesperado");
}
