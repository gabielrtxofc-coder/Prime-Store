import { useCallback, useEffect, useState } from 'react';
import { describeBackendError } from '../../services/backend/http';
import { adminApi, type AdminAuditEntry, type AdminIndicators, type AdminRefund } from '../../services/adminApi';
import { formatCurrency } from '../../lib/format';

export function AdminOverview() {
  const [indicators, setIndicators] = useState<AdminIndicators | null>(null);
  const [refunds, setRefunds] = useState<AdminRefund[]>([]);
  const [audit, setAudit] = useState<AdminAuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [indicatorsResult, refundsResult, auditResult] = await Promise.all([
        adminApi.indicators(),
        adminApi.listRefunds('pending'),
        adminApi.auditLog(15),
      ]);
      setIndicators(indicatorsResult);
      setRefunds(refundsResult.refunds);
      setAudit(auditResult.entries);
      setError(null);
    } catch (loadError) {
      setError(describeBackendError(loadError));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resolveRefund = async (refundId: string, status: 'authorized' | 'processed' | 'rejected') => {
    try {
      await adminApi.resolveRefund(refundId, status, `Resolvido pelo painel (${status}).`);
      setNotice(`Reembolso marcado como ${status}.`);
      await load();
    } catch (resolveError) {
      setError(describeBackendError(resolveError));
    }
  };

  const expireNow = async () => {
    try {
      const result = await adminApi.expireReservations();
      setNotice(`Reservas expiradas processadas: ${JSON.stringify(result)}`);
      await load();
    } catch (expireError) {
      setError(describeBackendError(expireError));
    }
  };

  return (
    <div className="admin-section">
      {error && <div className="payment-warning" role="alert"><p>{error}</p></div>}
      {notice && <p className="admin-notice" role="status">{notice}</p>}

      <div className="admin-toolbar">
        <button className="button button--secondary button--small" type="button" onClick={() => void load()} disabled={busy}>
          {busy ? 'Atualizando…' : 'Atualizar dados'}
        </button>
        <button className="button button--secondary button--small" type="button" onClick={expireNow}>
          Liberar reservas vencidas agora
        </button>
      </div>

      {indicators && (
        <>
          <div className="admin-metrics">
            <Metric label="Receita aprovada" value={formatCurrency(indicators.revenue_total_cents)} hint="Pedidos pagos e reembolsos pendentes" />
            <Metric label="Receita (30 dias)" value={formatCurrency(indicators.revenue_30d_cents)} />
            <Metric label="Pedidos pagos" value={indicators.orders_paid} hint={`${indicators.orders_total} pedidos no total`} />
            <Metric label="Aguardando PIX" value={indicators.orders_pending_payment} />
            <Metric label="Reservas ativas" value={indicators.active_reservations} />
            <Metric label="Reembolsos abertos" value={indicators.open_refund_requests} hint={`${indicators.orders_refunded} reembolsado(s)`} />
            <Metric label="Disputas abertas" value={indicators.orders_disputed} hint={`${indicators.payments_charged_back} chargeback(s)`} />
            <Metric label="Unidades disponíveis" value={indicators.units_available} />
            <Metric label="Unidades vendidas" value={indicators.units_sold} />
          </div>

          {indicators.low_stock_products.length > 0 && (
            <div className="admin-panel">
              <h2>Estoque baixo (≤ 2 unidades)</h2>
              <ul className="admin-list">
                {indicators.low_stock_products.map((product) => (
                  <li key={product.id}>
                    <span>{product.name}</span>
                    <strong>{product.available_units} disponíveis</strong>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
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
                  <button className="button button--secondary button--small" type="button" onClick={() => resolveRefund(refund.id, 'authorized')}>
                    Autorizar
                  </button>
                  <button className="button button--secondary button--small" type="button" onClick={() => resolveRefund(refund.id, 'processed')}>
                    Marcar como processado
                  </button>
                  <button className="button button--secondary button--small" type="button" onClick={() => resolveRefund(refund.id, 'rejected')}>
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
