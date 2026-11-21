"use client";

// Seletor de período da visão geral: a pílula desliza com mola até o período clicado (Motion, layoutId) e o botão
// afunda de leve ao apertar. Sem movimento quando o sistema pede movimento reduzido.
import Link from "next/link";
import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import s from "../panel.module.css";

const SPRING = { type: "spring", stiffness: 520, damping: 32, mass: 0.8 } as const;

export function PeriodTabs({ items, current }: { items: Array<{ key: string; label: string; href: string }>; current: string }) {
  const reduced = useReducedMotion();
  // A pílula vai para o período clicado na hora (antes da página nova chegar) e acompanha a URL depois.
  const [selected, setSelected] = useState(current);
  const [seen, setSeen] = useState(current);
  if (current !== seen) {
    setSeen(current);
    setSelected(current);
  }
  return (
    <nav className={s.segment} aria-label="Período">
      {items.map((i) => {
        const on = i.key === selected;
        return (
          <motion.span key={i.key} className={s.segmentItem} whileTap={reduced ? undefined : { scale: 0.94 }} transition={SPRING}>
            {on ? <motion.span layoutId="period-pill" className={s.segmentPill} transition={reduced ? { duration: 0 } : SPRING} /> : null}
            <Link href={i.href} aria-current={i.key === current ? "page" : undefined} scroll={false} onClick={() => setSelected(i.key)}>
              {i.label}
            </Link>
          </motion.span>
        );
      })}
    </nav>
  );
}
