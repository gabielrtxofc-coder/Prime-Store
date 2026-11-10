import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { OrderSummary } from '../components/OrderSummary';
import { ProductArtwork } from '../components/ProductArtwork';
import { QuantityControl } from '../components/QuantityControl';
import { MAX_DISTINCT_PRODUCTS, useCart } from '../context/CartContext';
import { useToast } from '../context/ToastContext';
import { formatCurrency } from '../lib/format';
import { maxOrderableQuantity } from '../lib/cart';
import { catalogService } from '../services/catalogService';

export function CartPage() {
  const { lines, unavailableItems, priceChanges, subtotalCents, totalCents, setQuantity, removeItem } = useCart();
  const { showToast } = useToast();

  // Revalida preço e disponibilidade ao abrir o carrinho.
  useEffect(() => {
    void catalogService.refresh();
  }, []);

  if (lines.length === 0 && unavailableItems.length === 0) {
    return (
      <section className="container page-section cart-page">
        <div className="page-heading"><span className="eyebrow-label">SUA SELEÇÃO</span><h1>Carrinho</h1><p>Revise os itens antes de enviar a solicitação.</p></div>
        <EmptyState title="Seu carrinho está vazio" description="Explore o catálogo e adicione produtos para montar seu pedido." actionLabel="Explorar catálogo" to="/produtos" icon="cart" />
      </section>
    );
  }

  const handleRemove = (productName: string, productId: string) => {
    removeItem(productId);
    showToast(`${productName} foi removido do carrinho.`);
  };

  return (
    <section className="container page-section cart-page">
      <div className="page-heading"><span className="eyebrow-label">SUA SELEÇÃO</span><h1>Carrinho</h1><p>Confira quantidades e valores antes de continuar. Os preços vêm do catálogo da loja.</p></div>

      {unavailableItems.length > 0 && (
        <div className="catalog-status catalog-status--error cart-alert" role="alert">
          <div>
            <strong>Itens indisponíveis não entram no pedido:</strong>
            <ul>
              {unavailableItems.map((item) => (
                <li key={item.productId}>
                  {item.name} — {item.reason === 'unavailable' ? 'sem unidades no momento' : 'fora do catálogo'}{' '}
                  <button className="text-button" type="button" onClick={() => removeItem(item.productId)}>remover</button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {priceChanges.length > 0 && (
        <div className="catalog-status cart-alert cart-alert--info" role="status">
          <div>
            <strong>O preço mudou desde que você adicionou:</strong>
            <ul>
              {priceChanges.map((change) => (
                <li key={change.productId}>
                  {change.name}: {formatCurrency(change.previousCents)} → <strong>{formatCurrency(change.currentCents)}</strong>
                </li>
              ))}
            </ul>
            <p>O valor usado no pedido é sempre o preço atual do catálogo.</p>
          </div>
        </div>
      )}

      <div className="cart-layout">
        <div className="cart-items" aria-label="Itens do carrinho">
          {lines.map((line) => {
            const limit = maxOrderableQuantity(line.product);
            return (
              <article className="cart-item" key={line.productId}>
                <Link to={`/produto/${line.product.slug}`} className="cart-item__art" aria-label={`Ver ${line.product.name}`}><ProductArtwork product={line.product} /></Link>
                <div className="cart-item__main">
                  <div className="cart-item__title-row"><h2><Link to={`/produto/${line.product.slug}`}>{line.product.name}</Link></h2><button className="remove-item-button" type="button" onClick={() => handleRemove(line.product.name, line.productId)} aria-label={`Remover ${line.product.name} do carrinho`}><Icon name="close" size={18} /><span>Remover</span></button></div>
                  <p className="cart-item__plan">{line.product.modality || 'Produto digital'} · {line.product.period || 'acesso imediato'}</p>
                  <div className="cart-item__bottom">
                    <div className="cart-item__quantity">
                      <span className="cart-item__label">Quantidade</span>
                      {line.product.allowQuantity && limit > 1 ? (
                        <QuantityControl
                          value={line.quantity}
                          max={limit}
                          label={`quantidade de ${line.product.name}`}
                          onChange={(quantity) => setQuantity(line.productId, quantity)}
                        />
                      ) : (
                        <span className="fixed-quantity">1 <small>(fixa)</small></span>
                      )}
                    </div>
                    <div className="cart-item__prices"><span>{formatCurrency(line.unitPriceCents)} <small>un.</small></span><strong>{formatCurrency(line.subtotalCents)}</strong></div>
                  </div>
                  {line.product.allowQuantity && line.quantity >= limit && (
                    <p className="field-hint">Limite atingido para este produto ({limit}).</p>
                  )}
                </div>
              </article>
            );
          })}
          <Link className="text-link text-link--arrow cart-continue" to="/produtos"><Icon name="arrow-right" size={17} className="back-arrow" />Continuar comprando</Link>
        </div>
        <div className="cart-summary-column">
          <OrderSummary lines={lines} subtotalCents={subtotalCents} totalCents={totalCents} />
          {lines.length >= MAX_DISTINCT_PRODUCTS && (
            <p className="checkout-reassurance" role="status">
              <Icon name="alert" size={16} />
              {lines.length > MAX_DISTINCT_PRODUCTS
                ? `Solicitações aceitam no máximo ${MAX_DISTINCT_PRODUCTS} produtos diferentes — remova ${lines.length - MAX_DISTINCT_PRODUCTS} para continuar.`
                : `Seu pedido já tem ${MAX_DISTINCT_PRODUCTS} produtos diferentes, o máximo por solicitação.`}
            </p>
          )}
          {lines.length > 0 ? (
            <Link className="button button--primary button--large cart-checkout-button" to="/checkout">Continuar para finalizar <Icon name="arrow-right" size={18} /></Link>
          ) : (
            <p className="checkout-reassurance"><Icon name="alert" size={16} />Remova os itens indisponíveis ou adicione outro produto para continuar.</p>
          )}
          <p className="checkout-reassurance"><Icon name="alert" size={16} />Nenhum pagamento é feito pelo site.</p>
        </div>
      </div>
    </section>
  );
}
