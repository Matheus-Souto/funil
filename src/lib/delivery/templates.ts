// Modelos de e-mail (frame 10 do canvas Doop hU-l3k30Xu). HTML simples em tabelas com estilo inline (sem CSS nem
// fontes externas, sem imagens remotas) e sempre com alternativa em texto. Todo valor dinâmico passa por `esc`.
import { brandVars } from "@/lib/brand";
import { brl, dateTimeSP } from "@/lib/format";

export function esc(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Uma linha só: controles (inclusive \r, \n e tab), NEL e os separadores de linha/parágrafo do Unicode viram um espaço.
 * Todo valor dinâmico da parte texto passa por aqui: um nome com quebra de linha não forja linhas (ex.: um falso
 * "Total pago").
 */
export function oneLine(v: string): string {
  return v.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, " ");
}

/** Cabeçalhos de descadastro em um clique (RFC 8058). */
// `type` (não `interface`): precisa ser atribuível ao índice de strings dos cabeçalhos do nodemailer.
export type MailHeaders = {
  "List-Unsubscribe": string;
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click";
};

/** Nem SMTP nem Resend aceitam quebra de linha em cabeçalho: os valores passam por `oneLine` antes de sair. */
export function cleanHeaders(h: MailHeaders): MailHeaders {
  return { "List-Unsubscribe": oneLine(h["List-Unsubscribe"]).trim(), "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

const C = { bg: "#EEF0EC", surface: "#FFFFFF", soft: "#F5F6F3", border: "#DDE1DB", text: "#15201B", muted: "#56615B" };
const FONT = "Helvetica,Arial,sans-serif";

const dateSP = (d: Date) => dateTimeSP(d).split(" às ")[0]!;
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";

function layout(o: { title: string; storeName: string; brand: string; body: string; footer: string }): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.title)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:${FONT};color:${C.text};line-height:1.5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg}"><tr><td align="center" style="padding:28px 12px 32px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;background:${C.surface};border:1px solid ${C.border};border-radius:16px">
<tr><td style="padding:22px 32px;border-bottom:1px solid ${C.border};font-size:20px;font-weight:700;color:${o.brand};letter-spacing:-0.02em">${esc(o.storeName)}</td></tr>
${o.body}
</table>
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px"><tr><td align="center" style="padding:18px 8px 0;font-size:12px;color:${C.muted};line-height:1.6">${o.footer}<p style="margin:6px 0 0">Enviado pelo Funil</p></td></tr></table>
</td></tr></table>
</body></html>`;
}

function button(href: string, label: string, bg: string, fg: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:10px;background:${bg}"><a href="${esc(href)}" style="display:inline-block;padding:12px 20px;font-family:${FONT};font-size:15px;font-weight:700;color:${fg};text-decoration:none;border-radius:10px;white-space:nowrap">${esc(label)}</a></td></tr></table>`;
}

export interface DeliveryEmailData {
  storeName: string;
  brandColor: string | null;
  buyerName: string;
  orderCode: string;
  paidAt: Date;
  method: string;
  totalCents: number;
  /** Nome da oferta: vai no assunto quando o pedido tem mais de um produto principal. */
  offerName: string;
  /** Na ordem da oferta. Sem preço por item: o comprador só vê o total (o rateio é interno). */
  items: Array<{ name: string; kind: "main" | "bump"; url: string }>;
  maxDownloads: number;
  ttlDays: number;
}

export const methodLabel = (method: string) => (method === "card_asaas" ? "cartão" : "Pix");

/** Assunto "Seu acesso: <produto>" com 1 produto principal e "Seu acesso: <oferta>" com mais de 1. */
export function deliverySubject(d: Pick<DeliveryEmailData, "offerName" | "storeName" | "items">): string {
  const main = d.items.filter((i) => i.kind === "main");
  return `Seu acesso: ${main.length > 1 ? d.offerName : (main[0]?.name ?? d.items[0]?.name ?? d.storeName)}`;
}

