// Catálogo de ferramentas MCP: cada ação registrada vira ferramenta, a menos que seja sensível (fila de aprovação no
// PR 6), pública ou de sistema, de uma permissão que token nunca tem (team.manage, account.self) ou excluída com motivo.
// Nenhum dado pessoal do comprador sai por aqui: as saídas com comprador passam por projeção de lista branca (monta o
// objeto só com os campos permitidos, mascarados). Ação nova sem decisão faz tests/mcp-tools.test.ts falhar.
import "@/lib/actions/all";
import { z } from "zod";
import { ActionError, runAction, TOKEN_DENIED, type Action } from "@/lib/actions/core";
import { hasPermission, type Permission, type Role } from "@/lib/actions/permissions";
import { registry } from "@/lib/actions/registry";
import type { metricsSummary } from "@/lib/metrics";
import type { listOrders, OrderDetail } from "@/lib/orders/panel";
import { cleanTouch, HIDDEN_LABEL, labelOrHidden, safeLabel } from "@/lib/orders/report";
import { maskEmailStrict, maskName, maskPhone } from "@/lib/privacy";

const SENDS_TO_CALLER_ADDRESS = "enviam a endereço escolhido por quem chama; revisão no PR 6";
const AWAITS_APPROVAL_QUEUE = "aguarda a fila de aprovação (PR 6)";

/** Ações que não saem pelo MCP neste PR (nome → motivo). Públicas e de sistema ficam de fora pela permissão. */
export const MCP_EXCLUDED: Record<string, string> = {
  "orders.export": "CSV com dados do comprador",
  "products.create": "upload por link no PR 6",
  "connections.testSmtp": SENDS_TO_CALLER_ADDRESS,
  "connections.testResend": SENDS_TO_CALLER_ADDRESS,
  "connections.testTelegram": SENDS_TO_CALLER_ADDRESS,
  "alerts.ack": "some com o aviso para toda a loja (inclusive o de segurança da página de pagamento); revisão no PR 6",
  // Criar/alterar oferta contorna updatePrice/setProducts/setSlug (sensíveis): preço, ativa, métodos, texto ao comprador.
  "offers.create": AWAITS_APPROVAL_QUEUE,
  "offers.update": AWAITS_APPROVAL_QUEUE,
  // Reenvia ao comprador sem limite por pedido e, com renew, gira os links de download.
  "orders.resend": AWAITS_APPROVAL_QUEUE,
};

export interface McpTool {
  /** Nome da ação com `.` trocado por `_` (cabe em `^[a-zA-Z0-9_-]{1,64}$`). */
  name: string;
  action: string;
  description: string;
  inputSchema: object;
  permission: Permission;
  /** Saída da ação → o que o agente recebe. `callMcpTool` usa sempre a do catálogo (pelo nome da ação), não esta. */
  project(out: unknown): unknown;
  /** Argumentos do agente → entrada da ação (ex.: descarta campos que o MCP não expõe). Idem: vale a do catálogo. */
  input?(raw: unknown): unknown;
}

type Schema = Record<string, unknown> & { properties?: Record<string, unknown>; required?: string[] };

/** Esquema da entrada como o agente a envia: default não é obrigatório e data é texto ISO 8601 (z.coerce.date()). */
function inputSchemaOf(action: Action<unknown, unknown>): Schema {
  return z.toJSONSchema(action.input, {
    io: "input",
    unrepresentable: "any",
    override: (ctx) => {
      if (ctx.zodSchema._zod.def.type === "date") Object.assign(ctx.jsonSchema, { type: "string", format: "date-time" });
    },
  }) as Schema;
}

