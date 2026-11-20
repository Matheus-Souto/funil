// O que a página do checkout (/c/[slug]) mostra da oferta, montado a partir de `offers.getPublic`. Puro: sem banco
// (o tipo também é usado pelo formulário, no navegador). O comprador nunca vê preço rateado.

export type CheckoutMethod = "pix" | "card";

export interface CheckoutOffer {
  slug: string;
  name: string;
  /** Linha de produto: o nome do produto com 1 principal (como antes); com mais, o nome da oferta. */
  productName: string;
  /** "Inclui: A · B · C" com mais de 1 principal, na ordem da oferta; `null` com 1. */
  includes: string | null;
  priceCents: number;
  methods: CheckoutMethod[];
  pixMode: "manual" | "asaas";
  maxInstallments: number;
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
  products: Named[];
  priceCents: number;
  pixMode: string;
  maxInstallments: number;
  bump: { products: Named[]; priceCents: number; label: string | null } | null;
}

const joinNames = (ps: Named[]) => ps.map((p) => p.name).join(" · ");

export function checkoutOffer(o: PublicOfferLike, methods: CheckoutMethod[]): CheckoutOffer {
  const many = o.products.length > 1;
  const bump = o.bump;
  return {
    slug: o.slug,
    name: o.name,
    productName: many ? o.name : o.products[0]!.name,
    includes: many ? `Inclui: ${joinNames(o.products)}` : null,
    priceCents: o.priceCents,
    methods,
    pixMode: o.pixMode as "manual" | "asaas",
    maxInstallments: o.maxInstallments,
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
