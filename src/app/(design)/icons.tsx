// Ícones do checkout, embutidos (nenhuma requisição a terceiros na página do comprador).
// Lucide (lucide-static 0.460.0, licença ISC: Copyright (c) Lucide Contributors 2022; partes do Feather, MIT,
// Copyright (c) 2013-2022 Cole Bemis) e a marca do Pix (simple-icons 13.0.0, CC0).
import { createElement, type SVGProps } from "react";

type El = readonly [string, Readonly<Record<string, string>>];
const ICONS = {
  "badge-check": { fill: false, els: [["path", {"d": "M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"}], ["path", {"d": "m9 12 2 2 4-4"}]] as readonly El[] },
  "book-open": { fill: false, els: [["path", {"d": "M12 7v14"}], ["path", {"d": "M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"}]] as readonly El[] },
  "check": { fill: false, els: [["path", {"d": "M20 6 9 17l-5-5"}]] as readonly El[] },
  "chevron-down": { fill: false, els: [["path", {"d": "m6 9 6 6 6-6"}]] as readonly El[] },
  "circle-alert": { fill: false, els: [["circle", {"cx": "12", "cy": "12", "r": "10"}], ["line", {"x1": "12", "x2": "12", "y1": "8", "y2": "12"}], ["line", {"x1": "12", "x2": "12.01", "y1": "16", "y2": "16"}]] as readonly El[] },
  "circle-check": { fill: false, els: [["circle", {"cx": "12", "cy": "12", "r": "10"}], ["path", {"d": "m9 12 2 2 4-4"}]] as readonly El[] },
  "copy": { fill: false, els: [["rect", {"width": "14", "height": "14", "x": "8", "y": "8", "rx": "2", "ry": "2"}], ["path", {"d": "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"}]] as readonly El[] },
  "credit-card": { fill: false, els: [["rect", {"width": "20", "height": "14", "x": "2", "y": "5", "rx": "2"}], ["line", {"x1": "2", "x2": "22", "y1": "10", "y2": "10"}]] as readonly El[] },
  "file-x": { fill: false, els: [["path", {"d": "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"}], ["path", {"d": "M14 2v4a2 2 0 0 0 2 2h4"}], ["path", {"d": "m14.5 12.5-5 5"}], ["path", {"d": "m9.5 12.5 5 5"}]] as readonly El[] },
  "hourglass": { fill: false, els: [["path", {"d": "M5 22h14"}], ["path", {"d": "M5 2h14"}], ["path", {"d": "M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"}], ["path", {"d": "M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"}]] as readonly El[] },
  "info": { fill: false, els: [["circle", {"cx": "12", "cy": "12", "r": "10"}], ["path", {"d": "M12 16v-4"}], ["path", {"d": "M12 8h.01"}]] as readonly El[] },
  "lock": { fill: false, els: [["rect", {"width": "18", "height": "11", "x": "3", "y": "11", "rx": "2", "ry": "2"}], ["path", {"d": "M7 11V7a5 5 0 0 1 10 0v4"}]] as readonly El[] },
  "mail-check": { fill: false, els: [["path", {"d": "M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h8"}], ["path", {"d": "m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"}], ["path", {"d": "m16 19 2 2 4-4"}]] as readonly El[] },
  "mail": { fill: false, els: [["rect", {"width": "20", "height": "16", "x": "2", "y": "4", "rx": "2"}], ["path", {"d": "m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"}]] as readonly El[] },
  "pix": { fill: true, els: [["path", {"d": "M5.283 18.36a3.505 3.505 0 0 0 2.493-1.032l3.6-3.6a.684.684 0 0 1 .946 0l3.613 3.613a3.504 3.504 0 0 0 2.493 1.032h.71l-4.56 4.56a3.647 3.647 0 0 1-5.156 0L4.85 18.36ZM18.428 5.627a3.505 3.505 0 0 0-2.493 1.032l-3.613 3.614a.67.67 0 0 1-.946 0l-3.6-3.6A3.505 3.505 0 0 0 5.283 5.64h-.434l4.573-4.572a3.646 3.646 0 0 1 5.156 0l4.559 4.559ZM1.068 9.422 3.79 6.699h1.492a2.483 2.483 0 0 1 1.744.722l3.6 3.6a1.73 1.73 0 0 0 2.443 0l3.614-3.613a2.482 2.482 0 0 1 1.744-.723h1.767l2.737 2.737a3.646 3.646 0 0 1 0 5.156l-2.736 2.736h-1.768a2.482 2.482 0 0 1-1.744-.722l-3.613-3.613a1.77 1.77 0 0 0-2.444 0l-3.6 3.6a2.483 2.483 0 0 1-1.744.722H3.791l-2.723-2.723a3.646 3.646 0 0 1 0-5.156"}]] as readonly El[] },
  "qr-code": { fill: false, els: [["rect", {"width": "5", "height": "5", "x": "3", "y": "3", "rx": "1"}], ["rect", {"width": "5", "height": "5", "x": "16", "y": "3", "rx": "1"}], ["rect", {"width": "5", "height": "5", "x": "3", "y": "16", "rx": "1"}], ["path", {"d": "M21 16h-3a2 2 0 0 0-2 2v3"}], ["path", {"d": "M21 21v.01"}], ["path", {"d": "M12 7v3a2 2 0 0 1-2 2H7"}], ["path", {"d": "M3 12h.01"}], ["path", {"d": "M12 3h.01"}], ["path", {"d": "M12 16v.01"}], ["path", {"d": "M16 12h1"}], ["path", {"d": "M21 12v.01"}], ["path", {"d": "M12 21v-1"}]] as readonly El[] },
  "refresh-cw": { fill: false, els: [["path", {"d": "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"}], ["path", {"d": "M21 3v5h-5"}], ["path", {"d": "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"}], ["path", {"d": "M8 16H3v5"}]] as readonly El[] },
  "rotate-ccw": { fill: false, els: [["path", {"d": "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"}], ["path", {"d": "M3 3v5h5"}]] as readonly El[] },
  "send": { fill: false, els: [["path", {"d": "M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"}], ["path", {"d": "m21.854 2.147-10.94 10.939"}]] as readonly El[] },
  "shield-check": { fill: false, els: [["path", {"d": "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"}], ["path", {"d": "m9 12 2 2 4-4"}]] as readonly El[] },
  "smartphone": { fill: false, els: [["rect", {"width": "14", "height": "20", "x": "5", "y": "2", "rx": "2", "ry": "2"}], ["path", {"d": "M12 18h.01"}]] as readonly El[] },
  "timer-off": { fill: false, els: [["path", {"d": "M10 2h4"}], ["path", {"d": "M4.6 11a8 8 0 0 0 1.7 8.7 8 8 0 0 0 8.7 1.7"}], ["path", {"d": "M7.4 7.4a8 8 0 0 1 10.3 1 8 8 0 0 1 .9 10.2"}], ["path", {"d": "m2 2 20 20"}], ["path", {"d": "M12 12v-2"}]] as readonly El[] },
  "timer": { fill: false, els: [["line", {"x1": "10", "x2": "14", "y1": "2", "y2": "2"}], ["line", {"x1": "12", "x2": "15", "y1": "14", "y2": "11"}], ["circle", {"cx": "12", "cy": "14", "r": "8"}]] as readonly El[] },
  "wallet": { fill: false, els: [["path", {"d": "M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"}], ["path", {"d": "M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"}]] as readonly El[] },
} as const;

export type IconName = keyof typeof ICONS;

/** Ícone decorativo (aria-hidden); a cor vem de `currentColor`. */
export function Icon({ name, size = 18, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  const icon = ICONS[name];
  const stroke = icon.fill
    ? { fill: "currentColor" }
    : { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false" {...stroke} {...rest}>
      {icon.els.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}
