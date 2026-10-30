import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { ProductGrid } from '../components/ProductGrid';
import { categories, getCategoryLabel } from '../data/products';
import { catalogService } from '../services/catalogService';

export function CatalogPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get('q') ?? '');
  const [category, setCategory] = useState(searchParams.get('categoria') ?? 'all');
  const [sort, setSort] = useState('featured');

  useEffect(() => {
    setQuery(searchParams.get('q') ?? '');
    setCategory(searchParams.get('categoria') ?? 'all');
  }, [searchParams]);

  const matchingProducts = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('pt-BR');
    const result = catalogService.getAll().filter((product) => {
      const matchesCategory = category === 'all' || product.categoryId === category;
      const searchable = `${product.name} ${product.shortDescription} ${product.description} ${getCategoryLabel(product.categoryId)}`.toLocaleLowerCase('pt-BR');
      return matchesCategory && (!normalizedQuery || searchable.includes(normalizedQuery));
    });

    return [...result].sort((first, second) => {
      if (sort === 'price-low') return first.priceCents - second.priceCents;
      if (sort === 'price-high') return second.priceCents - first.priceCents;
      if (sort === 'name') return first.name.localeCompare(second.name, 'pt-BR');
      return Number(second.featured) - Number(first.featured) || first.name.localeCompare(second.name, 'pt-BR');
    });
  }, [category, query, sort]);

  const hasActiveFilters = Boolean(query.trim()) || category !== 'all' || sort !== 'featured';

  const clearFilters = () => {
    setQuery('');
    setCategory('all');
    setSort('featured');
    setSearchParams(new URLSearchParams());
  };

  return (
    <section className="container page-section catalog-page">
      <div className="page-heading page-heading--catalog">
        <div><span className="eyebrow-label">CATÁLOGO · DEMONSTRAÇÃO</span><h1>Produtos digitais</h1><p>Explore itens fictícios e teste pesquisa, filtros e navegação. Os valores não são ofertas comerciais.</p></div>
        <span className="demo-tag demo-tag--large">MODO DEMONSTRAÇÃO</span>
      </div>

      <div className="catalog-toolbar">
        <label className="catalog-search">
          <Icon name="search" size={19} />
          <span className="sr-only">Pesquisar por nome ou descrição</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por nome ou descrição" />
          {query && <button type="button" className="catalog-search__clear" aria-label="Limpar pesquisa" onClick={() => setQuery('')}><Icon name="close" size={17} /></button>}
        </label>
        <label className="sort-control"><span>Ordenar por</span>
          <select value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="featured">Destaques</option>
            <option value="price-low">Menor preço</option>
            <option value="price-high">Maior preço</option>
            <option value="name">Nome (A–Z)</option>
          </select>
        </label>
      </div>

      <div className="catalog-filter-block">
        <span className="filter-label">Categoria</span>
        <div className="category-filters" role="group" aria-label="Filtrar por categoria">
          <button className={`filter-chip${category === 'all' ? ' is-selected' : ''}`} type="button" aria-pressed={category === 'all'} onClick={() => setCategory('all')}>Todas</button>
          {categories.map((item) => (
            <button className={`filter-chip${category === item.id ? ' is-selected' : ''}`} type="button" aria-pressed={category === item.id} key={item.id} onClick={() => setCategory(item.id)}>{item.label}</button>
          ))}
        </div>
      </div>

      <div className="catalog-results-heading">
        <p aria-live="polite"><strong>{matchingProducts.length}</strong> {matchingProducts.length === 1 ? 'produto encontrado' : 'produtos encontrados'}</p>
        {hasActiveFilters && <button className="text-button" type="button" onClick={clearFilters}>Limpar filtros</button>}
      </div>

      {matchingProducts.length ? <ProductGrid products={matchingProducts} /> : (
        <section className="empty-state empty-state--catalog" aria-labelledby="catalog-empty-title">
          <span className="empty-state__icon"><Icon name="search" size={25} /></span>
          <h2 id="catalog-empty-title">Nenhum produto encontrado</h2>
          <p>Tente outro termo ou remova os filtros selecionados.</p>
          <button className="button button--secondary" type="button" onClick={clearFilters}>Limpar pesquisa e filtros</button>
        </section>
      )}
    </section>
  );
}
