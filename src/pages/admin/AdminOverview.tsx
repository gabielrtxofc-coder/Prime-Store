import { useCallback, useEffect, useMemo, useState } from 'react';
import { describeBackendError } from '../../services/backend/http';
import {
  adminApi,
  type AdminAuditEntry,
  type AdminIndicators,
  type AdminOrderRow,
  type AdminProduct,
  type AdminRefund,
} from '../../services/adminApi';
import { formatCurrency } from '../../lib/format';
import { presetToRange, type PeriodPreset } from '../../lib/period';
import { PeriodFilter } from '../../components/admin/PeriodFilter';
import { ConfirmActionDialog } from '../../components/admin/ConfirmActionDialog';
import { useConfirmAction } from '../../components/admin/useConfirmAction';

interface PeriodSummary {
  rangeFrom: string | null;
  rangeTo: string | null;
  /** Todos os pedidos criados no período (qualquer estado). */
  allTotal: number;
  /** Pedidos em `requested`/`not_required` — solicitações, nunca vendas. */
  requestedTotal: number;
  /** Pedidos em `paid` (pagamento aprovado) no período. */
  paidTotal: number;
  /** Pedidos reembolsados no período. */
  refundedTotal: number;
  recent: AdminOrderRow[];
  revenueCents: number;
  revenueComplete: boolean;
}

const PAGE_LIMIT = 200; // limite máximo aplicado pelo backend (`admin_list_orders`)

