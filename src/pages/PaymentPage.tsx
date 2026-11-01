import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { getBackendConfig } from '../services/backend/config';
import { describeBackendError } from '../services/backend/http';
import {
  approveDemoPayment,
  clearPendingOrder,
  getDemoCapabilities,
  getOrderStatus,
  isPaid,
  isTerminalFailure,
  readPendingOrder,
  type DemoCapabilities,
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

const PAYMENT_LABEL: Record<string, string> = {
  pending: 'Aguardando pagamento',
  in_process: 'Em processamento',
  approved: 'Aprovado',
  rejected: 'Recusado',
  cancelled: 'Cancelado',
  refunded: 'Reembolsado',
  charged_back: 'Contestado (chargeback)',
  amount_mismatch: 'Valor divergente',
};

const DELIVERY_LABEL: Record<string, string> = {
  not_ready: 'Aguardando aprovação do pagamento',
  ready: 'Disponível',
  revoked: 'Revogada',
  blocked: 'Bloqueada para análise',
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
  const [demo, setDemo] = useState<DemoCapabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [demoError, setDemoError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
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

  // O modo demonstrativo é uma capacidade do servidor: a tela apenas pergunta.
  useEffect(() => {
    if (!configured) return undefined;
    let active = true;
    getDemoCapabilities()
      .then((capabilities) => {
        if (active) setDemo(capabilities);
      })
      .catch(() => {
        if (active) setDemo(null);
      });
    return () => {
      active = false;
    };
  }, [configured]);

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

  const countdown = useCountdown(status?.payment?.expires_at ?? status?.reservation_expires_at ?? null);
  const paid = status ? isPaid(status.status, status.payment_status) : false;
  const awaitingPayment = status?.status === 'pending_payment';
  const demoAvailable = Boolean(
    demo?.demo_enabled && awaitingPayment && status?.product?.is_demo === true && !paid,
  );

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

  const simulateApproval = async () => {
    if (!pending || approving) return;
    setApproving(true);
    setDemoError(null);
    try {
      await approveDemoPayment(pending.orderId, pending.clientToken);
      await load();
    } catch (approvalError) {
      setDemoError(describeBackendError(approvalError));
    } finally {
      setApproving(false);
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
        <span className="eyebrow-label">{demoAvailable ? 'PAGAMENTO · DEMONSTRAÇÃO' : 'PAGAMENTO PIX'}</span>
        <h1>{demoAvailable ? 'Finalizar em modo de demonstração' : 'Finalize com PIX'}</h1>
        <p>
          Pedido <strong className="payment-reference">{pending.reference}</strong>. A reserva das unidades fica garantida por 30 minutos; depois disso
          as unidades voltam ao estoque.
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
              <div><dt>Pagamento</dt><dd>{PAYMENT_LABEL[status.payment_status] ?? status.payment_status}</dd></div>
              <div><dt>Entrega</dt><dd>{DELIVERY_LABEL[status.delivery_status] ?? status.delivery_status}</dd></div>
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
            ) : demoAvailable ? (
              <div className="demo-payment">
                <div className="demo-payment__badge">MODO DE DEMONSTRAÇÃO</div>
                <h2>Pagamento simulado</h2>
                <p>
                  Este ambiente está em demonstração: <strong>nenhuma cobrança real foi realizada</strong> e nenhum PIX foi gerado.
                  A aprovação abaixo é processada pelo backend, pelas mesmas regras usadas no pagamento real.
                </p>
                {demoError && (
                  <div className="payment-warning payment-warning--inline" role="alert">
                    <Icon name="alert" size={17} />
                    <p>{demoError}</p>
                  </div>
                )}
                <button className="button button--primary button--large" type="button" onClick={simulateApproval} disabled={approving}>
                  {approving ? (
                    <><span className="loading-spinner" aria-hidden="true" />Confirmando simulação…</>
                  ) : (
                    <>Simular aprovação do pagamento <Icon name="arrow-right" size={18} /></>
                  )}
                </button>
                <p className="field-hint">
                  A simulação só funciona no sandbox autorizado, exige o token privado deste pedido e só usa unidades fictícias de demonstração.
                </p>
              </div>
            ) : status.payment === null ? (
              <div className="payment-warning">
                <Icon name="alert" size={19} />
                <p>O pagamento ainda não está configurado neste ambiente e este produto não participa da demonstração.</p>
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
              <li>O pagamento é confirmado (no sandbox, pela simulação).</li>
              <li>O backend valida e consome as unidades reservadas.</li>
              <li>A entrega é gerada e vinculada ao seu pedido.</li>
              <li>Você recebe um link privado com e-mail, senha e instruções.</li>
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
