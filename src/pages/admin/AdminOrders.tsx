import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatCurrency } from '../../lib/format';
import {
  adminApi,
  type AdminOrderDetail,
  type AdminOrderList,
  type DisputeOutcome,
} from '../../services/adminApi';
import { describeBackendError } from '../../services/backend/http';
import { presetToRange, type PeriodPreset } from '../../lib/period';
import { PeriodFilter } from '../../components/admin/PeriodFilter';
import { ConfirmActionDialog } from '../../components/admin/ConfirmActionDialog';
import { useConfirmAction } from '../../components/admin/useConfirmAction';

// Estados reais do banco (enums `order_status`/`payment_status`).
// `requested`/`not_required` existem desde a migração 0033 (solicitação sem pagamento).
const ORDER_STATUS = ['', 'requested', 'pending_payment', 'paid', 'expired', 'cancelled', 'refund_pending', 'refunded', 'disputed', 'failed'] as const;
const PAYMENT_STATUS = ['', 'not_required', 'pending', 'in_process', 'approved', 'rejected', 'cancelled', 'refunded', 'charged_back', 'amount_mismatch'] as const;

const ORDER_STATUS_LABEL: Record<string, string> = {
  requested: 'requested — solicitação',
  pending_payment: 'pending_payment — aguardando PIX',
  paid: 'paid — pago',
  expired: 'expired — expirado',
  cancelled: 'cancelled — cancelado',
  refund_pending: 'refund_pending — reembolso em análise',
  refunded: 'refunded — reembolsado',
  disputed: 'disputed — contestado',
  failed: 'failed — não concluído',
};

const PAYMENT_STATUS_LABEL: Record<string, string> = {
  not_required: 'not_required — sem pagamento (solicitação)',
  pending: 'pending — aguardando',
  in_process: 'in_process — em processamento',
  approved: 'approved — aprovado',
  rejected: 'rejected — recusado',
  cancelled: 'cancelled — cancelado',
  refunded: 'refunded — reembolsado',
  charged_back: 'charged_back — chargeback',
  amount_mismatch: 'amount_mismatch — divergência de valor',
};

