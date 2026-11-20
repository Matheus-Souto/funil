// Detector de dados de cartão em texto (URL, cabeçalhos, corpo, postMessage), usado pelo E2E (e2e/smoke.spec.ts) e
// pelo smoke de deploy (tests/deploy/flow.spec.ts). Devolve o que achou, em ordem: "CVV", "nome impresso", "número",
// "validade". Teste sempre com um controle positivo (o POST ao serviço de cartão precisa dar os quatro).
export type TestCard = { number: string; holder: string; expiry: string; cvv: string };

/**
 * Cabeçalhos de uma requisição como texto para o detector, sem os que só dizem um tamanho (`content-length`): o valor
 * é um número solto e, se o corpo tiver por acaso o mesmo tamanho que o CVV (ex.: 582 bytes) ou o ano (2031), o
 * detector acusaria um vazamento que não existe, em toda rodada.
 */
export function headersText(headers: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(headers).filter(([k]) => !SIZE_HEADERS.has(k.toLowerCase()))));
}
const SIZE_HEADERS = new Set(["content-length"]);

export function cardLeaks(c: TestCard): (text: string) => string[] {
  const digits = c.number.replace(/\D/g, "");
  const spaced = digits.replace(/(\d{4})(?=\d)/g, "$1 ");
  const [mm = "", yy = ""] = c.expiry.split("/");
  return (text: string): string[] => {
    let decoded = text;
    try {
      decoded = decodeURIComponent(text.replace(/\+/g, " "));
    } catch {
      /* texto não codificado: compara como veio */
    }
    const found: string[] = [];
    for (const t of [text, decoded]) {
      // Número: só dígitos, com espaço, %20 ou +.
      if ([digits, spaced, spaced.replace(/ /g, "%20"), spaced.replace(/ /g, "+")].some((v) => t.includes(v))) found.push("número");
      const words = t.split(/[^A-Za-z0-9]+/);
      // Validade: MM/AA (também codificada), MMAA, 20AA, o par MM e AA em sequência e as chaves expiryMonth/expiryYear
      // (formato em que o iframe a manda).
      const pair = words.some((w, i) => w === mm && words[i + 1] === yy);
      const keys = words.some((w) => /^expiry(Month|Year)?$/i.test(w));
      if (t.includes(`${mm}/${yy}`) || t.toLowerCase().includes(`${mm}%2f${yy}`) || pair || keys || words.includes(`${mm}${yy}`) || words.includes(`20${yy}`)) {
        found.push("validade");
      }
      // CVV: 3 dígitos aparecem por acaso em hashes, então vale como "palavra" inteira (entre não alfanuméricos), além
      // das chaves cvv/ccv.
      if (words.includes(c.cvv) || words.some((w) => /^c[cv]v$/i.test(w))) found.push("CVV");
      if (t.toUpperCase().includes(c.holder.toUpperCase())) found.push("nome impresso");
    }
    return [...new Set(found)].sort();
  };
}
