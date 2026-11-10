import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { ProductArtwork } from '../components/ProductArtwork';
import { ProductGrid } from '../components/ProductGrid';
import { QuantityControl } from '../components/QuantityControl';
import { useCart } from '../context/CartContext';
import { useToast } from '../context/ToastContext';
import type { Product } from '../types';
import { fallbackCategoryLabel } from '../data/categories';
import { formatCurrency } from '../lib/format';
import { maxOrderableQuantity } from '../lib/cart';
import { useCatalog } from '../context/CatalogContext';
import { catalogService } from '../services/catalogService';

export function ProductPage() {
  const { slug } = useParams();
  const { products, status, error, reload } = useCatalog();
  const product = slug ? products.find((item) => item.slug === slug) : undefined;
  const [quantity, setQuantity] = useState(1);
  const { addItem } = useCart();
  const { showToast } = useToast();

  // Preço e disponibilidade sempre atualizados ao abrir a página.
  useEffect(() => {
    void catalogService.refresh();
  }, [slug]);

  useEffect(() => setQuantity(1), [slug]);

  if (status === 'loading' && !product) {
    return (
      <section className="container page-section product-not-found">
        <p className="loading-line" role="status"><span className="loading-spinner" aria-hidden="true" />Carregando produto…</p>
      </section>
    );
  }

  if (status === 'error' || status === 'not_configured') {
    return (
      <section className="container page-section product-not-found">
        <div className="catalog-status catalog-status--error" role="alert">
          <span>{error}</span>
          {status === 'error' && (
            <button className="button button--secondary button--small" type="button" onClick={reload}>Tentar novamente</button>
          )}
        </div>
      </section>
    );
  }

  if (!product) {
    return (
      <section className="container page-section product-not-found">
        <nav className="breadcrumbs" aria-label="Trilha de navegação"><Link to="/">Início</Link><span aria-hidden="true">/</span><Link to="/produtos">Catálogo</Link><span aria-hidden="true">/</span><span>Produto</span></nav>
        <EmptyState title="Produto não encontrado" description="Este endereço não corresponde a um item do catálogo atual." actionLabel="Voltar ao catálogo" to="/produtos" icon="alert" secondaryAction={{ label: 'Ir para o início', to: '/' }} />
      </section>
    );
  }

  const categoryLabel = product.categoryLabel || fallbackCategoryLabel(product.categoryId);
  const units = typeof product.availableUnits === 'number' ? product.availableUnits : null;
  const quantityLimit = maxOrderableQuantity(product);

  const related = products
    .filter((item: Product) => item.id !== product.id && item.categoryId === product.categoryId)
    .concat(products.filter((item: Product) => item.id !== product.id && item.categoryId !== product.categoryId))
    .slice(0, 3);

  const handleAdd = () => {
    const result = addItem(product.id, quantity);
    if (result.added) showToast(`${product.name} foi adicionado ao carrinho.`);
    else if (result.reason === 'limit_reached') {
      showToast(`O máximo disponível de ${product.name} já está no carrinho.`, 'error');
    } else if (result.reason === 'cart_full') {
      showToast('O pedido já tem o máximo de 10 produtos diferentes. Revise o carrinho antes de adicionar outro.', 'error');
    } else {
      showToast('Este produto ficou indisponível. Atualize o catálogo.', 'error');
    }
  };

  const conditions = product.conditions.length > 0
    ? product.conditions
    : [
        'O pedido registrado é uma solicitação e fica aguardando confirmação da loja.',
        'A disponibilidade pode mudar entre a consulta do catálogo e a confirmação do pedido.',
        'Nenhum pagamento é solicitado ou processado pelo site nesta etapa.',
      ];

  const flowInfo = [
    `Quantidade máxima por pedido: ${product.allowQuantity ? quantityLimit : 1}.`,
    units !== null ? `Unidades disponíveis agora: ${units}.` : 'Disponibilidade confirmada no servidor ao enviar o pedido.',
    product.period ? `Período informado no catálogo: ${product.period}.` : 'Período de acesso não informado pelo cadastro.',
    product.instructions ? `Instruções: ${product.instructions}` : 'Instruções de uso são enviadas após a confirmação do pedido.',
  ];

  return (
    <>
      <section className="container page-section product-detail-page">
        <nav className="breadcrumbs" aria-label="Trilha de navegação">
          <Link to="/">Início</Link><span aria-hidden="true">/</span><Link to="/produtos">Catálogo</Link><span aria-hidden="true">/</span><Link to={`/produtos?categoria=${encodeURIComponent(product.categoryId)}`}>{categoryLabel}</Link><span aria-hidden="true">/</span><span aria-current="page">{product.name}</span>
        </nav>

        <div className="product-detail">
          <div className="product-detail__art"><ProductArtwork product={product} size="detail" /></div>
          <div className="product-detail__content">
            <span className="eyebrow-label">
              {categoryLabel} <span aria-hidden="true">·</span>{' '}
              <span className={product.available ? 'product-detail__availability' : 'product-detail__availability product-detail__availability--out'}>
                {product.available ? 'DISPONÍVEL' : 'INDISPONÍVEL'}
              </span>
            </span>
            <h1>{product.name}</h1>
            <p className="product-detail__lead">{product.description || product.shortDescription}</p>
            <div className="product-detail__plan">
              <span>Modalidade</span><strong>{product.modality || 'Produto digital'}</strong>
              <span>Período</span><strong>{product.period || 'não informado'}</strong>
            </div>
            <div className="product-detail__price-block">
              <span>Preço</span>
              <strong>{formatCurrency(product.priceCents)}</strong>
              <small>
                {product.available
                  ? `${units ?? 0} unidade(s) disponível(is) agora`
                  : 'Sem unidades disponíveis no momento'}
              </small>
            </div>
            {product.available && product.allowQuantity && (
              <div className="product-detail__quantity">
                <span>Quantidade</span>
                <QuantityControl value={quantity} max={quantityLimit} label="quantidade do produto" onChange={setQuantity} />
                {quantityLimit > 1 && <small className="field-hint">Máximo de {quantityLimit} unidade(s) por pedido.</small>}
              </div>
            )}
            {!product.available && (
              <p className="availability-note">Este produto está sem unidades. Ele continua no catálogo, mas não pode ser solicitado.</p>
            )}
            <div className="product-detail__actions">
              <button className="button button--primary button--large" type="button" onClick={handleAdd} disabled={!product.available}>
                {product.available ? 'Adicionar ao carrinho' : 'Indisponível'}<Icon name="arrow-right" size={18} />
              </button>
              <Link className="button button--secondary button--large" to="/produtos">Continuar comprando</Link>
            </div>
            <div className="product-detail__notice">
              <Icon name="alert" size={18} />
              <p>
                O preço exibido é o preço do catálogo e é reconferido no servidor ao enviar o pedido.
                Nenhum pagamento é feito pelo site: a solicitação fica aguardando confirmação.
              </p>
            </div>
          </div>
        </div>

        <div className="product-detail__information">
          <section className="info-panel" aria-labelledby="conditions-heading">
            <span className="eyebrow-label">ANTES DE CONTINUAR</span><h2 id="conditions-heading">Condições e limitações</h2>
            <ul>{conditions.map((condition) => <li key={condition}>{condition}</li>)}</ul>
          </section>
          <section className="info-panel" aria-labelledby="delivery-heading">
            <span className="eyebrow-label">DADOS DO CADASTRO</span><h2 id="delivery-heading">Informações do produto</h2>
            <ul>{flowInfo.map((item) => <li key={item}>{item}</li>)}</ul>
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
