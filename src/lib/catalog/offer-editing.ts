// Regra pura do editor de oferta do painel (sem dependência de banco: roda no navegador).

/**
 * O editor atual só edita 1 produto principal e 1 no bump. Oferta com mais que isso (criada pelo MCP ou pelo editor novo
 * da Task 4) não pode ter produtos, bump e preço do bump editados por ele: salvar reduziria a lista a 1 por grupo.
 * `null` é oferta nova.
 */
export function editorCanEditProducts(o: { mainCount: number; bumpCount: number } | null): boolean {
  return o === null || (o.mainCount <= 1 && o.bumpCount <= 1);
}
