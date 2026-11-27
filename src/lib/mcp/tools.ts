// Catálogo de ferramentas MCP: cada ação registrada vira ferramenta, a menos que seja pública ou de sistema, de uma
// permissão que token nunca tem (TOKEN_DENIED) ou excluída com motivo. Ação sensível vira ferramenta com aprovação:
// chamá-la só cria um pedido pendente na fila (approvals.request) que alguém da loja aprova no painel.
// Nenhum dado pessoal do comprador sai por aqui: as saídas com comprador passam por projeção de lista branca (monta o
// objeto só com os campos permitidos, mascarados). Ação nova sem decisão faz tests/mcp-tools.test.ts falhar.
import "@/lib/actions/all";
import { z } from "zod";
import { ActionError, runAction, TOKEN_DENIED, type Action } from "@/lib/actions/core";
import { hasPermission, type Permission, type Role } from "@/lib/actions/permissions";
import { registry } from "@/lib/actions/registry";
import type { OfferView } from "@/lib/catalog/offers";
import type { CouponView } from "@/lib/coupons/actions";
import { byTrials, conversionBp, NO_CAMPAIGN, RECOVERY_CASES, type RecoveryCase, type metricsSummary, type TrialsCampaign, type TrialsSummary } from "@/lib/metrics";
import type { listOrders, OrderDetail } from "@/lib/orders/panel";
import { cleanTouch, HIDDEN_LABEL, labelOrHidden, safeLabel } from "@/lib/orders/report";
import { maskEmailStrict, maskName, maskPhone } from "@/lib/privacy";
import { requestApproval } from "./approvals";

/** Rótulo do papel do token como o painel de tokens mostra. */
export const TOKEN_ROLE_LABEL: Record<Role, string> = {
  reader: "Leitor",
  traffic: "Tráfego",
  support: "Suporte",
  admin: "Admin",
  owner: "Dono",
  integration: "Integração",
};

/** Ações que não saem pelo MCP (nome → motivo). Públicas e de sistema ficam de fora pela permissão. */
export const MCP_EXCLUDED: Record<string, string> = {
  "orders.export": "CSV com dados do comprador",
  "products.create": "recebe o arquivo; use products_createUploadLink",
  "products.completeUpload": "chamada pela URL de upload",
  "products.file": "devolve o PDF inteiro; só para o visualizador do painel",
  "approvals.request": "usada pelo próprio MCP ao chamar uma ferramenta sensível",
  "apps.registerTrial": "API de integração do app (só a chave integration)",
  "apps.resendNotice": "reenvio do aviso ao app: só pelo painel do pedido",
};

/** Prefixo da descrição das ferramentas que passam pela fila de aprovação. */
export const APPROVAL_PREFIX = "[Exige aprovação no painel] ";

export interface McpTool {
  /** Nome da ação com `.` trocado por `_` (cabe em `^[a-zA-Z0-9_-]{1,64}$`). */
  name: string;
  action: string;
  description: string;
  inputSchema: object;
  permission: Permission;
  /** Passa pela fila: a chamada só cria um pedido pendente, que alguém da loja aprova no painel. */
  approval: boolean;
  /** Saída da ação → o que o agente recebe. `callMcpTool` usa sempre a do catálogo (pelo nome da ação), não esta. */
  project(out: unknown): unknown;
  /** Argumentos do agente → entrada da ação (ex.: descarta campos que o MCP não expõe). Idem: vale a do catálogo. */
  input?(raw: unknown): unknown;
}

type Schema = Record<string, unknown> & { properties?: Record<string, unknown>; required?: string[] };

/**
 * Esquema da entrada como o agente a envia: default não é obrigatório e data é texto ISO 8601 (z.coerce.date()).
 * Data com pré-processamento (ex.: aceita AAAA-MM-DD) vira texto sem `format`; a descrição do campo explica o formato.
 */
