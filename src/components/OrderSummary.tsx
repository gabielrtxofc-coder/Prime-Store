import type { CartLine } from '../types';
import { formatCurrency } from '../lib/format';

interface OrderSummaryProps {
  lines: CartLine[];
  subtotalCents: number;
  totalCents: number;
  /** Texto curto exibido acima dos itens (ex.: "Revise antes de enviar"). */
  caption?: string;
  /** Rótulo do total; o padrão é "Total". */
  totalLabel?: string;
}

export function OrderSummary({ lines, subtotalCents, totalCents, caption, totalLabel = 'Total' }: OrderSummaryProps) {
  const itemCount = lines.reduce((count, line) => count + line.quantity, 0);

  return (
    <aside className="order-summary" aria-labelledby="order-summary-title">
      <div className="order-summary__heading">
        <div>
          <span className="eyebrow-label">Resumo</span>
          <h2 id="order-summary-title">Resumo da solicitação</h2>
        </div>
        <span className="order-summary__count">{itemCount} {itemCount === 1 ? 'item' : 'itens'}</span>
      </div>
      {lines.length ? (
        <ul className="order-summary__items">
          {lines.map((line) => (
            <li className="order-summary__item" key={line.productId}>
              <div className="order-summary__item-copy">
                <strong>{line.product.name}</strong>
                <span>{line.product.modality || 'Produto digital'} · {line.product.period || 'acesso imediato'}</span>
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
        <div className="price-row"><span>Subtotal</span><span>{formatCurrency(subtotalCents)}</span></div>
        <div className="price-row price-row--total"><span>{totalLabel}</span><strong>{formatCurrency(totalCents)}</strong></div>
      </div>
      {caption && <p className="order-summary__note">{caption}</p>}
      <p className="order-summary__note">
        O valor final é conferido no servidor com o preço atual do catálogo. Nenhum pagamento é feito pelo site.
      </p>
    </aside>
  );
}
