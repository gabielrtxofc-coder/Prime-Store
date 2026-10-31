import { Link } from 'react-router-dom';
import type { Product } from '../types';
import { getCategoryLabel } from '../data/products';
import { useCart } from '../context/CartContext';
import { useToast } from '../context/ToastContext';
import { formatCurrency } from '../lib/format';
import { getBackendConfig } from '../services/backend/config';
import { Icon } from './Icon';
import { ProductArtwork } from './ProductArtwork';

export function ProductCard({ product }: { product: Product }) {
  const { addItem } = useCart();
  const { showToast } = useToast();
  const live = getBackendConfig().enabled;
  const units = typeof product.availableUnits === 'number' ? product.availableUnits : null;

  const handleAdd = () => {
    if (!product.available) return;
    const added = addItem(product.id);
    if (added) showToast(`${product.name} foi adicionado ao carrinho.`);
  };

  return (
    <article className="product-card">
      <Link className="product-card__art-link" to={`/produto/${product.slug}`} aria-label={`Ver detalhes de ${product.name}`}>
        <ProductArtwork product={product} />
      </Link>
      <div className="product-card__body">
        <div className="product-card__meta">
          <span className="eyebrow-label">{product.categoryLabel || getCategoryLabel(product.categoryId)}</span>
          {live && !product.isDemo ? (
            <span className="demo-tag demo-tag--muted">{product.available ? 'DISPONÍVEL' : 'ESGOTADO'}</span>
          ) : (
            <span className="demo-tag">DEMO</span>
          )}
        </div>
        <h3 className="product-card__title"><Link to={`/produto/${product.slug}`}>{product.name}</Link></h3>
        <p className="product-card__description">{product.shortDescription}</p>
        <p className="product-card__plan">
          {product.modality || 'Produto digital'} <span aria-hidden="true">·</span> {product.period || 'acesso imediato'}
        </p>
        <div className="product-card__price-row">
          <span className="product-card__price">{formatCurrency(product.priceCents)}</span>
          <span className="price-caption">
            {live
              ? product.available
                ? `${units ?? 0} unidade(s) disponível(is)`
                : 'sem unidades disponíveis'
              : 'valor ilustrativo'}
          </span>
        </div>
        <div className="product-card__actions">
          <Link className="button button--secondary button--small" to={`/produto/${product.slug}`}>Detalhes</Link>
          <button className="button button--primary button--small product-card__add" type="button" onClick={handleAdd} disabled={!product.available}>
            <span>{product.available ? 'Adicionar' : 'Esgotado'}</span>
            {product.available && <Icon name="arrow-right" size={16} />}
          </button>
        </div>
      </div>
    </article>
  );
}