export function AdminOrders() {
  const [list, setList] = useState<AdminOrderList | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [paymentStatus, setPaymentStatus] = useState('');
  const [problemOnly, setProblemOnly] = useState(false);
  const [preset, setPreset] = useState<PeriodPreset>('30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [detail, setDetail] = useState<AdminOrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { pending: confirmAction, busy: confirmBusy, request: requestConfirm, cancel: cancelConfirm, confirm: runConfirm } = useConfirmAction();

  const range = useMemo(() => presetToRange(preset, customFrom, customTo), [preset, customFrom, customTo]);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const result = await adminApi.listOrders({
        search,
        status: status || null,
        paymentStatus: paymentStatus || null,
        problemOnly,
        from: range.from,
        to: range.to,
        limit: 100,
      });
      setList(result);
      setError(null);
    } catch (loadError) {
      setError(describeBackendError(loadError));
    } finally {
      setBusy(false);
    }
  }, [search, status, paymentStatus, problemOnly, range]);

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

  const askRevokeDelivery = (deliveryId: string, orderReference: string) => {
    requestConfirm({
      title: 'Revogar link de entrega?',
      description: `Pedido ${orderReference}: o link de entrega deixará de revelar as credenciais imediatamente. Quem já salvou as credenciais não será afetado; quem tentar abrir o link verá uma página de link revogado. A revogação fica registrada em auditoria.`,
      confirmLabel: 'Revogar link',
      danger: true,
      action: async () => {
        try {
          await adminApi.revokeDelivery(deliveryId, 'Revogada pelo painel administrativo');
          setNotice('Entrega revogada. O link deixa de revelar credenciais imediatamente.');
          if (detail) await openDetail(detail.order.id);
          await load();
        } catch (revokeError) {
          setError(describeBackendError(revokeError));
        }
      },
    });
  };

  const askRotateDelivery = (deliveryId: string, orderReference: string) => {
    requestConfirm({
      title: 'Gerar novo link de entrega?',
      description: `Pedido ${orderReference}: um novo link será gerado e o link atual deixará de funcionar imediatamente. As credenciais entregues não mudam — apenas a forma de acessá-las. Copie o novo link e envie-o ao cliente somente pelos canais habituais da loja.`,
      confirmLabel: 'Gerar novo link',
      danger: false,
      action: async () => {
        try {
          const result = await adminApi.rotateDelivery(deliveryId);
          setNotice(result.delivery_url ? `Novo link gerado: ${result.delivery_url}` : 'Novo link gerado.');
          if (detail) await openDetail(detail.order.id);
        } catch (rotateError) {
          setError(describeBackendError(rotateError));
        }
      },
    });
  };

  const DISPUTE_COPY: Record<DisputeOutcome, { title: string; description: string; confirmLabel: string; danger: boolean }> = {
    refund: {
      title: 'Reembolsar e encerrar contestação?',
      description: 'O pedido será marcado como reembolsado e o link de entrega será revogado imediatamente. O reembolso em si é feito fora da loja (no Mercado Pago) — aqui fica registrado que você tratou o caso. A ação é registrada em auditoria.',
      confirmLabel: 'Reembolsar e encerrar',
      danger: true,
    },
    reinstated: {
      title: 'Registrar contestação revertida?',
      description: 'O pedido voltará a ser marcado como pago e a entrega será liberada para o cliente. Confirme apenas se o Mercado Pago efetivamente devolveu o valor para a loja. A decisão é registrada em auditoria.',
      confirmLabel: 'Contestação revertida',
      danger: false,
    },
    refund_pending: {
      title: 'Manter contestação em análise?',
      description: 'O pedido permanecerá em análise de reembolso, sem revogar a entrega nem liberar acesso definitivo. Você poderá voltar e tomar a decisão final depois.',
      confirmLabel: 'Manter em análise',
      danger: false,
    },
  };

  const askResolveDispute = (orderId: string, orderReference: string, outcome: DisputeOutcome) => {
    const copy = DISPUTE_COPY[outcome];
    requestConfirm({
      ...copy,
      description: `Pedido ${orderReference}: ${copy.description}`,
      action: async () => {
        try {
          await adminApi.resolveDispute(orderId, outcome, `Decisão da disputa registrada no painel (${outcome}).`);
          setNotice(
            outcome === 'reinstated'
              ? 'Disputa revertida: pedido marcado como pago e entrega liberada.'
              : outcome === 'refund'
                ? 'Disputa encerrada com reembolso: entrega revogada.'
                : 'Disputa mantida em análise de reembolso.',
          );
          if (detail) await openDetail(detail.order.id);
          await load();
        } catch (disputeError) {
          setError(describeBackendError(disputeError));
        }
      },
    });
  };

  const REFUND_COPY: Record<'authorized' | 'processed' | 'rejected', { title: string; description: string; confirmLabel: string; danger: boolean }> = {
    authorized: {
      title: 'Autorizar reembolso?',
      description: 'O reembolso será autorizado e o pedido entrará na fila de execução. O dinheiro precisa ser devolvido fora da loja (no Mercado Pago). A autorização fica registrada em auditoria e o link de entrega continua ativo até o reembolso ser marcado como processado.',
      confirmLabel: 'Autorizar',
      danger: false,
    },
    processed: {
      title: 'Marcar reembolso como processado?',
      description: 'Confirme somente depois de devolver o dinheiro ao cliente. O link de entrega do pedido será revogado imediatamente e o caso será encerrado. A ação é registrada em auditoria.',
      confirmLabel: 'Processado — revogar entrega',
      danger: true,
    },
    rejected: {
      title: 'Recusar reembolso?',
      description: 'O pedido de reembolso será recusado e o caso será encerrado. O cliente pode pedir novamente; cada decisão fica registrada em auditoria.',
      confirmLabel: 'Recusar reembolso',
      danger: true,
    },
  };

  const askResolveRefund = (refundId: string, orderReference: string, next: 'authorized' | 'processed' | 'rejected') => {
    const copy = REFUND_COPY[next];
    requestConfirm({
      ...copy,
      description: `Pedido ${orderReference}: ${copy.description}`,
      action: async () => {
        try {
          await adminApi.resolveRefund(refundId, next, `Resolvido pelo painel (${next}).`);
          setNotice(`Reembolso: ${next}.`);
          if (detail) await openDetail(detail.order.id);
          await load();
        } catch (refundError) {
          setError(describeBackendError(refundError));
        }
      },
    });
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
            <option key={value || 'all'} value={value}>{value ? ORDER_STATUS_LABEL[value] : 'Todos os pedidos'}</option>
          ))}
        </select>
        <select className="form-control" value={paymentStatus} onChange={(event) => setPaymentStatus(event.target.value)} aria-label="Status do pagamento">
          {PAYMENT_STATUS.map((value) => (
            <option key={value || 'all'} value={value}>{value ? PAYMENT_STATUS_LABEL[value] : 'Todos os pagamentos'}</option>
          ))}
        </select>
        <PeriodFilter
          idPrefix="orders"
          preset={preset}
          customFrom={customFrom}
          customTo={customTo}
          onPresetChange={setPreset}
          onCustomFromChange={setCustomFrom}
          onCustomToChange={setCustomTo}
        />
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
                <td>
                  {order.product_name}
                  {typeof order.items_count === 'number' && order.items_count > 1 && (
                    <span className="admin-badge" title={`Pedido com ${order.items_count} produtos distintos; o nome exibido é o primeiro produto.`}>
                      {' '}{order.items_count} itens
                    </span>
                  )}
                </td>
                <td>{order.quantity}</td>
                <td>{formatCurrency(order.total_cents)}</td>
                <td>{new Date(order.created_at).toLocaleString('pt-BR')}</td>
                <td>
                  {order.payment_status}
                  {order.payment_status === 'not_required' && <span className="admin-badge"> sem cobrança</span>}
                </td>
                <td>
                  {order.status}
                  {order.status === 'requested' && <span className="admin-badge"> solicitação</span>}
                  {order.status === 'disputed' && <span className="admin-badge is-warn">contestar</span>}
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
      {list && (
        <p className="field-hint">
          {list.total} pedido(s) no total · exibindo {list.items.length} · ordenados do mais recente para o mais antigo (created_at) pelo servidor.
          {list.total > list.items.length ? ` Há mais resultados do que os ${list.items.length} exibidos — refine os filtros.` : ''}
        </p>
      )}

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

          {/* buyer_name / buyer_email não são exibidos neste painel:
              o painel administrativo não mostra dados pessoais desnecessários. */}
          {(detail.order.status === 'requested' || detail.order.payment_status === 'not_required') && (
            <div className="payment-warning admin-order-banner" role="note">
              <p>
                <strong>Solicitação sem pagamento.</strong> Pedido criado no modo atual da loja: não houve cobrança e não
                há pagamento a confirmar. Nenhuma aprovação manual é possível ou necessária — trate como solicitação de
                atendimento, nunca como venda paga.
              </p>
            </div>
          )}

          <div className="admin-detail-columns">
            <section aria-label="Estado do pedido">
              <h3 className="admin-subheading">Pedido</h3>
              <dl className="admin-detail-grid admin-detail-grid--stack">
                <div><dt>Status do pedido</dt><dd>{ORDER_STATUS_LABEL[detail.order.status] ?? detail.order.status}</dd></div>
                <div><dt>Criado em</dt><dd>{new Date(detail.order.created_at).toLocaleString('pt-BR')}</dd></div>
                <div><dt>Reserva expira em</dt><dd>{new Date(detail.order.reservation_expires_at).toLocaleString('pt-BR')}</dd></div>
                <div><dt>Entrega</dt><dd>{detail.order.delivery_status}</dd></div>
                <div><dt>Unidades entregues</dt><dd>{detail.delivery_units.length}</dd></div>
              </dl>
            </section>
            <section aria-label="Estado do pagamento">
              <h3 className="admin-subheading">Pagamento</h3>
              <dl className="admin-detail-grid admin-detail-grid--stack">
                <div><dt>Status do pagamento</dt><dd>{PAYMENT_STATUS_LABEL[detail.order.payment_status] ?? detail.order.payment_status}</dd></div>
                <div><dt>Pago em</dt><dd>{detail.order.paid_at ? new Date(detail.order.paid_at).toLocaleString('pt-BR') : '—'}</dd></div>
              </dl>
            </section>
          </div>

          <section aria-label="Itens do pedido">
            <h3 className="admin-subheading">Itens do pedido</h3>
            <dl className="admin-detail-grid">
              <div><dt>Produto</dt><dd>{detail.order.product_name}</dd></div>
              <div><dt>Quantidade total</dt><dd>{detail.order.quantity}</dd></div>
              {typeof detail.order.items_count === 'number' && detail.order.items_count > 1 && (
                <div><dt>Itens distintos</dt><dd>{detail.order.items_count}</dd></div>
              )}
              <div><dt>Valor total</dt><dd>{formatCurrency(detail.order.total_cents)}</dd></div>
            </dl>
            <p className="field-hint">
              O painel exibe o resumo registrado no pedido (produto, quantidade e valor). O detalhamento item a item não é
              exposto pela API administrativa.
            </p>
          </section>

          {detail.payments.length > 0 && (
            <section aria-label="Registros de pagamento">
              <h3 className="admin-subheading">Registros de pagamento</h3>
              <div className="admin-table-wrapper">
                <table className="admin-table">
                  <thead>
                    <tr><th>Provedor</th><th>Status</th><th>Valor</th><th>Criado em</th></tr>
                  </thead>
                  <tbody>
                    {detail.payments.map((payment, index) => (
                      <tr key={index}>
                        <td>{String(payment.provider ?? '—')}</td>
                        <td>{String(payment.status ?? '—')}</td>
                        <td>{typeof payment.amount_cents === 'number' ? formatCurrency(payment.amount_cents) : '—'}</td>
                        <td>{payment.created_at ? new Date(String(payment.created_at)).toLocaleString('pt-BR') : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {(detail.order.status === 'disputed' || detail.order.payment_status === 'charged_back') && (
            <div className="admin-panel admin-nested">
              <h3>Contestação (chargeback)</h3>
              <p className="field-hint">
                O pagamento foi contestado no Mercado Pago. A entrega continua válida até uma decisão: contestação
                não é reembolso. Registre o resultado após tratar o caso no Mercado Pago.
              </p>
              <div className="admin-row-actions">
                <button className="button button--secondary button--small" type="button" onClick={() => askResolveDispute(detail.order.id, detail.order.reference, 'refund')}>
                  Reembolsar e encerrar
                </button>
                <button className="button button--secondary button--small" type="button" onClick={() => askResolveDispute(detail.order.id, detail.order.reference, 'reinstated')}>
                  Contestação revertida (valor recuperado)
                </button>
                <button className="button button--secondary button--small" type="button" onClick={() => askResolveDispute(detail.order.id, detail.order.reference, 'refund_pending')}>
                  Manter em análise
                </button>
              </div>
            </div>
          )}

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
                  onClick={() => askRevokeDelivery(detail.delivery!.id, detail.order.reference)}
                  disabled={detail.delivery.status === 'revoked'}
                >
                  Revogar link
                </button>
                <button className="button button--secondary button--small" type="button" onClick={() => askRotateDelivery(detail.delivery!.id, detail.order.reference)}>
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
                        <button className="link-button" type="button" onClick={() => askResolveRefund(refund.id, detail.order.reference, 'authorized')}>Autorizar</button>
                        <button className="link-button" type="button" onClick={() => askResolveRefund(refund.id, detail.order.reference, 'processed')}>Processado</button>
                        <button className="link-button" type="button" onClick={() => askResolveRefund(refund.id, detail.order.reference, 'rejected')}>Recusar</button>
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
      <ConfirmActionDialog
        open={confirmAction !== null}
        title={confirmAction?.title ?? ''}
        description={confirmAction?.description ?? ''}
        confirmLabel={confirmAction?.confirmLabel ?? 'Confirmar'}
        danger={confirmAction?.danger ?? true}
        busy={confirmBusy}
        onConfirm={() => void runConfirm()}
        onCancel={cancelConfirm}
      />
    </div>
  );
}
