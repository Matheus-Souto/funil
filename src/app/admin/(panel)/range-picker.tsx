"use client";

// Período do Dashboard: o date-range-picker do Arc, em português, com atalhos (hoje, ontem, 7 e 30 dias, este mês, mês
// passado). Aplicar leva para /admin?de=AAAA-MM-DD&ate=AAAA-MM-DD; o servidor lê esses dias em São Paulo.
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { DateRangePicker, type DateRange, type DateRangePreset } from "@/components/arc/date-range-picker/date-range-picker";
import { spDay } from "../date-range";

/** "AAAA-MM-DD" com os campos locais da data (o calendário guarda o dia escolhido como data local). */
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fromIso = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
};
const shift = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** "Hoje" é o dia de São Paulo (o mesmo que o servidor usa), não o do navegador: num fuso diferente perto da meia-noite
 *  os atalhos e o limite do calendário ficariam um dia para trás ou para a frente. */
const spToday = () => fromIso(spDay(new Date()));

const PRESETS: DateRangePreset[] = [
  { label: "Hoje", range: () => ({ start: spToday(), end: spToday() }) },
  { label: "Ontem", range: () => ({ start: shift(spToday(), -1), end: shift(spToday(), -1) }) },
  { label: "Últimos 7 dias", range: () => ({ start: shift(spToday(), -6), end: spToday() }) },
  { label: "Últimos 30 dias", range: () => ({ start: shift(spToday(), -29), end: spToday() }) },
  { label: "Este mês", range: () => ({ start: new Date(spToday().getFullYear(), spToday().getMonth(), 1), end: spToday() }) },
  {
    label: "Mês passado",
    range: () => {
      const t = spToday();
      return { start: new Date(t.getFullYear(), t.getMonth() - 1, 1), end: new Date(t.getFullYear(), t.getMonth(), 0) };
    },
  },
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
      maxDate={spToday()}
      locale="pt-BR"
      onChange={(r) => start(() => router.push(`/admin?de=${iso(r.start)}&ate=${iso(r.end)}`, { scroll: false }))}
    />
  );
}