export function AdminOverview() {
  const [indicators, setIndicators] = useState<AdminIndicators | null>(null);
  const [period, setPeriod] = useState<PeriodSummary | null>(null);
  const [topProducts, setTopProducts] = useState<AdminProduct[] | null>(null);
  const [productsError, setProductsError] = useState<string | null>(null);
  const [refunds, setRefunds] = useState<AdminRefund[]>([]);
  const [audit, setAudit] = useState<AdminAuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { pending: confirmAction, busy: confirmBusy, request: requestConfirm, cancel: cancelConfirm, confirm: runConfirm } = useConfirmAction();
  const [busy, setBusy] = useState(false);
  const [preset, setPreset] = useState<PeriodPreset>('30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const range = useMemo(() => presetToRange(preset, customFrom, customTo), [preset, customFrom, customTo]);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const from = range.from;
      const to = range.to;
      const [
        indicatorsResult,
        refundsResult,
        auditResult,
        recent,
        requested,
        paid,
        refunded,
        revenuePaid,
        revenueRefundPending,
      ] = await Promise.all([
        adminApi.indicators(),
        adminApi.listRefunds('pending'),
        adminApi.auditLog(15),
        adminApi.listOrders({ from, to, limit: 8 }),
        adminApi.listOrders({ from, to, status: 'requested', limit: 1 }),
        adminApi.listOrders({ from, to, status: 'paid', limit: 1 }),
        adminApi.listOrders({ from, to, status: 'refunded', limit: 1 }),
        adminApi.listOrders({ from, to, status: 'paid', limit: PAGE_LIMIT }),
        adminApi.listOrders({ from, to, status: 'refund_pending', limit: PAGE_LIMIT }),
      ]);
      setIndicators(indicatorsResult);
      setRefunds(refundsResult.refunds);
      setAudit(auditResult.entries);
      // Mesmo critério da receita do servidor: paid + refund_pending.
      const revenueCents = [...revenuePaid.items, ...revenueRefundPending.items].reduce(
        (sum, order) => sum + order.total_cents,
        0,
      );
      setPeriod({
        rangeFrom: from,
        rangeTo: to,
        allTotal: recent.total,
        requestedTotal: requested.total,
        paidTotal: paid.total,
        refundedTotal: refunded.total,
        recent: recent.items,
        revenueCents,
        revenueComplete: revenuePaid.total <= PAGE_LIMIT && revenueRefundPending.total <= PAGE_LIMIT,
      });
      setError(null);
    } catch (loadError) {
      setError(describeBackendError(loadError));
    } finally {
      setBusy(false);
    }
    // "Mais vendidos" é complementar: falha aqui não derruba os indicadores.
    try {
      const productsResult = await adminApi.listProducts();
      const ranked = productsResult.products
        .filter((product) => product.sold_units > 0)
        .sort((a, b) => b.sold_units - a.sold_units)
        .slice(0, 5);
      setTopProducts(ranked);
      setProductsError(null);
    } catch (productsLoadError) {
      setTopProducts(null);
      setProductsError(describeBackendError(productsLoadError));
    }
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  const REFUND_COPY: Record<'authorized' | 'processed' | 'rejected', { title: string; description: string; confirmLabel: string; danger: boolean }> = {
    authorized: {
      title: 'Autorizar reembolso?',
      description: 'O reembolso será autorizado e entrará na fila de execução. O dinheiro precisa ser devolvido fora da loja (no Mercado Pago). A autorização fica registrada em auditoria.',
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

  const askResolveRefund = (refundId: string, reference: string, status: 'authorized' | 'processed' | 'rejected') => {
    const copy = REFUND_COPY[status];
    requestConfirm({
      ...copy,
      description: `Reembolso ${reference}: ${copy.description}`,
      action: async () => {
        try {
          await adminApi.resolveRefund(refundId, status, `Resolvido pelo painel (${status}).`);
          setNotice(`Reembolso marcado como ${status}.`);
          await load();
        } catch (resolveError) {
          setError(describeBackendError(resolveError));
        }
      },
    });
  };

  const expireNow = () => {
    requestConfirm({
      title: 'Liberar reservas vencidas?',
      description: 'Reservas de credenciais com prazo vencido serão liberadas: as unidades voltam para o estoque disponível e os pedidos associados expiram. Pedidos pagos e entregas válidas não são afetados.',
      confirmLabel: 'Liberar reservas vencidas',
      danger: true,
      action: async () => {
        try {
          const result = await adminApi.expireReservations();
          setNotice(`Reservas expiradas processadas: ${JSON.stringify(result)}`);
          await load();
        } catch (expireError) {
          setError(describeBackendError(expireError));
        }
      },
    });
  };

  return (
    <div className="admin-section">
      {error && <div className="payment-warning" role="alert"><p>{error}</p></div>}
      {notice && <p className="admin-notice" role="status">{notice}</p>}

      <div className="admin-toolbar">
        <PeriodFilter
          idPrefix="overview"
          preset={preset}
          customFrom={customFrom}
          customTo={customTo}
          onPresetChange={setPreset}
          onCustomFromChange={setCustomFrom}
          onCustomToChange={setCustomTo}
        />
        <button className="button button--secondary button--small" type="button" onClick={() => void load()} disabled={busy}>
          {busy ? 'Atualizando…' : 'Atualizar dados'}
        </button>
        <button className="button button--secondary button--small" type="button" onClick={expireNow}>
          Liberar reservas vencidas agora
        </button>
      </div>

      <div className="admin-panel" aria-busy={busy}>
        <div className="admin-panel__header">
          <h2>No período selecionado</h2>
          <span className="field-hint">
            Datas reais de criação dos pedidos (created_at)
            {period?.rangeFrom ? ` · desde ${new Date(period.rangeFrom).toLocaleDateString('pt-BR')}` : ''}
            {period?.rangeTo ? ` · até ${new Date(period.rangeTo).toLocaleDateString('pt-BR')}` : ''}
          </span>
        </div>
        {period ? (
          <>
            <div className="admin-metrics">
              <Metric label="Pedidos recebidos" value={period.allTotal} hint="Todos os estados, inclusive solicitações" />
              <Metric label="Solicitações sem pagamento" value={period.requestedTotal} hint="status requested · não são vendas" />
              <Metric label="Vendas pagas" value={period.paidTotal} hint="status paid · pagamento aprovado" />
              <Metric
                label={period.revenueComplete ? 'Receita confirmada' : 'Receita confirmada ≥'}
                value={formatCurrency(period.revenueCents)}
                hint="paid + refund_pending do período (reembolsados/disputados fora)"
              />
              <Metric label="Pedidos reembolsados" value={period.refundedTotal} hint="status refunded" />
            </div>
            {!period.revenueComplete && (
              <p className="field-hint" role="note">
                Há mais de {PAGE_LIMIT} pedidos pagos no período: a receita exibida é uma soma parcial dos {PAGE_LIMIT} mais
                recentes. Os contadores acima continuam exatos.
              </p>
            )}
            <h3 className="admin-subheading">Pedidos recentes</h3>
            {period.recent.length === 0 ? (
              <p className="field-hint">Nenhum pedido criado neste período.</p>
            ) : (
              <div className="admin-table-wrapper">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Pedido</th>
                      <th>Produto</th>
                      <th>Criado</th>
                      <th>Valor</th>
                      <th>Pagamento</th>
                      <th>Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {period.recent.map((order) => (
                      <tr key={order.id}>
                        <td><code>{order.reference}</code></td>
                        <td>{order.product_name}</td>
                        <td>{new Date(order.created_at).toLocaleString('pt-BR')}</td>
                        <td>{formatCurrency(order.total_cents)}</td>
                        <td>{order.payment_status}</td>
                        <td>
                          {order.status}
                          {order.status === 'requested' && <span className="admin-badge"> solicitação</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <p className="field-hint">Carregando indicadores do período…</p>
        )}
      </div>

      {indicators && (
        <div className="admin-panel">
          <div className="admin-panel__header">
            <h2>Acumulado geral (servidor)</h2>
            <span className="field-hint">Totais históricos calculados pelo banco · nunca inclui not_required</span>
          </div>
          <div className="admin-metrics">
            <Metric label="Receita aprovada (total)" value={formatCurrency(indicators.revenue_total_cents)} hint="paid + refund_pending, histórico" />
            <Metric label="Receita (30 dias)" value={formatCurrency(indicators.revenue_30d_cents)} hint="mesmo critério, últimos 30 dias" />
            <Metric label="Pedidos pagos (total)" value={indicators.orders_paid} hint={`${indicators.orders_total} pedidos no total`} />
            <Metric label="Aguardando pagamento" value={indicators.orders_pending_payment} hint="pending_payment · não são pagas" />
            <Metric label="Reservas ativas" value={indicators.active_reservations} />
            <Metric label="Reembolsos abertos" value={indicators.open_refund_requests} hint={`${indicators.orders_refunded} pedido(s) reembolsado(s)`} />
            <Metric label="Disputas abertas" value={indicators.orders_disputed} hint={`${indicators.payments_charged_back} chargeback(s)`} />
            <Metric label="Unidades disponíveis" value={indicators.units_available} hint={`${indicators.units_reserved} reservada(s)`} />
            <Metric label="Unidades vendidas" value={indicators.units_sold} />
            <Metric label="Produtos ativos" value={indicators.products_active} hint={`${indicators.products_inactive} inativo(s)`} />
            <Metric label="Entregas ativas" value={indicators.deliveries_active} hint={`${indicators.deliveries_revoked} revogada(s)`} />
          </div>

          {indicators.low_stock_products.length > 0 && (
            <>
              <h3 className="admin-subheading">Estoque baixo (≤ 2 unidades)</h3>
              <ul className="admin-list">
                {indicators.low_stock_products.map((product) => (
                  <li key={product.id}>
                    <span>{product.name}</span>
                    <strong>{product.available_units} disponíveis</strong>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {productsError && (
        <div className="payment-warning" role="alert">
          <p>Não foi possível carregar o ranking de produtos: {productsError}</p>
        </div>
      )}
      {topProducts && topProducts.length > 0 && (
        <div className="admin-panel">
          <div className="admin-panel__header">
            <h2>Mais vendidos (total histórico)</h2>
            <span className="field-hint">Unidades vendidas registradas no estoque — não é um ranking do período</span>
          </div>
          <ol className="admin-list admin-list--ranked">
            {topProducts.map((product) => (
              <li key={product.id}>
                <span>{product.name}</span>
                <strong>{product.sold_units} unidade(s)</strong>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="admin-panel">
        <h2>Reembolsos pendentes</h2>
        {refunds.length === 0 ? (
          <p className="field-hint">Nenhum reembolso aguardando decisão.</p>
        ) : (
          <ul className="admin-list">
            {refunds.map((refund) => (
              <li key={refund.id}>
                <div>
                  <strong>{refund.reference}</strong>
                  <span>{refund.product_name} · {formatCurrency(refund.amount_cents)}</span>
                  <span className="field-hint">{refund.reason}</span>
                </div>
                <div className="admin-row-actions">
                  <button className="button button--secondary button--small" type="button" onClick={() => askResolveRefund(refund.id, refund.reference, 'authorized')}>
                    Autorizar
                  </button>
                  <button className="button button--secondary button--small" type="button" onClick={() => askResolveRefund(refund.id, refund.reference, 'processed')}>
                    Marcar como processado
                  </button>
                  <button className="button button--secondary button--small" type="button" onClick={() => askResolveRefund(refund.id, refund.reference, 'rejected')}>
                    Recusar
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="admin-panel">
        <h2>Últimas ações administrativas</h2>
        {audit.length === 0 ? (
          <p className="field-hint">Sem registros de auditoria ainda.</p>
        ) : (
          <ul className="admin-audit">
            {audit.map((entry) => (
              <li key={entry.id}>
                <code>{new Date(entry.created_at).toLocaleString('pt-BR')}</code>
                <strong>{entry.action}</strong>
                <span>{entry.entity_type ?? '—'} {entry.entity_id ? `· ${entry.entity_id.slice(0, 8)}…` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
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

function Metric({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="admin-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {hint && <small>{hint}</small>}
    </div>
  );
}
