import { Link } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { useDemoOrder } from '../context/OrderContext';
import { formatCurrency } from '../lib/format';

export function OrderConfirmedPage() {
  const { currentOrder } = useDemoOrder();

  if (!currentOrder) {
    return (
      <section className="container page-section order-confirmation-page">
        <div className="page-heading"><span className="eyebrow-label">CONFIRMAÇÃO</span><h1>Pedido demonstrativo</h1></div>
        <EmptyState title="Nenhum pedido nesta sessão" description="A confirmação só aparece depois de concluir um checkout demonstrativo. Nenhuma compra foi feita." actionLabel="Voltar ao catálogo" to="/produtos" icon="alert" secondaryAction={{ label: 'Ir para o início', to: '/' }} />
      </section>
    );
  }

  return (
    <section className="container page-section order-confirmation-page">
      <div className="confirmation-card">
        <div className="confirmation-card__success-icon"><Icon name="check" size={32} /></div>
        <span className="eyebrow-label">FLUXO DE TESTE CONCLUÍDO</span>
        <h1>Pedido demonstrativo criado</h1>
        <p className="confirmation-card__lead">Obrigado, {currentOrder.buyerName}. Este registro existe somente nesta sessão da aplicação.</p>
        <div className="payment-warning" role="note"><Icon name="alert" size={19} /><p><strong>Nenhum pagamento real foi efetuado.</strong> O método selecionado não foi processado e nenhum produto ou acesso será entregue.</p></div>

        <div className="confirmation-meta">
          <div><span>Identificador fictício</span><strong className="confirmation-order-id">{currentOrder.id}</strong></div>
          <div><span>Nome informado</span><strong>{currentOrder.buyerName}</strong></div>
          <div><span>E-mail informado</span><strong>{currentOrder.buyerEmail}</strong></div>
          <div><span>Método selecionado</span><strong>{currentOrder.paymentMethod === 'pix' ? 'PIX (somente visual)' : 'Cartão de crédito (somente visual)'}</strong></div>
        </div>

        <div className="confirmation-summary">
          <div className="confirmation-summary__heading"><h2>Resumo do pedido</h2><span>DEMONSTRAÇÃO</span></div>
          <ul>
            {currentOrder.lines.map((line) => (
              <li key={line.productId}>
                <div><strong>{line.name}</strong><span>{line.modality} · {line.period} · qtd. {line.quantity}</span></div>
                <strong>{formatCurrency(line.subtotalCents)}</strong>
              </li>
            ))}
          </ul>
          <div className="confirmation-total"><span>Total ilustrativo</span><strong>{formatCurrency(currentOrder.totalCents)}</strong></div>
        </div>
        <Link className="button button--primary button--large confirmation-store-button" to="/">Voltar à loja <Icon name="arrow-right" size={18} /></Link>
        <Link className="confirmation-catalog-link" to="/produtos">Continuar explorando o catálogo</Link>
      </div>
    </section>
  );
}
