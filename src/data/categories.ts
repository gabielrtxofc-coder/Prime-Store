/**
 * Rótulos de categoria conhecidos pela interface.
 *
 * O catálogo real traz o rótulo de cada produto (`categoryLabel`) direto da
 * tabela `product_categories`. Este mapa existe apenas como reserva para:
 *  - exibir um rótulo legível quando o backend não enviar `categoryLabel`;
 *  - montar as opções de categoria do cadastro no painel interno.
 *
 * NÃO há produtos fictícios aqui: nenhuma tela pública usa esta lista como
 * catálogo.
 */
const LABELS: Record<string, string> = {
  music: 'Música',
  'film-series': 'Filmes e séries',
  creative: 'Design e criatividade',
  productivity: 'Produtividade',
  education: 'Educação',
  software: 'Software e ferramentas',
  other: 'Outras categorias digitais',
};

export const categoryOptions: Array<{ id: string; label: string }> = Object.entries(LABELS).map(
  ([id, label]) => ({ id, label }),
);

/** Rótulo legível para uma categoria; usa o id quando desconhecido. */
export function fallbackCategoryLabel(categoryId: string): string {
  if (!categoryId) return 'Catálogo';
  return LABELS[categoryId] ?? categoryId;
}
