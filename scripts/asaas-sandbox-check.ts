// Verificação manual contra o sandbox real do Asaas (não roda no CI): ASAAS_SANDBOX_KEY=... bun scripts/asaas-sandbox-check.ts
// Cria um cliente, uma cobrança Pix de R$ 5,00 e lê o QR Code.
import { createAsaasClient } from "@/lib/payments/asaas/client";

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
  dueDate: new Date().toISOString().slice(0, 10),
  externalReference: `sandbox-order-${Date.now()}`,
});
console.log("cobrança:", pay.id, pay.status);
const qr = await client.getPixQrCode(pay.id);
console.log("QR ok:", qr.payload.slice(0, 20) + "...", "expira:", qr.expirationDate);
