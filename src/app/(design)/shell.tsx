// Moldura das páginas do comprador: cor da loja (contraste AA), Cabeçalho da loja, rodapé e Selos de confiança.
import type { CSSProperties, ReactNode } from "react";
import { brandVars } from "@/lib/brand";
import s from "./buyer.module.css";
import { Icon } from "./icons";

export function BuyerShell({ storeName, brandColor, children }: { storeName: string; brandColor: string | null; children: ReactNode }) {
  return (
    <div className={s.page} style={brandVars(brandColor) as CSSProperties}>
      <header className={s.header}>
        <div className={s.headerInner}>
          <span className={s.storeName}>{storeName}</span>
          <span className={s.secure}>
            <Icon name="lock" size={15} />
            Pagamento seguro
          </span>
        </div>
      </header>
      {children}
      <footer className={s.footer}>
        <p>
          Vendido por <b>{storeName}</b>
        </p>
        <p>Checkout processado pelo Funil</p>
      </footer>
    </div>
  );
}

export function TrustSeals() {
  return (
    <ul className={s.seals}>
      <li>
        <Icon name="shield-check" size={20} />
        <span>Pagamento protegido</span>
      </li>
      <li>
        <Icon name="mail-check" size={20} />
        <span>Acesso enviado por e-mail</span>
      </li>
      <li>
        <Icon name="rotate-ccw" size={20} />
        <span>7 dias de garantia</span>
      </li>
    </ul>
  );
}
