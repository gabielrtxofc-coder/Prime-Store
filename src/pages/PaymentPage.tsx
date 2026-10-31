import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { getBackendConfig } from '../services/backend/config';
import { describeBackendError } from '../services/backend/http';
import {
  clearPendingOrder,
  getOrderStatus,
  isPaid,
  isTerminalFailure,
  readPendingOrder,
  type OrderStatusPayload,
} from '../services/orderService';
import { formatCurrency } from '../lib/format';
import { deliveryPath } from '../lib/links';

const POLL_INTERVAL_MS = 5000;

const STATUS_LABEL: Record<string, string> = {
  pending_payment: 'Aguardando o pagamento PIX',
  paid: 'Pagamento aprovado',
  expired: 'Reserva expirada',
  cancelled: 'Pedido cancelado',
  refund_pending: 'Reembolso em análise',
  disputed: 'Contestação em análise',
  refunded: 'Pedido reembolsado',
  failed: 'Pedido com falha',
};

function useCountdown(target: string | null): string | null {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!target) {
      setRemaining(null);
      return;
    }
    const deadline = new Date(target).getTime();
    const tick = () => setRemaining(Math.max(0, deadline - Date.now()));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [target]);

  if (remaining === null) return null;
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function PaymentPage() {
  const configured = getBackendConfig().enabled;
  const pending = useMemo(() => readPendingOrder(), []);
  const [status, setStatus] = useState<OrderStatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (!pending) {
      setLoading(false);
      return;
    }
    try {
      const payload = await getOrderStatus(pending.orderId, pending.clientToken);
      setStatus(payload);
      setError(null);
    } catch (loadError) {
      setError(describeBackendError(loadError));
    } finally {
      setLoading(false);
    }
  }, [pending]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!pending) return;
    const finished = status ? isPaid(status.status, status.payment_status) || isTerminalFailure(status.status) : false;
    if (finished) {
      if (timerRef.current) window.clearInterval(timerRef.current);
      timerRef.current = null;
      return;
    }
    timerRef.current = window.setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [load, pending, status]);

  const countdown = useCountdown(status?.payment?.expires_at ?? null);
  const paid = status ? isPaid(status.status, status.payment_status) : false;
  const copyCode = async () => {
    const code = status?.payment?.qr_code;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setError('Não foi possível copiar automaticamente. Selecione o código manualmente.');
    }
  };

  if (!configured) {
    return (
      <section className="container page-section">
        <div className="page-heading">
          <span className="eyebrow-label">PAGAMENTO</span>
          <h1>Checkout indisponível neste ambiente</h1>
          <p>O backend não está configurado. Defina as variáveis VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY e VITE_BACKEND_ENABLED=true.</p>
        </div>
        <Link className="button button--primary" to="/produtos">Voltar ao catálogo</Link>
      </section>
    );
  }

  if (!pending) {
    return (
      <section className="container page-section">
        <div className="page-heading">
          <span className="eyebrow-label">PAGAMENTO</span>
          <h1>Nenhum pedido em andamento</h1>
          <p>Este navegador não tem um pedido pendente nesta sessão. Se você já pagou, abra o link de entrega enviado na confirmação.</p>
        </div>
        <Link className="button button--primary" to="/produtos">Explorar catálogo <Icon name="arrow-right" size={18} /></Link>
      </section>
    );
  }

  return (
    <section className="container page-section payment-page">
      <div className="page-heading">
        <span className="eyebrow-label">PAGAMENTO PIX</span>
        <h1>Finalize com PIX</h1>
        <p>
          Pedido <strong className="payment-reference">{pending.reference}</strong>. A reserva das unidades fica garantida até o
          vencimento do PIX; depois disso as unidades voltam ao estoque.
        </p>
      </div>

      {error && (
        <div className="payment-warning" role="alert">
          <Icon name="alert" size={19} />
          <p>{error}</p>
        </div>
      )}

      {loading && !status && <p className="loading-line"><span className="loading-spinner" aria-hidden="true" />Carregando dados do pagamento…</p>}

      {status && (
        <div className="payment-layout">
          <div className="payment-card">
            <div className="payment-card__header">
              <span className="eyebrow-label">STATUS</span>
              <strong>{paid ? 'Pagamento confirmado' : (STATUS_LABEL[status.status] ?? status.status)}</strong>
              {!paid && countdown && (
                <span className="payment-countdown" role="timer" aria-live="off">Expira em {countdown}</span>
              )}
            </div>

            <dl className="payment-details">
              <div><dt>Produto</dt><dd>{status.product.name}</dd></div>
              <div><dt>Quantidade</dt><dd>{status.quantity}</dd></div>
              <div><dt>Valor</dt><dd>{formatCurrency(status.total_cents)}</dd></div>
              <div><dt>Estado do pagamento</dt><dd>{status.payment_status}</dd></div>
            </dl>

            {paid ? (
              <div className="payment-success">
                <p><strong>Pagamento aprovado.</strong> Suas credenciais já estão liberadas.</p>
                {status.delivery?.url ? (
                  <Link className="button button--primary button--large" to={deliveryPath(status.delivery.url)}>
                    Abrir entrega privada <Icon name="arrow-right" size={18} />
                  </Link>
                ) : (
                  <p className="field-hint">
                    A entrega está sendo preparada. Guarde o link exibido no pedido — ele é permanente e pode ser reaberto a qualquer momento.
                  </p>
                )}
              </div>
            ) : isTerminalFailure(status.status) ? (
              <div className="payment-warning">
                <Icon name="alert" size={19} />
                <p>Este pedido não pode mais ser pago. As unidades voltaram ao estoque e nenhum valor foi cobrado.</p>
              </div>
            ) : (
              <div className="payment-pix">
                <div className="payment-qr">
                  {status.payment?.qr_code_base64 ? (
                    <img src={`data:image/png;base64,${status.payment.qr_code_base64}`} alt="QR code do PIX" width={220} height={220} />
                  ) : (
                    <p className="field-hint">QR code indisponível. Use o código copia-e-cola.</p>
                  )}
                </div>
                {status.payment?.qr_code && (
                  <div className="payment-copy">
                    <label htmlFor="pix-code">PIX copia-e-cola</label>
                    <textarea id="pix-code" readOnly value={status.payment.qr_code} rows={4} />
                    <button className="button button--secondary button--small" type="button" onClick={copyCode}>
                      {copied ? 'Código copiado' : 'Copiar código PIX'}
                    </button>
                  </div>
                )}
                {status.payment?.ticket_url && (
                  <a className="payment-ticket-link" href={status.payment.ticket_url} target="_blank" rel="noreferrer">
                    Abrir a fatura no Mercado Pago
                  </a>
                )}
                <p className="payment-poll-note">
                  A página confere o pagamento automaticamente a cada {POLL_INTERVAL_MS / 1000} segundos. Você pode fechar e voltar depois — o link
                  de entrega também aparece aqui.
                </p>
              </div>
            )}
          </div>

          <aside className="payment-aside">
            <h2>O que acontece depois</h2>
            <ol>
              <li>O Mercado Pago confirma o pagamento e avisa o backend.</li>
              <li>O backend valida a notificação e consulta o pagamento real.</li>
              <li>As unidades reservadas passam a vendidas e a entrega é gerada.</li>
              <li>Você recebe um link privado, permanente, com e-mail, senha e instruções.</li>
            </ol>
            <p className="field-hint">Nenhum dado de cartão é solicitado ou armazenado. O e-mail informado é usado apenas na criação da cobrança.</p>
            <Link className="confirmation-catalog-link" to="/produtos">Continuar explorando o catálogo</Link>
          </aside>
        </div>
      )}

      <button className="checkout-back-link" type="button" onClick={() => { clearPendingOrder(); window.location.reload(); }}>
        Descartar este pedido da tela
      </button>
    </section>
  );
}
