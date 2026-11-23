"use client";

// Abas da página Ofertas: "Ofertas" e "Cupons". Só a aba aberta fica montada; a escolha vai para o endereço (?aba=) sem
// recarregar, para links diretos. As duas listas vêm prontas do servidor.
import { useState, type ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/arc/tabs/tabs";
import { OFFERS_TABS, type OffersTab } from "./tabs";

export function OffersTabs({ initialTab, offers, coupons }: { initialTab: OffersTab; offers: ReactNode; coupons: ReactNode }) {
  const [tab, setTab] = useState<OffersTab>(initialTab);
  const go = (k: string) => {
    if (!OFFERS_TABS.some(([t]) => t === k)) return;
    setTab(k as OffersTab);
    const url = new URL(window.location.href);
    if (k === "ofertas") url.searchParams.delete("aba");
    else url.searchParams.set("aba", k);
    window.history.replaceState(null, "", url);
  };
  return (
    <Tabs value={tab} onValueChange={go}>
      <TabsList aria-label="Seções de ofertas">
        {OFFERS_TABS.map(([k, label]) => (
          <TabsTrigger key={k} value={k}>
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="ofertas">{offers}</TabsContent>
      <TabsContent value="cupons">{coupons}</TabsContent>
    </Tabs>
  );
}
