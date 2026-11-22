// Enquanto uma tela do painel carrega: o esqueleto do conteúdo (a sidebar continua no lugar).
import { Skeleton } from "@/components/arc/skeleton/skeleton";
import s from "../panel.module.css";

export default function PanelLoading() {
  return (
    <div className={s.stack} aria-label="Carregando">
      <div className={s.skeletonHead}>
        <Skeleton label="Carregando a página" lines={2} />
      </div>
      <section className={s.grid4}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={s.kpi}>
            <Skeleton label="Carregando número" lines={2} />
          </div>
        ))}
      </section>
      <div className={s.splitWide}>
        <section className={s.card}>
          <Skeleton label="Carregando gráfico" lines={6} />
        </section>
        <section className={s.card}>
          <Skeleton label="Carregando gráfico" lines={6} />
        </section>
      </div>
    </div>
  );
}
