// App falso para o E2E da integração (docs/integracao-apps.md): recebe os avisos assinados do funil num servidor HTTP
// em loopback (o app multi sobe com APP_WEBHOOK_ALLOW_LOOPBACK=1) e aplica as regras que o contrato pede ao app:
//   - confere a assinatura (`Funil-Assinatura: t=<unix>,v1=<hex>`, HMAC-SHA256 de `t + "." + corpo cru`) com janela de
//     5 minutos; assinatura inválida -> 401 e nada aplicado (§7.4);
//   - dedupe pelo `id` do aviso (§7.5, regra 1) e descarte de `sequencia` menor que a maior já aplicada no pedido
//     (§7.5, regra 2);
//   - libera uma vez por `pedido` e retira no reembolso (§8, modelo ilustrativo).
// Guarda tudo o que chegou (corpo cru e cabeçalhos) para o teste conferir.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

export interface Notice {
  id: string;
  tipo: string;
  criado_em: string;
  dados: {
    conta?: string;
    pedido?: string;
    app_code?: string;
    valor_centavos?: number;
    metodo?: string;
    pago_em?: string | null;
    sequencia?: number;
    valor_estornado_centavos?: number;
  };
}

export interface Delivery {
  headers: IncomingHttpHeaders;
  raw: string;
  /** Assinatura conferida com o segredo atual dentro da janela. */
  authentic: boolean;
  /** O que o app fez: aplicou, ignorou por `id` repetido, descartou por `sequencia` antiga ou recusou (401). */
  outcome: "aplicado" | "repetido" | "antigo" | "recusado" | "ping";
  notice: Notice | null;
}

export interface OrderState {
  conta: string;
  appCode: string;
  ultimaSequencia: number;
  estado: "nada" | "liberado" | "retirado";
  /** Quantas vezes o app liberou este pedido (o contrato exige 1). */
  liberacoes: number;
}

const WINDOW_SECONDS = 5 * 60;

/** Confere `Funil-Assinatura` como o §7.4 (mesma regra, com node:crypto). */
export function verifySignature(secret: string, raw: string, header: string | undefined, nowMs = Date.now()): boolean {
  if (!header) return false;
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (name === "t" && /^\d{1,12}$/.test(value)) t = Number(value);
    else if (name === "v1" && /^[0-9a-f]{64}$/.test(value)) v1.push(value);
  }
  if (t === null || v1.length === 0) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - t) > WINDOW_SECONDS) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex"));
  return v1.some((got) => {
    const b = Buffer.from(got);
    return b.length === expected.length && timingSafeEqual(b, expected);
  });
}

/** Assina como o funil (para o teste mandar avisos forjados ao app falso). */
export function sign(secret: string, raw: string, t: number): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
}

export class FakeApp {
  readonly deliveries: Delivery[] = [];
  readonly orders = new Map<string, OrderState>();
  private readonly seen = new Set<string>();
  /** Segredo do webhook (o painel mostra uma vez; o teste o copia para cá). */
  secret = "";
  private server: Server | null = null;
  port = 0;

  get url(): string {
    return `http://127.0.0.1:${this.port}/avisos`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (c: string) => (raw += c));
      req.on("end", () => {
        const { status } = this.receive(req.method ?? "", req.url ?? "", req.headers, raw);
        res.writeHead(status).end();
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const a = this.server.address();
    this.port = a && typeof a === "object" ? a.port : 0;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Avisos autênticos de um pedido, na ordem em que chegaram. */
  noticesOf(pedido: string): Notice[] {
    return this.deliveries.filter((d) => d.authentic && d.notice?.dados.pedido === pedido).map((d) => d.notice!);
  }

  private receive(method: string, path: string, headers: IncomingHttpHeaders, raw: string): { status: number } {
    if (method !== "POST" || path !== "/avisos") return { status: 404 };
    const authentic = this.secret !== "" && verifySignature(this.secret, raw, headers["funil-assinatura"] as string | undefined);
    if (!authentic) {
      this.deliveries.push({ headers, raw, authentic, outcome: "recusado", notice: null });
      return { status: 401 };
    }
    const notice = JSON.parse(raw) as Notice;
    if (notice.tipo === "ping") {
      this.deliveries.push({ headers, raw, authentic, outcome: "ping", notice });
      return { status: 204 };
    }
    // Regra 1: o mesmo `id` só é processado uma vez.
    if (this.seen.has(notice.id)) {
      this.deliveries.push({ headers, raw, authentic, outcome: "repetido", notice });
      return { status: 200 };
    }
    this.seen.add(notice.id);
    const d = notice.dados;
    const pedido = d.pedido!;
    const current = this.orders.get(pedido) ?? { conta: d.conta!, appCode: d.app_code!, ultimaSequencia: 0, estado: "nada" as const, liberacoes: 0 };
    // Regra 2: sequência menor que a maior já aplicada é transição antiga.
    if ((d.sequencia ?? 0) < current.ultimaSequencia) {
      this.deliveries.push({ headers, raw, authentic, outcome: "antigo", notice });
      return { status: 200 };
    }
    current.ultimaSequencia = d.sequencia ?? 0;
    if (notice.tipo === "pagamento.confirmado" || notice.tipo === "pagamento.restabelecido") {
      if (current.estado === "nada") {
        current.estado = "liberado";
        current.liberacoes += 1;
      }
    } else if (notice.tipo === "pagamento.reembolsado") {
      current.estado = "retirado";
    }
    this.orders.set(pedido, current);
    this.deliveries.push({ headers, raw, authentic, outcome: "aplicado", notice });
    return { status: 200 };
  }
}
