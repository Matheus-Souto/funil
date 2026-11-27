// O que a página do checkout (/c/[slug]) mostra da oferta, montado a partir de `offers.getPublic`. Puro: sem banco
// (o tipo também é usado pelo formulário, no navegador). O comprador nunca vê preço rateado.

export type CheckoutMethod = "pix" | "card";

export interface CheckoutOffer {
  slug: string;
  name: string;
  /** `app`: o funil cobra e avisa o app (sem PDF); a página só abre pela sessão do app. */
  delivery: "download" | "app";
  /** Linha de produto: o nome do produto com 1 principal (como antes); com mais (ou na oferta de app), o nome da oferta. */
  productName: string;
  /** "Inclui: A · B · C" com mais de 1 principal, na ordem da oferta; `null` com 1. */
  includes: string | null;
  priceCents: number;
  methods: CheckoutMethod[];
  pixMode: "manual" | "asaas";
  maxInstallments: number;
  /** O documento do comprador pode ser CPF ou CNPJ (loja com a opção); senão, só CPF. */
  acceptCnpj: boolean;
  /**
   * `productName`: o nome do produto se o bump tem um só; com mais, o rótulo (obrigatório nesse caso).
   * `contents`: os nomes separados por " · " com mais de 1 produto; `null` com 1.
   */
  bump: { productName: string; contents: string | null; priceCents: number; label: string | null } | null;
}

type Named = { name: string };
export interface PublicOfferLike {
  slug: string;
  name: string;
  delivery: "download" | "app";
  products: Named[];
  priceCents: number;
  pixMode: string;
  maxInstallments: number;
  acceptCnpj?: boolean;
  bump: { products: Named[]; priceCents: number; label: string | null } | null;
}

const joinNames = (ps: Named[]) => ps.map((p) => p.name).join(" · ");

export function checkoutOffer(o: PublicOfferLike, methods: CheckoutMethod[]): CheckoutOffer {
  const many = o.products.length > 1;
  const bump = o.bump;
  return {
    slug: o.slug,
    name: o.name,
    delivery: o.delivery,
    productName: many || o.products.length === 0 ? o.name : o.products[0]!.name,
    includes: many ? `Inclui: ${joinNames(o.products)}` : null,
    priceCents: o.priceCents,
    methods,
    pixMode: o.pixMode as "manual" | "asaas",
    maxInstallments: o.maxInstallments,
    acceptCnpj: o.acceptCnpj === true,
    bump: bump
      ? {
          productName: bump.products.length === 1 ? bump.products[0]!.name : (bump.label ?? joinNames(bump.products)),
          contents: bump.products.length > 1 ? joinNames(bump.products) : null,
          priceCents: bump.priceCents,
          label: bump.label,
        }
      : null,
  };
}
