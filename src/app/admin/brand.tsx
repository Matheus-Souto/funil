// Logo da PingaPay (painel, login, troca de senha e criação da loja).
import Image from "next/image";
import s from "./panel.module.css";

/**
 * Logo da PingaPay: a versão de cada tema (o CSS mostra uma só, conforme data-theme ou o tema do sistema) e o ícone
 * no lugar do logo quando a sidebar está recolhida.
 */
export function BrandLogo() {
  return (
    <>
      <Image className={`${s.brandLogo} ${s.onlyLight}`} src="/brand/pingapay-logo-light-2.webp" alt="" width={132} height={24} priority unoptimized />
      <Image className={`${s.brandLogo} ${s.onlyDark}`} src="/brand/pingapay-logo-dark-2.webp" alt="" width={132} height={24} priority unoptimized />
      <Image className={`${s.brandIcon} ${s.onlyLight}`} src="/brand/pingapay-icon-light-2.webp" alt="" width={28} height={28} unoptimized />
      <Image className={`${s.brandIcon} ${s.onlyDark}`} src="/brand/pingapay-icon-dark-2.webp" alt="" width={28} height={28} unoptimized />
    </>
  );
}
