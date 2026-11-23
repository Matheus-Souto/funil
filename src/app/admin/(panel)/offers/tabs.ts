// Abas da página Ofertas (usadas pela página no servidor e pelas abas no navegador). Cupons é uma aba, não um item do menu.
export const OFFERS_TABS = [
  ["ofertas", "Ofertas"],
  ["cupons", "Cupons"],
] as const;
export type OffersTab = (typeof OFFERS_TABS)[number][0];