/** E-mail "Seu acesso" com um botão por PDF, na ordem da oferta, e só o total do pedido (nunca preço por item). */
export function deliveryEmail(d: DeliveryEmailData): { subject: string; html: string; text: string } {
  const b = brandVars(d.brandColor);
  const brand = b["--color-brand-strong"];
  const subject = deliverySubject(d);
  const hello = firstName(d.buyerName);
  const itemLabel = (i: { kind: string }) => (i.kind === "bump" ? "Adicional · PDF" : "PDF");

  const cards = d.items
    .map(
      (i) => `<tr><td style="padding:0 0 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${C.border};border-radius:12px"><tr>
<td style="padding:16px"><p style="margin:0;font-size:16px;font-weight:700">${esc(i.name)}</p><p style="margin:0;font-size:14px;color:${C.muted}">${itemLabel(i)}</p></td>
<td align="right" style="padding:16px 16px 16px 0;width:1%">${button(i.url, "Baixar PDF", b["--color-brand"], b["--color-on-brand"])}</td>
</tr></table></td></tr>`,
    )
    .join("\n");

  const rows = d.items
    .map(
      (i) =>
        `<tr><td colspan="2" style="padding:6px 0;color:${C.muted}">${esc(i.name)}${i.kind === "bump" ? " (acréscimo)" : ""}</td></tr>`,
    )
    .join("");

  const body = `<tr><td style="padding:32px 32px 8px">
<h1 style="margin:0;font-size:26px;line-height:1.25;letter-spacing:-0.01em">${hello ? `Olá, ${esc(hello)}! ` : ""}Seu acesso chegou.</h1>
<p style="margin:10px 0 0;font-size:16px;color:${C.muted}">Obrigado pela compra. ${d.items.length > 1 ? "Seus arquivos estão prontos" : "Seu arquivo está pronto"} para baixar:</p>
</td></tr>
<tr><td style="padding:16px 32px 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${cards}</table></td></tr>
<tr><td style="padding:0 32px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:14px 16px;border-radius:10px;background:${C.soft};font-size:14px;color:${C.muted};line-height:1.55">
<p style="margin:0">• Os links valem por <b style="color:${C.text}">${d.ttlDays} dias</b> e até <b style="color:${C.text}">${d.maxDownloads} downloads</b>. Salve os PDFs no celular ou no computador.</p>
<p style="margin:0">• Cada PDF leva o seu nome e e-mail no rodapé. É um material pessoal: por favor, não compartilhe.</p>
</td></tr></table></td></tr>
<tr><td style="padding:24px 32px 8px">
<p style="margin:0;font-size:13px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${C.muted}">Resumo do pedido #${esc(d.orderCode)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;font-size:15px">${rows}
<tr><td style="padding:10px 0 0;border-top:1px solid ${C.border};font-weight:700">Total pago · ${methodLabel(d.method)}</td><td align="right" style="padding:10px 0 0;border-top:1px solid ${C.border};font-weight:700">${brl(d.totalCents)}</td></tr>
</table></td></tr>
<tr><td style="padding:20px 32px 30px;font-size:15px;color:${C.muted}">
<p style="margin:0">Algum problema para baixar? É só responder este e-mail.</p>
<p style="margin:12px 0 0;color:${C.text}">Com carinho,<br><b>Equipe ${esc(d.storeName)}</b></p>
</td></tr>`;

  const footer = `<p style="margin:0">Você recebeu este e-mail porque comprou na ${esc(d.storeName)} em ${dateSP(d.paidAt)}.</p>
<p style="margin:0">Se o botão não funcionar, copie o link:</p>
${d.items.map((i) => `<p style="margin:0;word-break:break-all">${esc(i.name)}: ${esc(i.url)}</p>`).join("\n")}`;

  const t = { ...d, storeName: oneLine(d.storeName), orderCode: oneLine(d.orderCode), items: d.items.map((i) => ({ ...i, name: oneLine(i.name) })) };
  const text = [
    `${hello ? `Olá, ${oneLine(hello)}! ` : ""}Seu acesso chegou.`,
    "",
    "Obrigado pela compra. Baixe seus arquivos pelos links abaixo:",
    "",
    ...t.items.flatMap((i) => [`${i.name} (${itemLabel(i)})`, i.url, ""]),
    `Os links valem por ${d.ttlDays} dias e até ${d.maxDownloads} downloads. Cada PDF leva o seu nome e e-mail no rodapé: é um material pessoal, por favor não compartilhe.`,
    "",
    `Resumo do pedido #${t.orderCode}`,
    ...t.items.map((i) => `${i.name}${i.kind === "bump" ? " (acréscimo)" : ""}`),
    `Total pago (${methodLabel(d.method)}): ${brl(d.totalCents)}`,
    "",
    "Algum problema para baixar? É só responder este e-mail.",
    `Equipe ${t.storeName}`,
  ].join("\n");

  return { subject, html: layout({ title: subject, storeName: d.storeName, brand, body, footer }), text };
}

