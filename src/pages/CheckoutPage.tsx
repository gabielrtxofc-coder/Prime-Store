import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { OrderSummary } from '../components/OrderSummary';
import { useCart } from '../context/CartContext';
import { useDemoOrder } from '../context/OrderContext';
import { useToast } from '../context/ToastContext';
import { EmptyState } from '../components/EmptyState';
import { validateCheckout, type CheckoutField, type CheckoutValues } from '../lib/validation';
import { createDemoOrder } from '../services/demoOrderService';
import type { PaymentMethod } from '../types';

const paymentOptions: { id: PaymentMethod; title: string; description: string }[] = [
  { id: 'pix', title: 'PIX', description: 'Seleção visual, sem geração de QR code.' },
  { id: 'card', title: 'Cartão de crédito', description: 'Opção demonstrativa. Não informe dados de cartão.' },
];

export function CheckoutPage() {
  const navigate = useNavigate();
  const { entries, lines, subtotalCents, totalCents, clearCart } = useCart();
  const { setCurrentOrder } = useDemoOrder();
  const { showToast } = useToast();
  const [values, setValues] = useState<CheckoutValues>({ fullName: '', email: '', confirmEmail: '', acceptedTerms: false });
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('pix');
  const [touched, setTouched] = useState<Partial<Record<CheckoutField, boolean>>>({});
  const [attempted, setAttempted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitLock = useRef(false);
  const errors = useMemo(() => validateCheckout(values, lines.length === 0), [values, lines.length]);
  const isValid = Object.keys(errors).length === 0 && lines.length > 0;

  const updateValue = (field: keyof CheckoutValues, value: string | boolean) => {
    setValues((previous) => ({ ...previous, [field]: value }));
  };

  const markTouched = (field: CheckoutField) => setTouched((previous) => ({ ...previous, [field]: true }));
  const visibleError = (field: CheckoutField) => (attempted || touched[field] ? errors[field] : undefined);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAttempted(true);
    if (submitLock.current || !isValid) return;

    submitLock.current = true;
    setIsSubmitting(true);
    try {
      const order = await createDemoOrder({
        buyerName: values.fullName,
        buyerEmail: values.email,
        paymentMethod,
        cart: entries,
      });
      setCurrentOrder(order);
      clearCart();
      navigate('/pedido-confirmado');
    } catch {
      showToast('Não foi possível criar a demonstração. Confira seu carrinho e tente novamente.', 'error');
    } finally {
      submitLock.current = false;
      setIsSubmitting(false);
    }
  };

  if (lines.length === 0) {
    return (
      <section className="container page-section checkout-page">
        <div className="page-heading"><span className="eyebrow-label">CHECKOUT</span><h1>Finalizar pedido demonstrativo</h1><p>O checkout só pode ser testado com ao menos um item no carrinho.</p></div>
        <EmptyState title="Seu carrinho está vazio" description="Adicione um produto de demonstração antes de preencher o checkout." actionLabel="Explorar catálogo" to="/produtos" icon="cart" secondaryAction={{ label: 'Voltar ao carrinho', to: '/carrinho' }} />
      </section>
    );
  }

  const inputClass = (field: CheckoutField) => `form-control${visibleError(field) ? ' has-error' : ''}`;

  return (
    <section className="container page-section checkout-page">
      <div className="page-heading checkout-heading"><span className="eyebrow-label">ETAPA FINAL · DEMONSTRAÇÃO</span><h1>Finalizar pedido</h1><p>Checkout de convidado — nenhum dado será enviado para um serviço externo.</p></div>
      <div className="checkout-demo-alert" role="note"><Icon name="alert" size={19} /><p><strong>Ambiente demonstrativo.</strong> Não há cobrança, QR code, processamento de cartão ou entrega de produtos nesta etapa. Não informe dados financeiros.</p></div>

      <div className="checkout-layout">
        <form className="checkout-form" onSubmit={handleSubmit} noValidate aria-busy={isSubmitting}>
          <section className="checkout-section" aria-labelledby="buyer-section-heading">
            <div className="checkout-section__heading"><span className="checkout-step">01</span><div><h2 id="buyer-section-heading">Seus dados</h2><p>Usados somente para a confirmação demonstrativa desta sessão.</p></div></div>
            <div className="form-grid">
              <div className="form-field form-field--full">
                <label htmlFor="buyer-full-name">Nome completo</label>
                <input className={inputClass('fullName')} id="buyer-full-name" name="name" autoComplete="name" value={values.fullName} onChange={(event) => updateValue('fullName', event.target.value)} onBlur={() => markTouched('fullName')} aria-invalid={Boolean(visibleError('fullName'))} aria-describedby={visibleError('fullName') ? 'buyer-name-error' : undefined} required />
                {visibleError('fullName') && <p className="field-error" id="buyer-name-error">{visibleError('fullName')}</p>}
              </div>
              <div className="form-field">
                <label htmlFor="buyer-email">E-mail</label>
                <input className={inputClass('email')} id="buyer-email" name="email" type="email" autoComplete="email" inputMode="email" value={values.email} onChange={(event) => updateValue('email', event.target.value)} onBlur={() => markTouched('email')} aria-invalid={Boolean(visibleError('email'))} aria-describedby={visibleError('email') ? 'buyer-email-error' : undefined} required />
                {visibleError('email') && <p className="field-error" id="buyer-email-error">{visibleError('email')}</p>}
              </div>
              <div className="form-field">
                <label htmlFor="buyer-email-confirm">Confirme seu e-mail</label>
                <input className={inputClass('confirmEmail')} id="buyer-email-confirm" name="email-confirm" type="email" inputMode="email" autoComplete="off" value={values.confirmEmail} onChange={(event) => updateValue('confirmEmail', event.target.value)} onBlur={() => markTouched('confirmEmail')} aria-invalid={Boolean(visibleError('confirmEmail'))} aria-describedby={visibleError('confirmEmail') ? 'buyer-email-confirm-error' : undefined} required />
                {visibleError('confirmEmail') && <p className="field-error" id="buyer-email-confirm-error">{visibleError('confirmEmail')}</p>}
              </div>
            </div>
          </section>

          <section className="checkout-section" aria-labelledby="payment-section-heading">
            <div className="checkout-section__heading"><span className="checkout-step">02</span><div><h2 id="payment-section-heading">Método de pagamento</h2><p>Selecione uma opção para testar o estado visual.</p></div></div>
            <fieldset className="payment-methods">
              <legend className="sr-only">Método de pagamento demonstrativo</legend>
              {paymentOptions.map((option) => (
                <label className={`payment-option${paymentMethod === option.id ? ' is-selected' : ''}`} key={option.id}>
                  <input type="radio" name="payment-method" value={option.id} checked={paymentMethod === option.id} onChange={() => setPaymentMethod(option.id)} />
                  <span className="payment-option__radio" aria-hidden="true" />
                  <span className="payment-option__copy"><strong>{option.title}</strong><small>{option.description}</small></span>
                  <span className="payment-option__tag">DEMO</span>
                </label>
              ))}
            </fieldset>
            <p className="payment-disclaimer">A seleção não inicia pagamento. A integração com SyncPay ou qualquer outro gateway ainda não existe.</p>
          </section>

          <section className="checkout-section checkout-terms-section" aria-labelledby="terms-section-heading">
            <div className="checkout-section__heading"><span className="checkout-step">03</span><div><h2 id="terms-section-heading">Confirmação</h2><p>Leia o conteúdo provisório antes de criar a simulação.</p></div></div>
            <label className={`terms-checkbox${visibleError('acceptedTerms') ? ' has-error' : ''}`}>
              <input type="checkbox" checked={values.acceptedTerms} onChange={(event) => { updateValue('acceptedTerms', event.target.checked); markTouched('acceptedTerms'); }} onBlur={() => markTouched('acceptedTerms')} aria-invalid={Boolean(visibleError('acceptedTerms'))} aria-describedby={visibleError('acceptedTerms') ? 'terms-acceptance-error' : !values.acceptedTerms ? 'terms-acceptance-hint' : undefined} />
              <span>Li os <Link to="/termos" target="_blank" rel="noreferrer">termos comerciais provisórios</Link> e a <Link to="/privacidade" target="_blank" rel="noreferrer">política de privacidade</Link> e concordo em prosseguir apenas com esta simulação.</span>
            </label>
            {visibleError('acceptedTerms') && <p className="field-error field-error--terms" id="terms-acceptance-error">{visibleError('acceptedTerms')}</p>}
            {!values.acceptedTerms && !visibleError('acceptedTerms') && <p className="field-hint" id="terms-acceptance-hint">A confirmação é necessária para habilitar o botão de demonstração.</p>}
            <button className="button button--primary button--large checkout-submit" type="submit" disabled={!isValid || isSubmitting}>
              {isSubmitting ? <><span className="loading-spinner" aria-hidden="true" />Criando pedido demonstrativo…</> : <>Criar pedido demonstrativo <Icon name="arrow-right" size={18} /></>}
            </button>
            <p className="checkout-submit-note">Ao continuar, nenhum pagamento será efetuado e nenhum produto será entregue.</p>
          </section>
        </form>

        <div className="checkout-summary-column">
          <OrderSummary lines={lines} subtotalCents={subtotalCents} totalCents={totalCents} paymentLabel={paymentMethod === 'pix' ? 'PIX (demonstração)' : 'Cartão (demonstração)'} />
          <div className="checkout-privacy-note"><Icon name="mail" size={17} /><p>Nome e e-mail ficam apenas no estado desta sessão para a tela de confirmação. Não informe dados financeiros.</p></div>
          <Link className="checkout-back-link" to="/carrinho">Voltar ao carrinho</Link>
        </div>
      </div>
    </section>
  );
}
