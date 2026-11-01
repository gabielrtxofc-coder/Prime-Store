import { Link, Navigate } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { readLastRequestReceipt } from '../services/requestService';

/**
 * Compatibilidade de endereço.
 *
 * `/pedido-confirmado` era a tela do pedido demonstrativo (registro em memória).
 * Agora a confirmação é persistida no servidor e vive em `/pedido/:id`, então
 * este endereço apenas encaminha para o último pedido registrado neste
 * navegador — ou explica como consultar um pedido antigo.
 */
export function OrderConfirmedPage() {
  const last = readLastRequestReceipt();
  if (last) return <Navigate to={`/pedido/${last.orderId}`} replace />;

  return (
    <section className="container page-section order-confirmation-page">
      <div className="page-heading"><span className="eyebrow-label">CONFIRMAÇÃO</span><h1>Pedido</h1></div>
      <EmptyState
        title="Nenhum pedido recente neste navegador"
        description="A confirmação aparece logo depois de enviar a solicitação. Para consultar um pedido anterior, use o número e o código de acompanhamento."
        actionLabel="Acompanhar pedido"
        to="/acompanhar"
        icon="alert"
        secondaryAction={{ label: 'Ir para o catálogo', to: '/produtos' }}
      />
      <p className="confirmation-catalog-link">
        Não sabe o código? <Link to="/ajuda">Fale com o atendimento</Link>.
      </p>
    </section>
  );
}
