import type { CartLine } from '../types';
import { formatCurrency } from '../lib/format';

interface OrderSummaryProps {
  lines: CartLine[];
  subtotalCents: number;
  totalCents: number;
  paymentLabel?: string;
}

export function OrderSummary({ lines, subtotalCents, totalCents, paymentLabel }: OrderSummaryProps) {
  const itemCount = lines.reduce((count, line) => count + line.quantity, 0);

  return (
    <aside className="order-summary" aria-labelledby="order-summary-title">
      <div className="order-summary__heading">
        <div>
          <span className="eyebrow-label">Pedido demonstrativo</span>
          <h2 id="order-summary-title">Resumo do pedido</h2>
        </div>
        <span className="order-summary__count">{itemCount} {itemCount === 1 ? 'item' : 'itens'}</span>
      </div>
      {lines.length ? (
        <ul className="order-summary__items">
          {lines.map((line) => (
            <li className="order-summary__item" key={line.productId}>
              <div className="order-summary__item-copy">
                <strong>{line.product.name}</strong>
                <span>{line.product.modality} · {line.product.period}</span>
                <small>{line.quantity} × {formatCurrency(line.unitPriceCents)}</small>
              </div>
              <strong className="order-summary__line-price">{formatCurrency(line.subtotalCents)}</strong>
            </li>
          ))}
        </ul>
      ) : (
        <p className="order-summary__empty">Nenhum produto selecionado.</p>
      )}
      <div className="order-summary__totals">
        <div className="price-row"><span>Subtotal ilustrativo</span><span>{formatCurrency(subtotalCents)}</span></div>
        <div className="price-row price-row--total"><span>Total demonstrativo</span><strong>{formatCurrency(totalCents)}</strong></div>
      </div>
      {paymentLabel && <p className="order-summary__payment">Método selecionado: <strong>{paymentLabel}</strong></p>}
      <p className="order-summary__note">Sem taxas ou descontos nesta simulação. Nenhum pagamento será processado.</p>
    </aside>
  );
}
