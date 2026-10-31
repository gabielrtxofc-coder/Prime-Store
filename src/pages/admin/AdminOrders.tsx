import { useCallback, useEffect, useState } from 'react';
import { formatCurrency } from '../../lib/format';
import { adminApi, type AdminOrderDetail, type AdminOrderList } from '../../services/adminApi';
import { describeBackendError } from '../../services/backend/http';

const ORDER_STATUS = ['', 'pending_payment', 'paid', 'expired', 'cancelled', 'refund_pending', 'refunded', 'failed'] as const;
const PAYMENT_STATUS = ['', 'pending', 'in_process', 'approved', 'rejected', 'cancelled', 'refunded', 'charged_back', 'amount_mismatch'] as const;

export function AdminOrders() {
  const [list, setList] = useState<AdminOrderList | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [paymentStatus, setPaymentStatus] = useState('');
  const [problemOnly, setProblemOnly] = useState(false);
  const [detail, setDetail] = useState<AdminOrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const result = await adminApi.listOrders({
        search,
        status: status || null,
        paymentStatus: paymentStatus || null,
        problemOnly,
        limit: 100,
      });
      setList(result);
      setError(null);
    } catch (loadError) {
      setError(describeBackendError(loadError));
    } finally {
      setBusy(false);
    }
  }, [search, status, paymentStatus, problemOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = async (orderId: string) => {
    try {
      setDetail(await adminApi.getOrder(orderId));
      setError(null);
    } catch (detailError) {
      setError(describeBackendError(detailError));
    }
  };

  const revokeDelivery = async (deliveryId: string) => {
    try {
      await adminApi.revokeDelivery(deliveryId, 'Revogada pelo painel administrativo');
      setNotice('Entrega revogada. O link deixa de revelar credenciais imediatamente.');
      if (detail) await openDetail(detail.order.id);
      await load();
    } catch (revokeError) {
      setError(describeBackendError(revokeError));
    }
  };

  const rotateDelivery = async (deliveryId: string) => {
    try {
      const result = await adminApi.rotateDelivery(deliveryId);
      setNotice(result.delivery_url ? `Novo link gerado: ${result.delivery_url}` : 'Novo link gerado.');
      if (detail) await openDetail(detail.order.id);
    } catch (rotateError) {
      setError(describeBackendError(rotateError));
    }
  };

  const resolveRefund = async (refundId: string, next: 'authorized' | 'processed' | 'rejected') => {
    try {
      await adminApi.resolveRefund(refundId, next, `Resolvido pelo painel (${next}).`);
      setNotice(`Reembolso: ${next}.`);
      if (detail) await openDetail(detail.order.id);
      await load();
    } catch (refundError) {
      setError(describeBackendError(refundError));
    }
  };

  return (
    <div className="admin-section">
      {error && <div className="payment-warning" role="alert"><p>{error}</p></div>}
      {notice && <p className="admin-notice" role="status">{notice}</p>}

      <div className="admin-toolbar">
        <input
          className="form-control admin-search"
          type="search"
          placeholder="Buscar por referência ou produto"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Buscar pedidos"
        />
        <select className="form-control" value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Status do pedido">
          {ORDER_STATUS.map((value) => (
            <option key={value || 'all'} value={value}>{value || 'Todos os pedidos'}</option>
          ))}
        </select>
        <select className="form-control" value={paymentStatus} onChange={(event) => setPaymentStatus(event.target.value)} aria-label="Status do pagamento">
          {PAYMENT_STATUS.map((value) => (
            <option key={value || 'all'} value={value}>{value || 'Todos os pagamentos'}</option>
          ))}
        </select>
        <label className="admin-inline-check">
          <input type="checkbox" checked={problemOnly} onChange={(event) => setProblemOnly(event.target.checked)} />
          Somente problemas
        </label>
        <button className="button button--secondary button--small" type="button" onClick={() => void load()} disabled={busy}>
          {busy ? 'Carregando…' : 'Atualizar'}
        </button>
      </div>

      <div className="admin-table-wrapper">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Pedido</th>
              <th>Produto</th>
              <th>Qtd.</th>
              <th>Valor</th>
              <th>Criado</th>
              <th>Pagamento</th>
              <th>Pedido</th>
              <th>Entrega</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(list?.items ?? []).map((order) => (
              <tr key={order.id}>
                <td><code>{order.reference}</code></td>
                <td>{order.product_name}</td>
                <td>{order.quantity}</td>
                <td>{formatCurrency(order.total_cents)}</td>
                <td>{new Date(order.created_at).toLocaleString('pt-BR')}</td>
                <td>{order.payment_status}</td>
                <td>
                  {order.status}
                  {order.open_refund_requests > 0 && <span className="admin-badge is-warn">reembolso</span>}
                </td>
                <td>{order.delivery_link_status ?? order.delivery_status}</td>
                <td>
                  <button className="link-button" type="button" onClick={() => openDetail(order.id)}>Detalhes</button>
                </td>
              </tr>
            ))}
            {(list?.items ?? []).length === 0 && (
              <tr><td colSpan={9} className="field-hint">Nenhum pedido encontrado.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {list && <p className="field-hint">{list.total} pedido(s) no total · exibindo {list.items.length}.</p>}

      {detail && (
        <div className="admin-panel admin-order-detail">
          <div className="admin-order-detail__header">
            <div>
              <h2>Pedido {detail.order.reference}</h2>
              <p className="field-hint">
                {detail.order.product_name} · {detail.order.quantity} unidade(s) · {formatCurrency(detail.order.total_cents)} ·{' '}
                {new Date(detail.order.created_at).toLocaleString('pt-BR')}
              </p>
            </div>
            <button className="button button--secondary button--small" type="button" onClick={() => setDetail(null)}>Fechar</button>
          </div>

          <dl className="admin-detail-grid">
            <div><dt>Status do pedido</dt><dd>{detail.order.status}</dd></div>
            <div><dt>Status do pagamento</dt><dd>{detail.order.payment_status}</dd></div>
            <div><dt>Entrega</dt><dd>{detail.order.delivery_status}</dd></div>
            <div><dt>Expira a reserva</dt><dd>{new Date(detail.order.reservation_expires_at).toLocaleString('pt-BR')}</dd></div>
            <div><dt>Pago em</dt><dd>{detail.order.paid_at ? new Date(detail.order.paid_at).toLocaleString('pt-BR') : '—'}</dd></div>
            <div><dt>Unidades entregues</dt><dd>{detail.delivery_units.length}</dd></div>
          </dl>

          {detail.delivery && (
            <div className="admin-panel admin-nested">
              <h3>Link de entrega</h3>
              <p className="field-hint">
                Estado: <strong>{detail.delivery.status}</strong> · visualizações: {detail.delivery.view_count}
                {detail.delivery.revoked_at ? ` · revogado em ${new Date(detail.delivery.revoked_at).toLocaleString('pt-BR')}` : ''}
              </p>
              <div className="admin-row-actions">
                <button
                  className="button button--secondary button--small"
                  type="button"
                  onClick={() => revokeDelivery(detail.delivery!.id)}
                  disabled={detail.delivery.status === 'revoked'}
                >
                  Revogar link
                </button>
                <button className="button button--secondary button--small" type="button" onClick={() => rotateDelivery(detail.delivery!.id)}>
                  Gerar novo link
                </button>
              </div>
            </div>
          )}

          {detail.refund_requests.length > 0 && (
            <div className="admin-panel admin-nested">
              <h3>Reembolsos</h3>
              <ul className="admin-list">
                {detail.refund_requests.map((refund) => (
                  <li key={refund.id}>
                    <div>
                      <strong>{refund.status}</strong>
                      <span>{refund.reason}</span>
                      <span>{formatCurrency(refund.amount_cents)}</span>
                    </div>
                    {(refund.status === 'pending' || refund.status === 'authorized') && (
                      <div className="admin-row-actions">
                        <button className="link-button" type="button" onClick={() => resolveRefund(refund.id, 'authorized')}>Autorizar</button>
                        <button className="link-button" type="button" onClick={() => resolveRefund(refund.id, 'processed')}>Processado</button>
                        <button className="link-button" type="button" onClick={() => resolveRefund(refund.id, 'rejected')}>Recusar</button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              <p className="field-hint">O reembolso é manual e precisa ser feito no Mercado Pago. Marcar como processado revoga o link de entrega.</p>
            </div>
          )}

          <div className="admin-panel admin-nested">
            <h3>Histórico</h3>
            <ul className="admin-audit">
              {detail.events.map((event) => (
                <li key={event.id}>
                  <code>{new Date(event.created_at).toLocaleString('pt-BR')}</code>
                  <strong>{event.event_type}</strong>
                  <span>{event.actor}</span>
                </li>
              ))}
              {detail.events.length === 0 && <li className="field-hint">Sem eventos registrados.</li>}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
