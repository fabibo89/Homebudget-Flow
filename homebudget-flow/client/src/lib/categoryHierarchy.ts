import type { CategoryOut } from '../api/client';

export function flattenCategoryNodes(roots: CategoryOut[]): CategoryOut[] {
  const out: CategoryOut[] = [];
  const walk = (n: CategoryOut) => {
    out.push(n);
    for (const ch of n.children ?? []) walk(ch);
  };
  for (const r of roots) walk(r);
  return out;
}

export function buildCategoryNodeByIdMap(roots: CategoryOut[]): Map<number, CategoryOut> {
  return new Map(flattenCategoryNodes(roots).map((n) => [n.id, n]));
}

/**
 * Wie im Geldfluss: Hauptkategorie (Baumwurzel) und „Unterkategorie“ (direktes Kind der Wurzel, sonst Blatt).
 */
export function resolveCategoryRootAndSub(
  categoryId: number | null,
  nodeById: Map<number, CategoryOut>,
): { root: string; sub: string } {
  if (categoryId == null) return { root: 'Ohne Kategorie', sub: '—' };
  const leaf = nodeById.get(categoryId);
  if (!leaf) return { root: 'Kategorie (unbekannt)', sub: String(categoryId) };

  const chain: CategoryOut[] = [];
  let cur: CategoryOut | undefined = leaf;
  const seen = new Set<number>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    if (cur.parent_id == null) break;
    cur = nodeById.get(cur.parent_id);
  }

  const rootNode = chain[chain.length - 1];
  const rootName = rootNode?.name ?? leaf.name;

  const childUnderRoot = chain.length >= 2 ? chain[chain.length - 2] : leaf;
  const subName = childUnderRoot?.name ?? leaf.name;
  return { root: rootName, sub: subName };
}
