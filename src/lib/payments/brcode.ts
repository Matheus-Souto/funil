// BR Code estático do Pix (EMV MPM), conforme o "Manual de Padrões para Iniciação do Pix" do Banco Central.
// Implementação própria; só TLV + CRC16/CCITT-FALSE.

export type PixBrCodeInput = { key: string; name: string; city: string; amountCents: number; txid: string };

function tlv(id: string, value: string): string {
  return `${id}${String(value.length).padStart(2, "0")}${value}`;
}

/** CRC16/CCITT-FALSE: poly 0x1021, init 0xFFFF, sem reflexão, sem xorout; hex maiúsculo de 4 dígitos. */
export function crc16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= (payload.charCodeAt(i) & 0xff) << 8;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** Remove acentos e tudo fora do ASCII imprimível, apara e limita; vazio vira `fallback`. */
export function sanitizeText(value: string, max: number, fallback: string): string {
  const s = value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7e]/g, "")
    .trim()
    .slice(0, max)
    .trim();
  return s === "" ? fallback : s;
}

/** Máximo de caracteres da chave: o campo 26 (≤ 99) já gasta 18 com o GUI e 4 com o cabeçalho da chave. */
export const PIX_KEY_MAX = 77;

export function buildPixBrCode(input: PixBrCodeInput): string {
  const { key, amountCents } = input;
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 99_999_999_999) throw new Error("valor inválido");
  if (key.length === 0 || key.length > PIX_KEY_MAX || !/^[\x20-\x7e]+$/.test(key)) throw new Error("chave Pix inválida");
  const name = sanitizeText(input.name, 25, "LOJA");
  const city = sanitizeText(input.city, 15, "BRASIL");
  const txid = input.txid.replace(/[^A-Za-z0-9]/g, "").slice(0, 25) || "***";
  const amount = `${Math.floor(amountCents / 100)}.${String(amountCents % 100).padStart(2, "0")}`;

  const body =
    tlv("00", "01") +
    tlv("26", tlv("00", "br.gov.bcb.pix") + tlv("01", key)) +
    tlv("52", "0000") +
    tlv("53", "986") +
    tlv("54", amount) +
    tlv("58", "BR") +
    tlv("59", name) +
    tlv("60", city) +
    tlv("62", tlv("05", txid)) +
    "6304";
  return body + crc16(body);
}