const without = (o: object, key: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

function withoutProperty(schema: Schema, key: string): Schema {
  const out: Schema = { ...schema, properties: without(schema.properties ?? {}, key) };
  if (schema.required) out.required = schema.required.filter((k) => k !== key);
  return out;
}

const identity = (out: unknown) => out;

/** Origem/indicação digitada pelo visitante: só passa se parecer rótulo (safeLabel); o resto soma numa linha "(oculto)". */
function safeLabelRows(rows: { label: string; paid: number; revenueCents: number }[]) {
  const merged = new Map<string, { label: string; paid: number; revenueCents: number }>();
  for (const r of rows) {
    const label = safeLabel(r.label) ?? HIDDEN_LABEL;
    const m = merged.get(label) ?? { label, paid: 0, revenueCents: 0 };
    m.paid += r.paid;
    m.revenueCents += r.revenueCents;
    merged.set(label, m);
  }
  return [...merged.values()].sort((a, b) => b.revenueCents - a.revenueCents || b.paid - a.paid || a.label.localeCompare(b.label));
}

/** Só a máscara estrita do MCP (`***.***.***-12`) passa; qualquer outra coisa vira nulo. */
const CPF_STRICT_RE = /^\*\*\*\.\*\*\*\.\*\*\*-(\d{2}|\*\*)$/;

type OrderList = Awaited<ReturnType<typeof listOrders.run>>;
type MetricsSummary = Awaited<ReturnType<typeof metricsSummary.run>>;

interface Override {
  description?: string;
  inputSchema?(schema: Schema): Schema;
  input?(raw: unknown): unknown;
  project?(out: unknown): unknown;
}

const OVERRIDES: Record<string, Override> = {
  "orders.list": {
    description: "Lista pedidos (50 por página, mais recentes primeiro) com filtros de status e método. Nome e e-mail do comprador mascarados.",
    // Sem busca por e-mail ou nome: seria um jeito de confirmar se uma pessoa comprou.
    inputSchema: (s) => withoutProperty(s, "q"),
    input: (raw) => (raw === null || typeof raw !== "object" || Array.isArray(raw) ? raw : without(raw, "q")),
    project: (out) => {
      const d = out as OrderList;
      return {
        items: d.items.map((i) => ({
          id: i.id,
          code: i.code,
          createdAt: i.createdAt,
          status: i.status,
          method: i.method,
          totalCents: i.totalCents,
          manualAmountCents: i.manualAmountCents,
          hasBump: i.hasBump,
          expiresAt: i.expiresAt,
          paidAt: i.paidAt,
          refundRequestedAt: i.refundRequestedAt,
          offerName: i.offerName,
          buyerName: maskName(i.buyerName),
          email: maskEmailStrict(i.email),
        })),
        total: d.total,
        page: d.page,
        pageSize: d.pageSize,
        counts: d.counts,
      };
    },
  },
  "orders.get": {
    description:
      "Detalhe de um pedido: comprador mascarado, itens, pagamentos, estorno, histórico e origem (UTM). Sem IP, user agent, links de download nem e-mails.",
    project: (out) => {
      const d = out as OrderDetail;
      return {
        id: d.id,
        code: d.code,
        status: d.status,
        method: d.method,
        createdAt: d.createdAt,
        paidAt: d.paidAt,
        expiresAt: d.expiresAt,
        subtotalCents: d.subtotalCents,
        totalCents: d.totalCents,
        manualAmountCents: d.manualAmountCents,
        hasBump: d.hasBump,
        offer: { id: d.offer.id, name: d.offer.name, slug: d.offer.slug },
        buyer: {
          name: maskName(d.buyer.name),
          email: maskEmailStrict(d.buyer.email),
          phone: maskPhone(d.buyer.phone),
          cpfMasked: d.buyer.cpfMasked !== null && CPF_STRICT_RE.test(d.buyer.cpfMasked) ? d.buyer.cpfMasked : null,
        },
        items: d.items.map((i) => ({ kind: i.kind, names: i.names, priceCents: i.priceCents })),
        payments: d.payments.map((p) => ({
          id: p.id,
          provider: p.provider,
          providerId: p.providerId,
          status: p.status,
          amountCents: p.amountCents,
          flags: p.flags,
        })),
        refund: { state: d.refund.state, requestedAt: d.refund.requestedAt },
        // Sem `detail` nem `actorRole`: só quando, o quê e o rótulo fixo.
        timeline: d.timeline.map((e) => ({ at: e.at, kind: e.kind, label: e.label })),
        // Toques pela lista branca do relatório (UTMs; fbclid fica de fora); valor recusado e ref recusado → "(oculto)".
        attribution: {
          firstTouch: cleanTouch(d.attribution.firstTouch),
          lastTouch: cleanTouch(d.attribution.lastTouch),
          ref: labelOrHidden(d.attribution.ref),
        },
      };
    },
  },
  "metrics.summary": {
    project: (out) => {
      const d = out as MetricsSummary;
      return {
        views: d.views,
        orders: d.orders,
        paid: d.paid,
        revenueCents: d.revenueCents,
        byMethod: Object.fromEntries(
          Object.entries(d.byMethod).map(([k, m]) => [k, { orders: m.orders, paid: m.paid, revenueCents: m.revenueCents }]),
        ),
        bySource: safeLabelRows(d.bySource.map((r) => ({ label: r.source, paid: r.paid, revenueCents: r.revenueCents }))).map(
          ({ label, ...r }) => ({ source: label, ...r }),
        ),
        byRef: safeLabelRows(d.byRef.map((r) => ({ label: r.ref, paid: r.paid, revenueCents: r.revenueCents }))).map(({ label, ...r }) => ({
          ref: label,
          ...r,
        })),
      };
    },
  },
};

/** Permissão da ação se ela sai pelo MCP; nulo se não sai (sensível, pública, de sistema, negada a token ou excluída). */
function exposedPermission(action: Action<unknown, unknown>): Permission | null {
  const p = action.permission;
  if (p === "public" || p === "system" || action.sensitive || TOKEN_DENIED.includes(p) || Object.hasOwn(MCP_EXCLUDED, action.name)) return null;
  return p;
}

/** Esquema final (com o override) por nome de ação: gerado uma vez por processo e compartilhado entre papéis. */
const schemas = new Map<string, Schema>();

function toolInputSchema(action: Action<unknown, unknown>): Schema {
  let schema = schemas.get(action.name);
  if (!schema) {
    const o = OVERRIDES[action.name];
    const base = inputSchemaOf(action);
    schema = o?.inputSchema ? o.inputSchema(base) : base;
    schemas.set(action.name, schema);
  }
  return schema;
}

function toTool(action: Action<unknown, unknown>, permission: Permission): McpTool {
  const o = OVERRIDES[action.name] ?? {};
  return {
    name: action.name.replaceAll(".", "_"),
    action: action.name,
    description: o.description ?? action.description,
    inputSchema: toolInputSchema(action),
    permission,
    project: o.project ?? identity,
    ...(o.input ? { input: o.input } : {}),
  };
}

/** Ferramentas que um token com este papel enxerga (ordenadas pelo nome). */
export function mcpTools(role: Role): McpTool[] {
  const tools: McpTool[] = [];
  for (const action of registry.values()) {
    const permission = exposedPermission(action);
    if (permission && hasPermission(role, permission)) tools.push(toTool(action, permission));
  }
  return tools.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Executa a ferramenta como o token (`runAction` decide permissão e auditoria) e aplica a projeção na saída.
 * Entrada e projeção vêm do catálogo pelo nome da ação, nunca do objeto recebido: ferramenta forjada (ação fora do
 * catálogo, `project` identidade, sem `input`) não muda o que sai.
 */
export async function callMcpTool(tool: McpTool, call: { storeId: string; tokenId: string; role: Role }, args: unknown): Promise<unknown> {
  const action = registry.get(tool.action);
  if (!action || exposedPermission(action) === null) throw new ActionError("forbidden", `Ferramenta indisponível: ${tool.name}`);
  const o = OVERRIDES[action.name] ?? {};
  const out = await runAction(
    action,
    { storeId: call.storeId, actor: { kind: "token", tokenId: call.tokenId, role: call.role }, origin: "mcp" },
    o.input ? o.input(args) : args,
  );
  return (o.project ?? identity)(out);
}
