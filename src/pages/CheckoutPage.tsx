import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { OrderSummary } from '../components/OrderSummary';
import { EmptyState } from '../components/EmptyState';
import { MAX_DISTINCT_PRODUCTS, useCart } from '../context/CartContext';
import { useToast } from '../context/ToastContext';
import { validateCheckout, type CheckoutField, type CheckoutValues } from '../lib/validation';
import { formatCurrency } from '../lib/format';
import { describeBackendError, BackendError } from '../services/backend/http';
import { getBackendConfig } from '../services/backend/config';
import { catalogService } from '../services/catalogService';
import { newClientToken, newIdempotencyKey, savePendingOrder } from '../services/orderService';
import { saveRequestReceipt } from '../services/requestService';
import { submitCheckout } from '../services/checkoutService';

/**
 * ETAPA FINAL — checkout com cobrança PIX real (WyviPay) e fallback para
 * solicitação sem pagamento.
 *
 * O envio usa o fluxo multi-item do servidor (`create-order`): o pedido nasce
 * com reserva de estoque e a cobrança PIX é criada na mesma tentativa. Quando
 * NENHUM provedor está configurado, o próprio servidor registra a solicitação
 * sem pagamento (mesmo contrato de `order-request`) — a loja continua
 * funcionando sem chave, sem reserva presa e sem pedido morto.
 *
 * Resultado do envio:
 *   - `kind: 'payment'` → salva o pedido pendente e vai para `/pagamento`
 *     (QR Code + copia-e-cola);
 *   - `kind: 'request'` → confirmação clássica em `/pedido/:id`.
 */
