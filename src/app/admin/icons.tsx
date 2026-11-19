// Ícones do painel, embutidos (nenhuma requisição a terceiros). Lucide (lucide-static 0.460.0, licença ISC:
// Copyright (c) Lucide Contributors 2022; partes do Feather, MIT, Copyright (c) 2013-2022 Cole Bemis).
// Separado dos ícones do checkout para não pesar no bundle do comprador.
import { createElement, type SVGProps } from "react";

type El = readonly [string, Readonly<Record<string, string>>];
const ICONS: Record<string, readonly El[]> = {
  "arrow-left": [["path", {"d":"m12 19-7-7 7-7"}], ["path", {"d":"M19 12H5"}]],
  "arrow-right": [["path", {"d":"M5 12h14"}], ["path", {"d":"m12 5 7 7-7 7"}]],
  "calendar": [["path", {"d":"M8 2v4"}], ["path", {"d":"M16 2v4"}], ["rect", {"width":"18","height":"18","x":"3","y":"4","rx":"2"}], ["path", {"d":"M3 10h18"}]],
  "check": [["path", {"d":"M20 6 9 17l-5-5"}]],
  "chevron-down": [["path", {"d":"m6 9 6 6 6-6"}]],
  "chevron-right": [["path", {"d":"m9 18 6-6-6-6"}]],
  "chevrons-up-down": [["path", {"d":"m7 15 5 5 5-5"}], ["path", {"d":"m7 9 5-5 5 5"}]],
  "circle-alert": [["circle", {"cx":"12","cy":"12","r":"10"}], ["line", {"x1":"12","x2":"12","y1":"8","y2":"12"}], ["line", {"x1":"12","x2":"12.01","y1":"16","y2":"16"}]],
  "circle-check": [["circle", {"cx":"12","cy":"12","r":"10"}], ["path", {"d":"m9 12 2 2 4-4"}]],
  "code": [["polyline", {"points":"16 18 22 12 16 6"}], ["polyline", {"points":"8 6 2 12 8 18"}]],
  "copy": [["rect", {"width":"14","height":"14","x":"8","y":"8","rx":"2","ry":"2"}], ["path", {"d":"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"}]],
  "credit-card": [["rect", {"width":"20","height":"14","x":"2","y":"5","rx":"2"}], ["line", {"x1":"2","x2":"22","y1":"10","y2":"10"}]],
  "download": [["path", {"d":"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"}], ["polyline", {"points":"7 10 12 15 17 10"}], ["line", {"x1":"12","x2":"12","y1":"15","y2":"3"}]],
  "external-link": [["path", {"d":"M15 3h6v6"}], ["path", {"d":"M10 14 21 3"}], ["path", {"d":"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"}]],
  "eye-off": [["path", {"d":"M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"}], ["path", {"d":"M14.084 14.158a3 3 0 0 1-4.242-4.242"}], ["path", {"d":"M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"}], ["path", {"d":"m2 2 20 20"}]],
  "eye": [["path", {"d":"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"}], ["circle", {"cx":"12","cy":"12","r":"3"}]],
  "file-text": [["path", {"d":"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"}], ["path", {"d":"M14 2v4a2 2 0 0 0 2 2h4"}], ["path", {"d":"M10 9H8"}], ["path", {"d":"M16 13H8"}], ["path", {"d":"M16 17H8"}]],
  "file-up": [["path", {"d":"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"}], ["path", {"d":"M14 2v4a2 2 0 0 0 2 2h4"}], ["path", {"d":"M12 12v6"}], ["path", {"d":"m15 15-3-3-3 3"}]],
  "gift": [["rect", {"x":"3","y":"8","width":"18","height":"4","rx":"1"}], ["path", {"d":"M12 8v13"}], ["path", {"d":"M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"}], ["path", {"d":"M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"}]],
  "hourglass": [["path", {"d":"M5 22h14"}], ["path", {"d":"M5 2h14"}], ["path", {"d":"M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"}], ["path", {"d":"M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"}]],
  "inbox": [["polyline", {"points":"22 12 16 12 14 15 10 15 8 12 2 12"}], ["path", {"d":"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"}]],
  "info": [["circle", {"cx":"12","cy":"12","r":"10"}], ["path", {"d":"M12 16v-4"}], ["path", {"d":"M12 8h.01"}]],
  "landmark": [["line", {"x1":"3","x2":"21","y1":"22","y2":"22"}], ["line", {"x1":"6","x2":"6","y1":"18","y2":"11"}], ["line", {"x1":"10","x2":"10","y1":"18","y2":"11"}], ["line", {"x1":"14","x2":"14","y1":"18","y2":"11"}], ["line", {"x1":"18","x2":"18","y1":"18","y2":"11"}], ["polygon", {"points":"12 2 20 7 4 7"}]],
  "layout-dashboard": [["rect", {"width":"7","height":"9","x":"3","y":"3","rx":"1"}], ["rect", {"width":"7","height":"5","x":"14","y":"3","rx":"1"}], ["rect", {"width":"7","height":"9","x":"14","y":"12","rx":"1"}], ["rect", {"width":"7","height":"5","x":"3","y":"16","rx":"1"}]],
  "link-2": [["path", {"d":"M9 17H7A5 5 0 0 1 7 7h2"}], ["path", {"d":"M15 7h2a5 5 0 1 1 0 10h-2"}], ["line", {"x1":"8","x2":"16","y1":"12","y2":"12"}]],
  "lock": [["rect", {"width":"18","height":"11","x":"3","y":"11","rx":"2","ry":"2"}], ["path", {"d":"M7 11V7a5 5 0 0 1 10 0v4"}]],
  "log-out": [["path", {"d":"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"}], ["polyline", {"points":"16 17 21 12 16 7"}], ["line", {"x1":"21","x2":"9","y1":"12","y2":"12"}]],
  "mail": [["rect", {"width":"20","height":"16","x":"2","y":"4","rx":"2"}], ["path", {"d":"m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"}]],
  "menu": [["line", {"x1":"4","x2":"20","y1":"12","y2":"12"}], ["line", {"x1":"4","x2":"20","y1":"6","y2":"6"}], ["line", {"x1":"4","x2":"20","y1":"18","y2":"18"}]],
  "package": [["path", {"d":"M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"}], ["path", {"d":"M12 22V12"}], ["path", {"d":"m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7"}], ["path", {"d":"m7.5 4.27 9 5.15"}]],
  "palette": [["circle", {"cx":"13.5","cy":"6.5","r":".5","fill":"currentColor"}], ["circle", {"cx":"17.5","cy":"10.5","r":".5","fill":"currentColor"}], ["circle", {"cx":"8.5","cy":"7.5","r":".5","fill":"currentColor"}], ["circle", {"cx":"6.5","cy":"12.5","r":".5","fill":"currentColor"}], ["path", {"d":"M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"}]],
  "plug": [["path", {"d":"M12 22v-5"}], ["path", {"d":"M9 8V2"}], ["path", {"d":"M15 8V2"}], ["path", {"d":"M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"}]],
  "plus": [["path", {"d":"M5 12h14"}], ["path", {"d":"M12 5v14"}]],
  "receipt": [["path", {"d":"M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"}], ["path", {"d":"M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"}], ["path", {"d":"M12 17.5v-11"}]],
  "refresh-cw": [["path", {"d":"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"}], ["path", {"d":"M21 3v5h-5"}], ["path", {"d":"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"}], ["path", {"d":"M8 16H3v5"}]],
  "rotate-ccw": [["path", {"d":"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"}], ["path", {"d":"M3 3v5h5"}]],
  "search": [["circle", {"cx":"11","cy":"11","r":"8"}], ["path", {"d":"m21 21-4.3-4.3"}]],
  "send": [["path", {"d":"M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"}], ["path", {"d":"m21.854 2.147-10.94 10.939"}]],
  "settings": [["path", {"d":"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"}], ["circle", {"cx":"12","cy":"12","r":"3"}]],
  "shield-alert": [["path", {"d":"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"}], ["path", {"d":"M12 8v4"}], ["path", {"d":"M12 16h.01"}]],
  "shield-check": [["path", {"d":"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"}], ["path", {"d":"m9 12 2 2 4-4"}]],
  "sparkles": [["path", {"d":"M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"}], ["path", {"d":"M20 3v4"}], ["path", {"d":"M22 5h-4"}], ["path", {"d":"M4 17v2"}], ["path", {"d":"M5 18H3"}]],
  "tag": [["path", {"d":"M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"}], ["circle", {"cx":"7.5","cy":"7.5","r":".5","fill":"currentColor"}]],
  "trending-down": [["polyline", {"points":"22 17 13.5 8.5 8.5 13.5 2 7"}], ["polyline", {"points":"16 17 22 17 22 11"}]],
  "trending-up": [["polyline", {"points":"22 7 13.5 15.5 8.5 10.5 2 17"}], ["polyline", {"points":"16 7 22 7 22 13"}]],
  "triangle-alert": [["path", {"d":"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"}], ["path", {"d":"M12 9v4"}], ["path", {"d":"M12 17h.01"}]],
  "user": [["path", {"d":"M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"}], ["circle", {"cx":"12","cy":"7","r":"4"}]],
  "users": [["path", {"d":"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"}], ["circle", {"cx":"9","cy":"7","r":"4"}], ["path", {"d":"M22 21v-2a4 4 0 0 0-3-3.87"}], ["path", {"d":"M16 3.13a4 4 0 0 1 0 7.75"}]],
  "x": [["path", {"d":"M18 6 6 18"}], ["path", {"d":"m6 6 12 12"}]],

};

export type PanelIconName =
  | "arrow-left"
  | "arrow-right"
  | "calendar"
  | "check"
  | "chevron-down"
  | "chevron-right"
  | "chevrons-up-down"
  | "circle-alert"
  | "circle-check"
  | "code"
  | "copy"
  | "credit-card"
  | "download"
  | "external-link"
  | "eye-off"
  | "eye"
  | "file-text"
  | "file-up"
  | "gift"
  | "hourglass"
  | "inbox"
  | "info"
  | "landmark"
  | "layout-dashboard"
  | "link-2"
  | "lock"
  | "log-out"
  | "mail"
  | "menu"
  | "package"
  | "palette"
  | "plug"
  | "plus"
  | "receipt"
  | "refresh-cw"
  | "rotate-ccw"
  | "search"
  | "send"
  | "settings"
  | "shield-alert"
  | "shield-check"
  | "sparkles"
  | "tag"
  | "trending-down"
  | "trending-up"
  | "triangle-alert"
  | "user"
  | "users"
  | "x"
  ;

/** Ícone decorativo (aria-hidden); a cor vem de `currentColor`. */
export function PIcon({ name, size = 18, ...rest }: { name: PanelIconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {ICONS[name]!.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}