function inputSchemaOf(action: Action<unknown, unknown>): Schema {
  return z.toJSONSchema(action.input, {
    io: "input",
    unrepresentable: "any",
    override: (ctx) => {
      const def = ctx.zodSchema._zod.def;
      if (def.type === "date") Object.assign(ctx.jsonSchema, { type: "string", format: "date-time" });
      else if (def.type === "pipe" && (def as { out?: { _zod: { def: { type: string } } } }).out?._zod.def.type === "date") {
        Object.assign(ctx.jsonSchema, { type: "string" });
      }
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

/** Cupom pela lista branca de campos (campo novo na ação não sai pelo MCP). O código do cupom não é dado pessoal. */
const projectCoupon = (c: CouponView) => ({
  id: c.id,
  code: c.code,
  kind: c.kind,
  percentBp: c.percentBp,
  amountCents: c.amountCents,
  appliesTo: c.appliesTo,
  startsAt: c.startsAt,
  endsAt: c.endsAt,
  maxUses: c.maxUses,
  maxPerEmail: c.maxPerEmail,
  active: c.active,
  archivedAt: c.archivedAt,
  offerIds: [...c.offerIds],
  uses: c.uses,
});

/** Oferta pela lista branca de campos (inclui a entrega e o código no app; campo novo na ação não sai pelo MCP). */
const projectProducts = (ps: OfferView["products"]) => ps.map((p) => ({ id: p.id, name: p.name, deletedAt: p.deletedAt }));
const projectOffer = (o: OfferView) => ({
  id: o.id,
  slug: o.slug,
  name: o.name,
  priceCents: o.priceCents,
  methods: [...o.methods],
  pixMode: o.pixMode,
  maxInstallments: o.maxInstallments,
  delivery: o.delivery,
  appCode: o.appCode,
  bumpPriceCents: o.bumpPriceCents,
  bumpLabel: o.bumpLabel,
  thankYouText: o.thankYouText,
  pixelId: o.pixelId,
  active: o.active,
  createdAt: o.createdAt,
  products: projectProducts(o.products),
  bump: o.bump ? { products: projectProducts(o.bump.products), priceCents: o.bump.priceCents, label: o.bump.label } : null,
});

/**
 * Campanha digitada no link do anúncio: só passa se parecer rótulo (safeLabel); o resto soma numa linha "(oculto)", com
 * a conversão recalculada. Nunca a conta nem hashes (lista branca de campos).
 */
function projectTrials(d: TrialsSummary) {
  const merged = new Map<string, TrialsCampaign>();
  for (const r of d.byCampaign) {
    const campaign = r.campaign === NO_CAMPAIGN ? NO_CAMPAIGN : (safeLabel(r.campaign) ?? HIDDEN_LABEL);
    const m = merged.get(campaign) ?? { campaign, trials: 0, paying: 0, conversionBp: null, revenueCents: 0 };
    m.trials += r.trials;
    m.paying += r.paying;
    m.revenueCents += r.revenueCents;
    merged.set(campaign, m);
  }
  return {
    trials: d.trials,
    paying: d.paying,
    conversionBp: d.conversionBp,
    byCampaign: [...merged.values()]
      .map((m) => ({ campaign: m.campaign, trials: m.trials, paying: m.paying, conversionBp: conversionBp(m.paying, m.trials), revenueCents: m.revenueCents }))
      .sort(byTrials),
    retentionCovered: d.retentionCovered,
  };
}

const OVERRIDES: Record<string, Override> = {
  "offers.list": { project: (out) => (out as OfferView[]).map(projectOffer) },
  "offers.get": { project: (out) => projectOffer(out as OfferView) },
  "metrics.trials": { project: (out) => projectTrials(out as TrialsSummary) },
  "coupons.list": { project: (out) => (out as CouponView[]).map(projectCoupon) },
  "coupons.get": { project: (out) => projectCoupon(out as CouponView) },
  "orders.list": {
    description:
      "Lista pedidos (mais recentes primeiro; pageSize 10, 25, 50 ou 100, padrão 50) com filtros de status e método: um valor (status, method) ou vários (statuses, methods). Nome e e-mail do comprador mascarados.",
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
      "Detalhe de um pedido: comprador mascarado, itens, cupom e desconto, pagamentos, estorno, histórico e origem (UTM). Sem IP, user agent, links de download nem e-mails.",
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
        // Cupom: só o código (não é dado pessoal) e o desconto em centavos.
        discountCents: d.discountCents,
        couponCode: d.coupon?.code ?? null,
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
        leads: d.leads,
        leadsConverted: d.leadsConverted,
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
        // Cupons: só o código (não é dado pessoal) e números, campo a campo.
        coupons: d.coupons.map((c) => ({ code: c.code, orders: c.orders, discountCents: c.discountCents, revenueCents: c.revenueCents })),
        // Recuperação por e-mail: só números, campo a campo (quem recebeu o lembrete nunca sai).
        recovery: {
          sent: d.recovery.sent,
          recovered: d.recovery.recovered,
          recoveredRevenueCents: d.recovery.recoveredRevenueCents,
          byCase: Object.fromEntries(
            RECOVERY_CASES.map((k) => [k, { sent: d.recovery.byCase[k].sent, recovered: d.recovery.byCase[k].recovered }]),
          ) as Record<RecoveryCase, { sent: number; recovered: number }>,
        },
      };
    },
  },
};

/** Permissão da ação se ela sai pelo MCP (direta ou pela fila); nulo se não sai (pública, de sistema, negada a token ou excluída). */
function exposedPermission(action: Action<unknown, unknown>): Permission | null {
  const p = action.permission;
  if (p === "public" || p === "system" || TOKEN_DENIED.includes(p) || Object.hasOwn(MCP_EXCLUDED, action.name)) return null;
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
    name: toolName(action.name),
    action: action.name,
    description: (action.sensitive ? APPROVAL_PREFIX : "") + (o.description ?? action.description),
    inputSchema: toolInputSchema(action),
    permission,
    approval: action.sensitive === true,
    project: o.project ?? identity,
    ...(o.input ? { input: o.input } : {}),
  };
}

const toolName = (action: string) => action.replaceAll(".", "_");

/**
 * Texto do erro de ferramenta para um nome fora do catálogo do papel. O nome com `_` é procurado no registro: excluída
 * → o motivo; exposta mas fora do papel → o papel; o resto (desconhecida, pública, de sistema, negada a token) →
 * indisponível.
 */
export function unavailableToolText(name: string, role: Role): string {
  const action = [...registry.values()].find((a) => toolName(a.name) === name);
  if (!action) return "forbidden: ferramenta indisponível";
  if (Object.hasOwn(MCP_EXCLUDED, action.name)) return `indisponível pelo MCP: ${MCP_EXCLUDED[action.name]}`;
  if (exposedPermission(action) !== null) return `forbidden: o papel ${TOKEN_ROLE_LABEL[role]} não inclui esta ferramenta`;
  return "forbidden: ferramenta indisponível";
}

/** O que está fora do MCP (nomes de ferramenta) com o motivo. */
export function unavailableTools(): { excluded: { tool: string; reason: string }[] } {
  return {
    excluded: Object.entries(MCP_EXCLUDED)
      .map(([name, reason]) => ({ tool: toolName(name), reason }))
      .sort((a, b) => a.tool.localeCompare(b.tool)),
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

/** O que o agente recebe ao chamar uma ferramenta com aprovação: nunca os argumentos enviados. */
const PENDING_MESSAGE = "Pedido enviado para aprovação no painel da loja. Consulte com approvals_status.";

/**
 * Executa a ferramenta como o token (`runAction` decide permissão e auditoria) e aplica a projeção na saída.
 * Entrada e projeção vêm do catálogo pelo nome da ação, nunca do objeto recebido: ferramenta forjada (ação fora do
 * catálogo, `project` identidade, sem `input`) não muda o que sai. Ação sensível nunca roda aqui: vira um pedido na
 * fila (approvals.request) e a resposta traz só o estado do pedido.
 */
export async function callMcpTool(tool: McpTool, call: { storeId: string; tokenId: string; role: Role }, args: unknown): Promise<unknown> {
  const action = registry.get(tool.action);
  if (!action || exposedPermission(action) === null) throw new ActionError("forbidden", `Ferramenta indisponível: ${tool.name}`);
  const o = OVERRIDES[action.name] ?? {};
  const ctx = { storeId: call.storeId, actor: { kind: "token", tokenId: call.tokenId, role: call.role }, origin: "mcp" } as const;
  const input = o.input ? o.input(args) : args;
  if (action.sensitive) {
    const r = await runAction(requestApproval, ctx, { action: action.name, args: input });
    return { status: r.status, requestId: r.requestId, expiresAt: r.expiresAt, message: PENDING_MESSAGE };
  }
  return (o.project ?? identity)(await runAction(action, ctx, input));
}
