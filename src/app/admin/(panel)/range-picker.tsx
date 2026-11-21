"use client";

// Período do Dashboard: o date-range-picker do Arc, em português, com atalhos (hoje, ontem, 7 e 30 dias, este mês, mês
// passado). Aplicar leva para /admin?de=AAAA-MM-DD&ate=AAAA-MM-DD; o servidor lê esses dias em São Paulo.
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { DateRangePicker, type DateRange, type DateRangePreset } from "@/components/arc/date-range-picker/date-range-picker";

/** "AAAA-MM-DD" com os campos locais da data (o calendário trabalha com o dia local do navegador). */
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fromIso = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
};
const shift = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

const PRESETS: DateRangePreset[] = [
  { label: "Hoje", range: (t) => ({ start: t, end: t }) },
  { label: "Ontem", range: (t) => ({ start: shift(t, -1), end: shift(t, -1) }) },
  { label: "Últimos 7 dias", range: (t) => ({ start: shift(t, -6), end: t }) },
  { label: "Últimos 30 dias", range: (t) => ({ start: shift(t, -29), end: t }) },
  { label: "Este mês", range: (t) => ({ start: new Date(t.getFullYear(), t.getMonth(), 1), end: t }) },
  { label: "Mês passado", range: (t) => ({ start: new Date(t.getFullYear(), t.getMonth() - 1, 1), end: new Date(t.getFullYear(), t.getMonth(), 0) }) },
];

export function RangePicker({ de, ate }: { de: string; ate: string }) {
  const router = useRouter();
  const [, start] = useTransition();
  const value: DateRange = { start: fromIso(de), end: fromIso(ate) };
  return (
    <DateRangePicker
      value={value}
      label="Período"
      placeholder="Escolha as datas"
      presets={PRESETS}
      maxDate={new Date()}
      locale="pt-BR"
      onChange={(r) => start(() => router.push(`/admin?de=${iso(r.start)}&ate=${iso(r.end)}`, { scroll: false }))}
    />
  );
}
