import { Link } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { OrderSummary } from '../components/OrderSummary';
import { ProductArtwork } from '../components/ProductArtwork';
import { QuantityControl } from '../components/QuantityControl';
import { useCart } from '../context/CartContext';
import { useToast } from '../context/ToastContext';
import { formatCurrency } from '../lib/format';

export function CartPage() {
  const { lines, subtotalCents, totalCents, setQuantity, removeItem } = useCart();
  const { showToast } = useToast();

  if (lines.length === 0) {
    return (
      <section className="container page-section cart-page">
        <div className="page-heading"><span className="eyebrow-label">SUA SELEÇÃO</span><h1>Carrinho</h1><p>Revise os itens antes de seguir para o checkout demonstrativo.</p></div>
        <EmptyState title="Seu carrinho está vazio" description="Explore o catálogo e adicione produtos demonstrativos para testar o fluxo." actionLabel="Explorar catálogo" to="/produtos" icon="cart" />
      </section>
    );
  }

  const handleRemove = (productName: string, productId: string) => {
    removeItem(productId);
    showToast(`${productName} foi removido do carrinho.`);
  };

  return (
    <section className="container page-section cart-page">
      <div className="page-heading"><span className="eyebrow-label">SUA SELEÇÃO</span><h1>Carrinho</h1><p>Confira quantidades e valores ilustrativos antes de continuar.</p></div>
      <div className="cart-layout">
        <div className="cart-items" aria-label="Itens do carrinho">
          {lines.map((line) => (
            <article className="cart-item" key={line.productId}>
              <Link to={`/produto/${line.product.slug}`} className="cart-item__art" aria-label={`Ver ${line.product.name}`}><ProductArtwork product={line.product} /></Link>
              <div className="cart-item__main">
                <div className="cart-item__title-row"><h2><Link to={`/produto/${line.product.slug}`}>{line.product.name}</Link></h2><button className="remove-item-button" type="button" onClick={() => handleRemove(line.product.name, line.productId)} aria-label={`Remover ${line.product.name} do carrinho`}><Icon name="close" size={18} /><span>Remover</span></button></div>
                <p className="cart-item__plan">{line.product.modality} · {line.product.period}</p>
                <div className="cart-item__bottom">
                  <div className="cart-item__quantity"><span className="cart-item__label">Quantidade</span>{line.product.allowQuantity ? <QuantityControl value={line.quantity} max={line.product.maxQuantity ?? 10} label={`quantidade de ${line.product.name}`} onChange={(quantity) => setQuantity(line.productId, quantity)} /> : <span className="fixed-quantity">1 <small>(fixa)</small></span>}</div>
                  <div className="cart-item__prices"><span>{formatCurrency(line.unitPriceCents)} <small>un.</small></span><strong>{formatCurrency(line.subtotalCents)}</strong></div>
                </div>
              </div>
            </article>
          ))}
          <Link className="text-link text-link--arrow cart-continue" to="/produtos"><Icon name="arrow-right" size={17} className="back-arrow" />Continuar comprando</Link>
        </div>
        <div className="cart-summary-column">
          <OrderSummary lines={lines} subtotalCents={subtotalCents} totalCents={totalCents} />
          <Link className="button button--primary button--large cart-checkout-button" to="/checkout">Ir para o checkout <Icon name="arrow-right" size={18} /></Link>
          <p className="checkout-reassurance"><Icon name="alert" size={16} />Nenhuma cobrança será feita.</p>
        </div>
      </div>
    </section>
  );
}
