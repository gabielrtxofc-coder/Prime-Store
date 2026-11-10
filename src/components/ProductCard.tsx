import { Link } from 'react-router-dom';
import type { Product } from '../types';
import { fallbackCategoryLabel } from '../data/categories';
import { useCart } from '../context/CartContext';
import { useToast } from '../context/ToastContext';
import { formatCurrency } from '../lib/format';
import { Icon } from './Icon';
import { ProductArtwork } from './ProductArtwork';

export function ProductCard({ product }: { product: Product }) {
  const { addItem } = useCart();
  const { showToast } = useToast();
  const units = typeof product.availableUnits === 'number' ? product.availableUnits : null;

  const handleAdd = () => {
    if (!product.available) return;
    const result = addItem(product.id);
    if (result.added) showToast(`${product.name} foi adicionado ao carrinho.`);
    else if (result.reason === 'limit_reached') {
      showToast(`Você já tem o máximo disponível de ${product.name} no carrinho.`, 'error');
    } else if (result.reason === 'cart_full') {
      showToast('O pedido já tem o máximo de 10 produtos diferentes. Revise o carrinho antes de adicionar outro.', 'error');
    } else {
      showToast('Este produto ficou indisponível. Atualize o catálogo.', 'error');
    }
  };

  return (
    <article className="product-card">
      <Link className="product-card__art-link" to={`/produto/${product.slug}`} aria-label={`Ver detalhes de ${product.name}`}>
        <ProductArtwork product={product} />
      </Link>
      <div className="product-card__body">
        <div className="product-card__meta">
          <span className="eyebrow-label">{product.categoryLabel || fallbackCategoryLabel(product.categoryId)}</span>
          <span className={`availability-badge${product.available ? '' : ' availability-badge--out'}`}>
            {product.available ? 'DISPONÍVEL' : 'INDISPONÍVEL'}
          </span>
        </div>
        <h3 className="product-card__title"><Link to={`/produto/${product.slug}`}>{product.name}</Link></h3>
        <p className="product-card__description">{product.shortDescription}</p>
        <p className="product-card__plan">
          {product.modality || 'Produto digital'} <span aria-hidden="true">·</span> {product.period || 'acesso imediato'}
        </p>
        <div className="product-card__price-row">
          <span className="product-card__price">{formatCurrency(product.priceCents)}</span>
          <span className="price-caption">
            {product.available
              ? `${units ?? 0} unidade(s) disponível(is)`
              : 'sem unidades disponíveis'}
          </span>
        </div>
        <div className="product-card__actions">
          <Link className="button button--secondary button--small" to={`/produto/${product.slug}`}>Detalhes</Link>
          <button
            className="button button--primary button--small product-card__add"
            type="button"
            onClick={handleAdd}
            disabled={!product.available}
            aria-label={product.available ? `Adicionar ${product.name} ao carrinho` : `${product.name} indisponível`}
          >
            <span>{product.available ? 'Adicionar' : 'Indisponível'}</span>
            {product.available && <Icon name="arrow-right" size={16} />}
          </button>
        </div>
      </div>
    </article>
  );
}
