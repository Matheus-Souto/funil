import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PAGE_TOKENS, contentDisposition, downloadPage } from "@/lib/delivery/download";

describe("página 410 do link de download", () => {
  test("usa os mesmos valores dos tokens do sistema visual (tokens.css)", () => {
    const css = readFileSync(join(import.meta.dir, "../src/app/(design)/tokens.css"), "utf8");
    for (const [name, value] of Object.entries(PAGE_TOKENS)) {
      const m = new RegExp(`${name}:\\s*([^;]+);`).exec(css);
      expect(m, name).not.toBeNull();
      expect(m![1]!.trim().toLowerCase(), name).toBe(value);
    }
  });

  test("escapa o nome da loja e não tem script nem recurso externo", () => {
    const html = downloadPage("gone", { name: `<img src=x onerror=alert(1)>`, brandColor: "#2D55C8" });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toMatch(/<script|https?:\/\//);
    expect(html).toContain("Este link de download expirou");
  });
});

describe("contentDisposition", () => {
  test("nome comum", () => {
    expect(contentDisposition("Maná bíblico.pdf")).toBe(`attachment; filename="Mana biblico.pdf"; filename*=UTF-8''Man%C3%A1%20b%C3%ADblico.pdf`);
  });

  test("sem extensão, vazio ou só pontos -> termina em .pdf", () => {
    expect(contentDisposition("livro")).toContain('filename="livro.pdf"');
    expect(contentDisposition("...")).toContain('filename="arquivo.pdf"');
    expect(contentDisposition("../../etc/passwd")).toContain('filename="_.._etc_passwd.pdf"');
  });
});