/** Aviso ao vendedor: título, parágrafos (texto puro, escapados aqui) e uma linha opcional de detalhes. */
export function sellerEmail(d: { storeName: string; brandColor: string | null; subject: string; heading: string; paragraphs: string[] }): {
  subject: string;
  html: string;
  text: string;
} {
  const brand = brandVars(d.brandColor)["--color-brand-strong"];
  const body = `<tr><td style="padding:32px 32px 30px">
<h1 style="margin:0;font-size:22px;line-height:1.3">${esc(d.heading)}</h1>
${d.paragraphs.map((p) => `<p style="margin:12px 0 0;font-size:15px;color:${C.muted}">${esc(p)}</p>`).join("\n")}
</td></tr>`;
  const footer = `<p style="margin:0">Aviso automático da sua loja ${esc(d.storeName)}.</p>`;
  return {
    subject: d.subject,
    html: layout({ title: d.subject, storeName: d.storeName, brand, body, footer }),
    text: [oneLine(d.heading), "", ...d.paragraphs.flatMap((p) => [oneLine(p), ""]), `Aviso automático da sua loja ${oneLine(d.storeName)}.`].join("\n"),
  };
}

export interface RecoveryEmailData {
  storeName: string;
  brandColor: string | null;
  productName: string;
  totalCents: number;
  actionUrl: string;
  unsubscribeUrl: string;
  /** Validade do código Pix (só no caso "pix"). */
  pixExpiresAt?: Date;
}

/** Lembrete de recuperação de venda (D3): sem nome do comprador, com link de descadastro no rodapé e nos cabeçalhos. */
export function recoveryEmail(
  kind: "lead" | "pix" | "card",
  d: RecoveryEmailData,
): { subject: string; html: string; text: string; headers: MailHeaders } {
  const valor = brl(d.totalCents);
  const until = d.pixExpiresAt ? dateTimeSP(d.pixExpiresAt) : "";
  const reason = kind === "lead" ? "digitou este e-mail no checkout" : "iniciou uma compra";
  const copy = {
    lead: {
      subject: (p: string) => `Sua compra de ${p} ficou pela metade`,
      title: (p: string) => `Ainda dá tempo de garantir ${p}`,
      body: (p: string, s: string) => `Você começou a comprar ${p} (${valor}) na ${s} e não terminou. Se quiser concluir, é só voltar:`,
      button: "Concluir minha compra",
    },
    pix: {
      subject: () => `Seu Pix de ${valor} ainda não foi pago`,
      title: () => "Seu Pix está pronto para pagar",
      body: (p: string, s: string) =>
        `Você gerou um Pix de ${valor} para ${p} na ${s}, mas o pagamento ainda não chegou. O código vale até ${until}. Já pagou? Pode ignorar: o acesso chega assim que o banco confirmar.`,
      button: "Ver o Pix",
    },
    card: {
      subject: (p: string) => `Sua compra de ${p} não foi concluída`,
      title: () => "O pagamento não foi concluído",
      body: (p: string, s: string) =>
        `Sua compra de ${p} (${valor}) na ${s} não foi concluída e nada foi cobrado. Você pode tentar de novo com Pix ou outro cartão:`,
      button: "Tentar de novo",
    },
  }[kind];

  const brandV = brandVars(d.brandColor);
  const brand = brandV["--color-brand-strong"];
  const product = oneLine(d.productName);
  const store = oneLine(d.storeName);
  const subject = copy.subject(product);
  const title = copy.title(product);
  const bodyText = copy.body(product, store);
  const bodyHtml = copy.body(esc(d.productName), esc(d.storeName));
  const optOut = `Não quero receber lembretes da ${store}`;

  const body = `<tr><td style="padding:32px 32px 30px">
<h1 style="margin:0;font-size:24px;line-height:1.3;letter-spacing:-0.01em">${esc(title)}</h1>
<p style="margin:12px 0 20px;font-size:16px;color:${C.muted}">${bodyHtml}</p>
${button(d.actionUrl, copy.button, brandV["--color-brand"], brandV["--color-on-brand"])}
</td></tr>`;
  const footer = `<p style="margin:0">Você recebeu este lembrete porque ${reason} na ${esc(d.storeName)}. Se não foi você, ignore este e-mail.</p>
<p style="margin:6px 0 0"><a href="${esc(d.unsubscribeUrl)}" style="color:${C.muted}">Não quero receber lembretes da ${esc(d.storeName)}</a></p>`;

  const text = [
    title,
    "",
    bodyText,
    `${copy.button}: ${oneLine(d.actionUrl)}`,
    "",
    `Você recebeu este lembrete porque ${reason} na ${store}. Se não foi você, ignore este e-mail.`,
    `${optOut}: ${oneLine(d.unsubscribeUrl)}`,
  ].join("\n");

  return {
    subject,
    html: layout({ title: subject, storeName: d.storeName, brand, body, footer }),
    text,
    headers: cleanHeaders({ "List-Unsubscribe": `<${d.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }),
  };
}
