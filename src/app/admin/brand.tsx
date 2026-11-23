// Logo da PingaPay (painel, login, troca de senha e criação da loja). Cada imagem tem alt="PingaPay"; o CSS esconde
// (display: none) as que não valem para o tema e o estado da sidebar, então o leitor de tela anuncia o nome uma vez.
import Image from "next/image";
import s from "./panel.module.css";

/**
 * Logo da PingaPay: a versão de cada tema (o CSS mostra uma só, conforme data-theme ou o tema do sistema) e o ícone
 * no lugar do logo quando a sidebar está recolhida.
 */
export function BrandLogo() {
  return (
    <>
      <Image className={`${s.brandLogo} ${s.onlyLight}`} src="/brand/pingapay-logo-light-2.webp" alt="PingaPay" width={132} height={24} priority unoptimized />
      <Image className={`${s.brandLogo} ${s.onlyDark}`} src="/brand/pingapay-logo-dark-2.webp" alt="PingaPay" width={132} height={24} priority unoptimized />
      <Image className={`${s.brandIcon} ${s.onlyLight}`} src="/brand/pingapay-icon-light-2.webp" alt="PingaPay" width={28} height={28} unoptimized />
      <Image className={`${s.brandIcon} ${s.onlyDark}`} src="/brand/pingapay-icon-dark-2.webp" alt="PingaPay" width={28} height={28} unoptimized />
    </>
  );
}
