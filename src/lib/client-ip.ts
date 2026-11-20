// IP do cliente e HTTPS atrás do proxy (checkout do app, entrega e serviço de cartão).
//
// IP do cliente (`TRUST_PROXY`, obrigatória em produção fora de loopback):
// - 1 (ou N proxies confiáveis): o N-ésimo endereço da DIREITA em X-Forwarded-For, isto é, o que o nosso proxy (Caddy)
//   acrescentou a partir do socket. Entradas à esquerda vêm do cliente e podem ser forjadas: nunca são usadas.
//   Com MENOS entradas que N (a requisição não passou por todos os proxies, ex.: acesso direto à origem atrás da
//   Cloudflare), vale a mais à esquerda: o Caddy descarta o cabeçalho de quem não é proxy confiável e escreve o socket.
// - 0 (sem proxy): X-Forwarded-For NÃO é lido. O Next só o preenche com o endereço do socket quando o cliente não
//   mandou o cabeçalho (`??=` em base-server.js), então ele é forjável e o app router não expõe o socket. O IP vira a
//   chave fixa "unknown": o limite por IP é pulado e valem os outros limites (e-mail, cartão).
import { isIP } from "node:net";

/** IP desconhecido (sem proxy confiável o X-Forwarded-For não é lido): sem limite por IP. */
export const UNKNOWN_IP = "unknown";

function normalizeIp(v: string | undefined): string | null {
  if (!v) return null;
  let ip = v.trim().replace(/^\[|\]$/g, "");
  if (ip.toLowerCase().startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) ? ip : null;
}

/** IP do cliente (ver o comentário do topo); `UNKNOWN_IP` sem proxy confiável ou sem endereço válido. */
export function clientIpFrom(headers: Headers, trustProxy: number): string {
  if (trustProxy <= 0) return UNKNOWN_IP;
  const hops = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (hops.length === 0) return UNKNOWN_IP;
  // Menos entradas que proxies confiáveis: a requisição não passou por todos (ex.: acesso direto à origem, sem a
  // Cloudflare). A mais à esquerda é a que o nosso proxy (Caddy) escreveu a partir do socket; "desconhecido" aqui
  // desligaria todos os limites por IP para quem acha o IP da origem.
  return normalizeIp(hops[Math.max(0, hops.length - trustProxy)]) ?? UNKNOWN_IP;
}

/** HTTPS só pelo `X-Forwarded-Proto` (último valor) de um proxy confiável; sem proxy confiável, nunca. */
export function isHttps(headers: Headers, trustProxy: number): boolean {
  // Servidor só fala HTTP: sem proxy confiável, nenhuma requisição é HTTPS (X-Forwarded-Proto pode ser forjado).
  if (trustProxy <= 0) return false;
  const proto = (headers.get("x-forwarded-proto") ?? "").split(",").map((s) => s.trim().toLowerCase());
  return proto[proto.length - 1] === "https";
}
