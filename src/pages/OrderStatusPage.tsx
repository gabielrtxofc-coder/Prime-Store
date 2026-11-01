import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { useToast } from '../context/ToastContext';
import { formatCurrency } from '../lib/format';
import type { OrderStatusPayload } from '../services/orderService';
import {
  buildTrackingLink,
  getRequestStatus,
  isNotFoundError,
  readCodeFromHash,
  readRequestReceipt,
  saveRequestReceipt,
} from '../services/requestService';

interface StatusLine {
  productId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  subtotalCents: number;
}

type PageState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: OrderStatusPayload }
  | { kind: 'not_found'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'needs_code' };

const STATUS_LABELS: Record<string, string> = {
  requested: 'Aguardando confirmação',
  pending_payment: 'Aguardando pagamento',
  paid: 'Confirmado',
  failed: 'Não concluído',
  expired: 'Expirado',
  cancelled: 'Cancelado',
  refund_pending: 'Reembolso em análise',
  refunded: 'Reembolsado',
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/**
 * Confirmação + acompanhamento da solicitação.
 *
 * O pedido só é exibido com o código privado guardado no navegador (ou recebido
 * pelo fragmento do link). O número `PS-XXXXXX` sozinho não abre nada — é o que
 * impede alguém de ler o pedido de outra pessoa.
 */
export function OrderStatusPage() {
  const { identifier = '' } = useParams();
  const location = useLocation();
  const { showToast } = useToast();

  const [page, setPage] = useState<PageState>({ kind: 'loading' });
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [resolvedToken, setResolvedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const hashCode = useMemo(() => readCodeFromHash(location.hash), [location.hash]);

  // 1. Descobre o código: fragmento do link > comprovante guardado no navegador.
  useEffect(() => {
    const stored = readRequestReceipt(identifier);
    // O comprovante definitivo (com id e número oficiais) é gravado depois da
    // consulta, quando o servidor confirma os dois identificadores.
    setResolvedToken(hashCode ?? stored?.clientToken ?? null);
  }, [identifier, hashCode]);

  // 2. Consulta o estado no servidor.
  useEffect(() => {
    if (!resolvedToken) {
      setPage({ kind: 'needs_code' });
      return;
    }

    let cancelled = false;
    setPage({ kind: 'loading' });

    getRequestStatus(identifier, resolvedToken)
      .then((status) => {
        if (cancelled) return;
        // Completa o comprovante com o número oficial (útil quando o visitante
        // abriu o link pelo id e depois quer consultar pelo número).
        const stored = readRequestReceipt(identifier);
        if (!stored || stored.reference !== status.reference) {
          saveRequestReceipt({
            orderId: status.order_id,
            reference: status.reference,
            clientToken: resolvedToken,
            createdAt: stored?.createdAt ?? status.created_at,
            totalCents: status.total_cents,
            itemsCount: status.items_count,
          });
        }
        setPage({ kind: 'ready', status });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPage(
          isNotFoundError(error)
            ? {
                kind: 'not_found',
                message: 'Não encontramos um pedido com esse número e esse código de acompanhamento.',
              }
            : {
                kind: 'error',
                message: 'Não foi possível consultar o pedido agora. Verifique sua conexão e tente novamente.',
              },
        );
      });

    return () => {
      cancelled = true;
    };
    // `page` não entra nas dependências de propósito: cada mudança de estado da
    // tela não deve disparar uma nova consulta (apenas id/código disparam).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identifier, resolvedToken]);

  const handleCodeSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const candidate = code.trim();
    if (candidate.length < 32) {
      setCodeError('O código de acompanhamento tem 32 caracteres ou mais.');
      return;
    }
    setCodeError(null);
    setPage({ kind: 'loading' });
    setResolvedToken(candidate);
  };

  const handleCopyLink = useCallback(async () => {
    if (!resolvedToken) return;
    const link = buildTrackingLink({ orderId: identifier, clientToken: resolvedToken });
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      showToast('Link de acompanhamento copiado.');
    } catch {
      // Sem permissão de área de transferência: o link fica visível na tela.
      showToast('Não foi possível copiar automaticamente. Selecione o link exibido.', 'error');
    }
  }, [identifier, resolvedToken, showToast]);

  if (page.kind === 'loading') {
    return (
      <section className="container page-section order-confirmation-page">
        <p className="loading-line" role="status"><span className="loading-spinner" aria-hidden="true" />Consultando pedido…</p>
      </section>
    );
  }

  if (page.kind === 'needs_code') {
    return (
      <section className="container page-section order-confirmation-page">
        <div className="page-heading">
          <span className="eyebrow-label">ACOMPANHAMENTO</span>
          <h1>Abrir pedido</h1>
          <p>Para ver os dados do pedido, informe o código de acompanhamento.</p>
        </div>
        <form className="tracking-form" onSubmit={handleCodeSubmit} noValidate>
          <div className="form-field form-field--full">
            <label htmlFor="tracking-code">Código de acompanhamento</label>
            <input
              id="tracking-code"
              className={`form-control${codeError ? ' has-error' : ''}`}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={Boolean(codeError)}
              aria-describedby={codeError ? 'tracking-code-error' : undefined}
              required
            />
            {codeError && <p className="field-error" id="tracking-code-error">{codeError}</p>}
          </div>
          <button className="button button--primary" type="submit">Ver pedido <Icon name="arrow-right" size={17} /></button>
        </form>
        <p className="confirmation-catalog-link">
          O código aparece na tela de confirmação do pedido. <Link to="/acompanhar">Consultar por número do pedido</Link>
        </p>
      </section>
    );
  }

  if (page.kind === 'not_found' || page.kind === 'error') {
    return (
      <section className="container page-section order-confirmation-page">
        <div className="page-heading"><span className="eyebrow-label">ACOMPANHAMENTO</span><h1>Pedido</h1></div>
        <div className="catalog-status catalog-status--error" role="alert">
          <span>{page.message}</span>
          <Link className="button button--secondary button--small" to="/acompanhar">Tentar outro número</Link>
        </div>
        <EmptyState
          title={page.kind === 'not_found' ? 'Pedido não encontrado' : 'Falha ao consultar'}
          description={
            page.kind === 'not_found'
              ? 'Confira o número do pedido e o código de acompanhamento. Nenhum dado de outro pedido é exibido.'
              : 'Tente novamente em instantes. O pedido registrado não foi alterado.'
          }
          actionLabel="Ir para o catálogo"
          to="/produtos"
          icon="alert"
          secondaryAction={{ label: 'Ir para o início', to: '/' }}
        />
      </section>
    );
  }

  const order = page.status;
  const items: StatusLine[] = (order.items ?? []).map((item) => ({
    productId: item.product_id,
    name: item.product_name,
    quantity: item.quantity,
    unitPriceCents: item.unit_price_cents,
    subtotalCents: item.subtotal_cents,
  }));

  if (items.length === 0) {
    items.push({
      productId: order.product.id,
      name: order.product.name,
      quantity: order.quantity,
      unitPriceCents: order.unit_price_cents,
      subtotalCents: order.total_cents,
    });
  }

  const isRequest = order.status === 'requested' || order.payment_status === 'not_required';
  const trackingLink = resolvedToken ? buildTrackingLink({ orderId: order.order_id, clientToken: resolvedToken }) : null;
  const registeredAt = new Date(order.created_at);

  return (
    <section className="container page-section order-confirmation-page">
      <div className="confirmation-card">
        <div className="confirmation-card__success-icon"><Icon name="check" size={32} /></div>
        <span className="eyebrow-label">{isRequest ? 'SOLICITAÇÃO REGISTRADA' : 'PEDIDO REGISTRADO'}</span>
        <h1>{isRequest ? 'Seu pedido foi registrado' : `Pedido ${order.reference}`}</h1>
        <p className="confirmation-card__lead">
          {order.buyer_name ? `Obrigado, ${order.buyer_name}. ` : ''}
          Guarde o número do pedido e o código de acompanhamento abaixo.
        </p>

        {isRequest && (
          <div className="order-state-note" role="note">
            <Icon name="alert" size={19} />
            <p>
              <strong>Seu pedido foi recebido e aguarda confirmação.</strong> Nenhum pagamento foi realizado.
            </p>
          </div>
        )}

        <div className="confirmation-meta">
          <div><span>Número do pedido</span><strong className="confirmation-order-id">{order.reference}</strong></div>
          <div><span>Estado atual</span><strong>{statusLabel(order.status)}</strong></div>
          <div><span>Registrado em</span><strong>{registeredAt.toLocaleString('pt-BR')}</strong></div>
          <div><span>Valor registrado</span><strong>{formatCurrency(order.total_cents)}</strong></div>
        </div>

        <div className="confirmation-summary">
          <div className="confirmation-summary__heading"><h2>Itens do pedido</h2><span>{items.length} {items.length === 1 ? 'produto' : 'produtos'}</span></div>
          <ul>
            {items.map((item) => (
              <li key={item.productId}>
                <div>
                  <strong>{item.name}</strong>
                  <span>{item.quantity} × {formatCurrency(item.unitPriceCents)}</span>
                </div>
                <strong>{formatCurrency(item.subtotalCents)}</strong>
              </li>
            ))}
          </ul>
          <div className="confirmation-total"><span>Total registrado</span><strong>{formatCurrency(order.total_cents)}</strong></div>
        </div>

        <div className="tracking-box">
          <h2>Código de acompanhamento</h2>
          <p className="tracking-box__code" data-testid="tracking-code-value">{resolvedToken}</p>
          <p className="field-hint">
            Com este código e o número do pedido você consulta o estado em qualquer dispositivo. Quem não tem o
            código não consegue abrir o pedido.
          </p>
          {trackingLink && <p className="tracking-box__link">{trackingLink}</p>}
          <div className="tracking-box__actions">
            <button className="button button--secondary button--small" type="button" onClick={handleCopyLink}>
              {copied ? 'Link copiado' : 'Copiar link de acompanhamento'}
            </button>
            <Link className="text-link text-link--arrow" to="/acompanhar">Consultar outro pedido <Icon name="arrow-right" size={17} /></Link>
          </div>
        </div>

        <Link className="button button--primary button--large confirmation-store-button" to="/produtos">
          Continuar no catálogo <Icon name="arrow-right" size={18} />
        </Link>
        <Link className="confirmation-catalog-link" to="/">Voltar ao início</Link>
      </div>
    </section>
  );
}