export function CheckoutPage() {
  const navigate = useNavigate();
  const backendEnabled = getBackendConfig().enabled;
  const { lines, entries, unavailableItems, subtotalCents, totalCents, clearCart } = useCart();
  const { showToast } = useToast();

  /**
   * Identidade da tentativa: reenviar o formulário (duplo clique, queda de
   * rede, reload) repete a MESMA requisição e o banco devolve o pedido já
   * criado, em vez de abrir uma segunda solicitação.
   */
  const [attempt, setAttempt] = useState(() => ({
    idempotencyKey: newIdempotencyKey(),
    clientToken: newClientToken(),
  }));

  const [values, setValues] = useState<CheckoutValues>({
    fullName: '',
    email: '',
    confirmEmail: '',
    acceptedTerms: false,
  });
  const [touched, setTouched] = useState<Partial<Record<CheckoutField, boolean>>>({});
  const [attempted, setAttempted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submitLock = useRef(false);

  // Reconfere preço e disponibilidade ao entrar na etapa final.
  useEffect(() => {
    void catalogService.refresh();
  }, []);

  const errors = useMemo(() => validateCheckout(values, lines.length === 0), [values, lines.length]);
  // Carrinho legado pode ter mais produtos do que o servidor aceita (10): sem
  // este bloqueio o envio terminaria em 422 genérico do backend.
  const tooManyItems = lines.length > MAX_DISTINCT_PRODUCTS;
  const isValid = Object.keys(errors).length === 0 && lines.length > 0 && !tooManyItems;

  const updateValue = (field: keyof CheckoutValues, value: string | boolean) => {
    setValues((previous) => ({ ...previous, [field]: value }));
  };
  const markTouched = (field: CheckoutField) => setTouched((previous) => ({ ...previous, [field]: true }));
  const visibleError = (field: CheckoutField) => (attempted || touched[field] ? errors[field] : undefined);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAttempted(true);
    setSubmitError(null);
    if (submitLock.current || !isValid) return;

    submitLock.current = true;
    setIsSubmitting(true);
    try {
      const outcome = await submitCheckout({
        items: lines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
        buyerName: values.fullName.trim(),
        buyerEmail: values.email.trim(),
        idempotencyKey: attempt.idempotencyKey,
        clientToken: attempt.clientToken,
      });

      if (outcome.kind === 'payment') {
        const { result } = outcome;
        const createdAt = result.order.created_at ?? new Date().toISOString();
        // Pedido pendente: a tela de pagamento reabre por este registro mesmo
        // depois de recarregar (sessionStorage) — e o comprovante permite
        // consultá-lo depois pelo número + código de acompanhamento.
        savePendingOrder({
          orderId: result.order.order_id,
          clientToken: result.client_token,
          reference: result.order.reference,
          createdAt,
        });
        saveRequestReceipt({
          orderId: result.order.order_id,
          reference: result.order.reference,
          clientToken: result.client_token,
          createdAt,
          totalCents: result.order.total_cents,
          itemsCount: result.order.items_count ?? lines.length,
        });
        clearCart();
        navigate('/pagamento');
        return;
      }

      const { result } = outcome;
      saveRequestReceipt({
        orderId: result.order.order_id,
        reference: result.order.reference,
        clientToken: result.client_token,
        createdAt: result.order.created_at ?? new Date().toISOString(),
        totalCents: result.order.total_cents,
        itemsCount: result.order.items_count,
      });

      clearCart();
      navigate(`/pedido/${result.order.order_id}`);
    } catch (error) {
      // Pedido recusado por estoque/produto: o catálogo pode ter mudado.
      void catalogService.refresh();

      if (
        error instanceof BackendError &&
        (error.code === 'insufficient_stock' ||
          error.code === 'product_unavailable' ||
          error.code === 'idempotency_conflict')
      ) {
        const message =
          error.code === 'insufficient_stock'
            ? describeBackendError(error)
            : error.code === 'product_unavailable'
              ? 'Um dos produtos não está mais disponível. Revise o carrinho.'
              : 'Esta tentativa já foi usada com outros dados. Enviaremos uma nova solicitação.';
        setSubmitError(message);
        showToast(message, 'error');
        // Nova tentativa depois de ajustar o carrinho precisa de nova chave:
        // a anterior já foi consumida por um pedido possivelmente recusado ou
        // por uma identidade divergente (idempotency_conflict). Sem renovar,
        // o reenvio cairia sempre no mesmo conflito.
        setAttempt({ idempotencyKey: newIdempotencyKey(), clientToken: newClientToken() });
      } else {
        // Falha de rede/servidor: mantém a identidade para que o reenvio seja
        // idempotente e não duplique a solicitação se a primeira tiver entrado.
        const message = describeBackendError(error);
        setSubmitError(message);
        showToast(message, 'error');
      }
    } finally {
      submitLock.current = false;
      setIsSubmitting(false);
    }
  };

  if (!backendEnabled) {
    return (
      <section className="container page-section checkout-page">
        <div className="page-heading">
          <span className="eyebrow-label">FINALIZAR</span>
          <h1>Loja sem conexão com o servidor</h1>
          <p>Sem o backend não é possível registrar um pedido de verdade.</p>
        </div>
        <EmptyState
          title="Não é possível finalizar agora"
          description="O catálogo e os pedidos dependem do servidor da loja, que não está configurado neste ambiente. Nenhum pedido foi criado."
          actionLabel="Voltar ao catálogo"
          to="/produtos"
          icon="alert"
          secondaryAction={{ label: 'Ir para o início', to: '/' }}
        />
      </section>
    );
  }

  if (lines.length === 0 && unavailableItems.length === 0) {
    return (
      <section className="container page-section checkout-page">
        <div className="page-heading"><span className="eyebrow-label">FINALIZAR</span><h1>Finalizar pedido</h1><p>É preciso ter ao menos um item disponível no carrinho.</p></div>
        <EmptyState title="Seu carrinho está vazio" description="Adicione um produto antes de enviar a solicitação." actionLabel="Explorar catálogo" to="/produtos" icon="cart" secondaryAction={{ label: 'Voltar ao carrinho', to: '/carrinho' }} />
      </section>
    );
  }

  if (lines.length === 0) {
    return (
      <section className="container page-section checkout-page">
        <div className="page-heading"><span className="eyebrow-label">FINALIZAR</span><h1>Nenhum item disponível</h1><p>Os itens do carrinho ficaram indisponíveis.</p></div>
        <EmptyState
          title="Revise o carrinho"
          description="Nenhum item do carrinho está disponível para pedido agora. Remova os itens indisponíveis ou escolha outros produtos."
          actionLabel="Ir para o carrinho"
          to="/carrinho"
          icon="alert"
          secondaryAction={{ label: 'Explorar catálogo', to: '/produtos' }}
        />
      </section>
    );
  }

  const inputClass = (field: CheckoutField) => `form-control${visibleError(field) ? ' has-error' : ''}`;
  const itemsInCart = entries.length;
  const ignoredItems = itemsInCart - lines.length;

  return (
    <section className="container page-section checkout-page">
      <div className="page-heading checkout-heading">
        <span className="eyebrow-label">ETAPA FINAL</span>
        <h1>Finalizar pedido</h1>
        <p>Confira os itens e informe seus dados para seguir para a próxima etapa.</p>
      </div>

      {ignoredItems > 0 && (
        <div className="catalog-status catalog-status--error cart-alert" role="alert">
          <div>
            <strong>{ignoredItems} item(ns) do carrinho ficaram indisponíveis</strong>
            <p>Eles não entram nesta solicitação. <Link to="/carrinho">Revise o carrinho</Link>.</p>
          </div>
        </div>
      )}

      {tooManyItems && (
        <div className="catalog-status catalog-status--error cart-alert" role="alert">
          <div>
            <strong>Máximo de {MAX_DISTINCT_PRODUCTS} produtos diferentes por solicitação</strong>
            <p>
              Seu carrinho tem {lines.length} produtos disponíveis. Remova ao menos{' '}
              {lines.length - MAX_DISTINCT_PRODUCTS} para enviar.{' '}
              <Link to="/carrinho">Revise o carrinho</Link>.
            </p>
          </div>
        </div>
      )}

      <div className="checkout-layout">
        <form className="checkout-form" onSubmit={handleSubmit} noValidate aria-busy={isSubmitting}>
          <section className="checkout-section" aria-labelledby="review-section-heading">
            <div className="checkout-section__heading">
              <span className="checkout-step">01</span>
              <div>
                <h2 id="review-section-heading">Revise os itens</h2>
                <p>{lines.length === 1 ? '1 produto' : `${lines.length} produtos`} · valor conferido no servidor ao enviar.</p>
              </div>
            </div>
            <ul className="checkout-review-list">
              {lines.map((line) => (
                <li key={line.productId}>
                  <span>
                    <strong>{line.product.name}</strong>
                    <small>{line.quantity} × {formatCurrency(line.unitPriceCents)}</small>
                  </span>
                  <strong>{formatCurrency(line.subtotalCents)}</strong>
                </li>
              ))}
            </ul>
            <p className="checkout-review-total">
              <span>Total</span><strong>{formatCurrency(totalCents)}</strong>
            </p>
            <Link className="text-button" to="/carrinho">Alterar quantidades no carrinho</Link>
          </section>

          <section className="checkout-section" aria-labelledby="buyer-section-heading">
            <div className="checkout-section__heading">
              <span className="checkout-step">02</span>
              <div>
                <h2 id="buyer-section-heading">Seus dados</h2>
                <p>Usamos nome e e-mail para identificar o pedido e o contato sobre a confirmação.</p>
              </div>
            </div>
            <div className="form-grid">
              <div className="form-field form-field--full">
                <label htmlFor="buyer-full-name">Nome completo</label>
                <input
                  className={inputClass('fullName')}
                  id="buyer-full-name"
                  name="name"
                  autoComplete="name"
                  value={values.fullName}
                  onChange={(event) => updateValue('fullName', event.target.value)}
                  onBlur={() => markTouched('fullName')}
                  aria-invalid={Boolean(visibleError('fullName'))}
                  aria-describedby={visibleError('fullName') ? 'buyer-name-error' : undefined}
                  required
                />
                {visibleError('fullName') && <p className="field-error" id="buyer-name-error">{visibleError('fullName')}</p>}
              </div>
              <div className="form-field">
                <label htmlFor="buyer-email">E-mail</label>
                <input
                  className={inputClass('email')}
                  id="buyer-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  value={values.email}
                  onChange={(event) => updateValue('email', event.target.value)}
                  onBlur={() => markTouched('email')}
                  aria-invalid={Boolean(visibleError('email'))}
                  aria-describedby={visibleError('email') ? 'buyer-email-error' : undefined}
                  required
                />
                {visibleError('email') && <p className="field-error" id="buyer-email-error">{visibleError('email')}</p>}
              </div>
              <div className="form-field">
                <label htmlFor="buyer-email-confirm">Confirme seu e-mail</label>
                <input
                  className={inputClass('confirmEmail')}
                  id="buyer-email-confirm"
                  name="email-confirm"
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  value={values.confirmEmail}
                  onChange={(event) => updateValue('confirmEmail', event.target.value)}
                  onBlur={() => markTouched('confirmEmail')}
                  aria-invalid={Boolean(visibleError('confirmEmail'))}
                  aria-describedby={visibleError('confirmEmail') ? 'buyer-email-confirm-error' : undefined}
                  required
                />
                {visibleError('confirmEmail') && <p className="field-error" id="buyer-email-confirm-error">{visibleError('confirmEmail')}</p>}
              </div>
            </div>
          </section>

          <section className="checkout-section checkout-terms-section" aria-labelledby="terms-section-heading">
            <div className="checkout-section__heading">
              <span className="checkout-step">03</span>
              <div>
                <h2 id="terms-section-heading">Confirmar e seguir</h2>
                <p>O pedido é registrado no servidor com os preços e a disponibilidade conferidos lá.</p>
              </div>
            </div>
            <label className={`terms-checkbox${visibleError('acceptedTerms') ? ' has-error' : ''}`}>
              <input
                type="checkbox"
                checked={values.acceptedTerms}
                onChange={(event) => { updateValue('acceptedTerms', event.target.checked); markTouched('acceptedTerms'); }}
                onBlur={() => markTouched('acceptedTerms')}
                aria-invalid={Boolean(visibleError('acceptedTerms'))}
                aria-describedby={visibleError('acceptedTerms') ? 'terms-acceptance-error' : undefined}
              />
              <span>
                Li os <Link to="/termos" target="_blank" rel="noreferrer">termos</Link> e a{' '}
                <Link to="/privacidade" target="_blank" rel="noreferrer">política de privacidade</Link> e confirmo os dados acima.
              </span>
            </label>
            {visibleError('acceptedTerms') && <p className="field-error field-error--terms" id="terms-acceptance-error">{visibleError('acceptedTerms')}</p>}

            {submitError && (
              <p className="checkout-submit-error" role="alert">{submitError}</p>
            )}

            <button className="button button--primary button--large checkout-submit" type="submit" disabled={!isValid || isSubmitting}>
              {isSubmitting ? (
                <><span className="loading-spinner" aria-hidden="true" />Registrando pedido…</>
              ) : (
                <>Finalizar pedido <Icon name="arrow-right" size={18} /></>
              )}
            </button>
            <p className="checkout-submit-note">
              Você recebe um número de pedido e um código de acompanhamento. Se a cobrança estiver
              ativa, o pagamento é feito na etapa seguinte, com QR Code e código copia-e-cola.
            </p>
          </section>
        </form>

        <div className="checkout-summary-column">
          <OrderSummary
            lines={lines}
            subtotalCents={subtotalCents}
            totalCents={totalCents}
            caption="O valor oficial é calculado no servidor ao registrar o pedido."
          />
          <div className="checkout-privacy-note">
            <Icon name="mail" size={17} />
            <p>Nome, e-mail e itens ficam no pedido do servidor. Nenhum dado de pagamento é solicitado.</p>
          </div>
          <Link className="checkout-back-link" to="/carrinho">Voltar ao carrinho</Link>
        </div>
      </div>
    </section>
  );
}
