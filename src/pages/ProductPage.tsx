import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { ProductArtwork } from '../components/ProductArtwork';
import { ProductGrid } from '../components/ProductGrid';
import { QuantityControl } from '../components/QuantityControl';
import { useCart } from '../context/CartContext';
import type { Product } from '../types';
import { useToast } from '../context/ToastContext';
import { getCategoryLabel } from '../data/products';
import { formatCurrency } from '../lib/format';
import { useCatalog } from '../context/CatalogContext';
import { getBackendConfig } from '../services/backend/config';

export function ProductPage() {
  const { slug } = useParams();
  const { products } = useCatalog();
  const backendEnabled = getBackendConfig().enabled;
  const product = slug ? products.find((item) => item.slug === slug) : undefined;
  const [quantity, setQuantity] = useState(1);
  const { addItem } = useCart();
  const { showToast } = useToast();

  useEffect(() => setQuantity(1), [slug]);

  if (!product) {
    return (
      <section className="container page-section product-not-found">
        <nav className="breadcrumbs" aria-label="Trilha de navegação"><Link to="/">Início</Link><span aria-hidden="true">/</span><Link to="/produtos">Catálogo</Link><span aria-hidden="true">/</span><span>Produto</span></nav>
        <EmptyState title="Produto não encontrado" description="Este endereço não corresponde a um item do catálogo atual." actionLabel="Voltar ao catálogo" to="/produtos" icon="alert" secondaryAction={{ label: 'Ir para o início', to: '/' }} />
      </section>
    );
  }

  const related = products
    .filter((item: Product) => item.id !== product.id && item.categoryId === product.categoryId)
    .concat(products.filter((item: Product) => item.id !== product.id && item.categoryId !== product.categoryId))
    .slice(0, 3);

  const handleAdd = () => {
    const added = addItem(product.id, quantity);
    if (added) showToast(`${product.name} foi adicionado ao carrinho.`);
    else showToast('Este produto não está disponível no protótipo.', 'error');
  };

  return (
    <>
      <section className="container page-section product-detail-page">
        <nav className="breadcrumbs" aria-label="Trilha de navegação">
          <Link to="/">Início</Link><span aria-hidden="true">/</span><Link to="/produtos">Catálogo</Link><span aria-hidden="true">/</span><Link to={`/produtos?categoria=${encodeURIComponent(product.categoryId)}`}>{getCategoryLabel(product.categoryId)}</Link><span aria-hidden="true">/</span><span aria-current="page">{product.name}</span>
        </nav>

        <div className="product-detail">
          <div className="product-detail__art"><ProductArtwork product={product} size="detail" /></div>
          <div className="product-detail__content">
            <span className="eyebrow-label">{getCategoryLabel(product.categoryId)} <span aria-hidden="true">·</span> {backendEnabled ? (product.available ? 'DISPONÍVEL' : 'ESGOTADO') : 'ITEM DEMONSTRATIVO'}</span>
            <h1>{product.name}</h1>
            <p className="product-detail__lead">{product.description}</p>
            <div className="product-detail__plan"><span>Modalidade</span><strong>{product.modality}</strong><span>Período</span><strong>{product.period}</strong></div>
            <div className="product-detail__price-block"><span>{backendEnabled ? 'Preço' : 'Preço demonstrativo'}</span><strong>{formatCurrency(product.priceCents)}</strong><small>{backendEnabled ? `${product.availableUnits ?? 0} unidade(s) disponível(is)` : 'Valor meramente ilustrativo, sem cobrança.'}</small></div>
            {product.allowQuantity && (
              <div className="product-detail__quantity"><span>Quantidade</span><QuantityControl value={quantity} max={product.maxQuantity ?? 10} label="quantidade do produto" onChange={setQuantity} /></div>
            )}
            {!product.available && <p className="availability-note">Este item está indisponível na demonstração.</p>}
            <div className="product-detail__actions">
              <button className="button button--primary button--large" type="button" onClick={handleAdd} disabled={!product.available}>
                {product.available ? 'Adicionar ao carrinho' : 'Indisponível'}<Icon name="arrow-right" size={18} />
              </button>
              <Link className="button button--secondary button--large" to="/produtos">Continuar comprando</Link>
            </div>
            <div className="product-detail__notice"><Icon name="alert" size={18} /><p>Este produto é apenas uma referência de interface. Não há parceria declarada, pagamento, acesso ou entrega real.</p></div>
          </div>
        </div>

        <div className="product-detail__information">
          <section className="info-panel" aria-labelledby="conditions-heading">
            <span className="eyebrow-label">ANTES DE CONTINUAR</span><h2 id="conditions-heading">Condições e limitações</h2>
            <ul>{product.conditions.map((condition) => <li key={condition}>{condition}</li>)}</ul>
          </section>
          <section className="info-panel" aria-labelledby="delivery-heading">
            <span className="eyebrow-label">INFORMAÇÕES DO FLUXO</span><h2 id="delivery-heading">{backendEnabled ? 'Entrega após o pagamento' : 'Entrega demonstrativa'}</h2>
            <ul>{product.delivery.map((item) => <li key={item}>{item}</li>)}</ul>
          </section>
        </div>
      </section>

      {related.length > 0 && (
        <section className="section-block related-section" aria-labelledby="related-heading">
          <div className="container"><div className="section-heading section-heading--row"><div><span className="eyebrow-label">CONTINUE EXPLORANDO</span><h2 id="related-heading">Outros itens do catálogo</h2></div><Link className="text-link text-link--arrow" to="/produtos">Ver todos <Icon name="arrow-right" size={17} /></Link></div><ProductGrid products={related} /></div>
        </section>
      )}
    </>
  );
}
