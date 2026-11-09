import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminOverview } from './AdminOverview';
import type { AdminIndicators, AdminOrderList, AdminOrderRow, AdminProduct } from '../../services/adminApi';

/**
 * Missão 03.2B — visão geral do painel com dados reais.
 *
 * Garante as regras comerciais absolutas na interface:
 *  - solicitações (`requested`/`not_required`) NUNCA entram na receita nem
 *    são contadas como vendas ("not_required" ≠ pagamento confirmado);
 *  - a receita do período só considera pedidos `paid` + `refund_pending`;
 *  - o filtro de período chama o backend com as datas reais (`from`/`to`);
 *  - estados de vazio/erro/carregamento são visíveis e honestos.
 */

const api = vi.hoisted(() => ({
  indicators: vi.fn(),
  listRefunds: vi.fn(),
  auditLog: vi.fn(),
  listOrders: vi.fn(),
  listProducts: vi.fn(),
  expireReservations: vi.fn(),
  resolveRefund: vi.fn(),
}));

vi.mock('../../services/adminApi', () => ({ adminApi: api }));

const INDICATORS: AdminIndicators = {
  orders_total: 9,
  orders_pending_payment: 2,
  orders_paid: 4,
  orders_expired: 1,
  orders_refund_pending: 1,
  orders_refunded: 1,
  orders_disputed: 1,
  orders_failed: 0,
  payments_charged_back: 1,
  revenue_total_cents: 149700,
  revenue_30d_cents: 49900,
  units_sold: 6,
  units_available: 20,
  units_reserved: 2,
  active_reservations: 2,
  open_refund_requests: 1,
  deliveries_active: 3,
  deliveries_revoked: 1,
  products_active: 2,
  products_inactive: 1,
  low_stock_products: [],
  generated_at: '2026-11-09T12:00:00.000Z',
};

const ORDER: AdminOrderRow = {
  id: 'order-1',
  reference: 'PS-TESTE1',
  product_id: 'product-1',
  product_name: 'Conta de teste',
  quantity: 1,
  unit_price_cents: 2990,
  total_cents: 2990,
  status: 'requested',
  payment_status: 'not_required',
  delivery_status: 'not_ready',
  created_at: '2026-11-08T10:00:00.000Z',
  paid_at: null,
  reservation_expires_at: '2026-11-08T10:30:00.000Z',
  delivery_id: null,
  delivery_link_status: null,
  open_refund_requests: 0,
};

const listResult = (items: AdminOrderRow[], total = items.length): AdminOrderList => ({
  items,
  total,
  limit: items.length || 1,
  offset: 0,
});

/** Despacha respostas por filtro, como o backend faria. */
function mockListOrders(overrides: {
  recentTotal?: number;
  recentItems?: AdminOrderRow[];
  requestedTotal?: number;
  paidTotal?: number;
  refundedTotal?: number;
  paidItems?: AdminOrderRow[];
  refundPendingItems?: AdminOrderRow[];
} = {}) {
  const {
    recentTotal = 6,
    recentItems = [ORDER, { ...ORDER, id: 'order-2', reference: 'PS-TESTE2', status: 'paid', payment_status: 'approved' }],
    requestedTotal = 2,
    paidTotal = 3,
    refundedTotal = 1,
    paidItems = [{ ...ORDER, id: 'paid-1', reference: 'PS-PAID1', status: 'paid', payment_status: 'approved', total_cents: 2990 }],
    refundPendingItems = [{ ...ORDER, id: 'rp-1', reference: 'PS-RP1', status: 'refund_pending', payment_status: 'approved', total_cents: 4990 }],
  } = overrides;

  api.listOrders.mockImplementation(async (params: {
    status?: string | null;
    limit?: number;
    from?: string | null;
    to?: string | null;
  }) => {
    if (params.status === 'requested') return listResult([], requestedTotal);
    if (params.status === 'paid' && params.limit === 1) return listResult([], paidTotal);
    if (params.status === 'paid') return listResult(paidItems, paidItems.length);
    if (params.status === 'refund_pending') return listResult(refundPendingItems, refundPendingItems.length);
    if (params.status === 'refunded') return listResult([], refundedTotal);
    return listResult(recentItems, recentTotal); // chamada "recent" (limit 8, sem status)
  });
}

const productsFixture: { products: AdminProduct[] } = { products: [] };

beforeEach(() => {
  api.indicators.mockResolvedValue(INDICATORS);
  api.listRefunds.mockResolvedValue({ refunds: [] });
  api.auditLog.mockResolvedValue({ entries: [] });
  api.listProducts.mockResolvedValue(productsFixture);
  api.expireReservations.mockResolvedValue({ expired: 0 });
  mockListOrders();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AdminOverview (missão 03.2B)', () => {
  it('mostra solicitações e vendas pagas separadas — not_required nunca vira receita', async () => {
    render(<AdminOverview />);

    // Receita confirmada = 29,90 (paid) + 49,90 (refund_pending). A solicitação
    // de 14.970 centavos (pedido multi-item) fica FORA de propósito.
    const revenue = await screen.findByText('R$ 79,80');
    expect(revenue).toBeInTheDocument();

    const requestedCell = screen.getByText('Solicitações sem pagamento').closest('.admin-metric');
    expect(requestedCell).toHaveTextContent('2');

    const paidCell = screen.getByText('Vendas pagas').closest('.admin-metric');
    expect(paidCell).toHaveTextContent('3');

    const receivedCell = screen.getByText('Pedidos recebidos').closest('.admin-metric');
    expect(receivedCell).toHaveTextContent('6');
  });

  it('receita acumulada do servidor é rotulada como pagos+refund_pending histórico', async () => {
    render(<AdminOverview />);
    const totalRevenue = await screen.findByText('Receita aprovada (total)');
    expect(totalRevenue.closest('.admin-metric')).toHaveTextContent('R$ 1.497,00');
    expect(screen.getByText('paid + refund_pending, histórico')).toBeInTheDocument();
  });

  it('trocar o preset de período reemite as consultas com as datas reais', async () => {
    const user = userEvent.setup();
    render(<AdminOverview />);
    await screen.findByText('R$ 79,80');

    api.listOrders.mockClear();
    await user.selectOptions(screen.getByLabelText('Período dos indicadores'), '7d');
    await waitFor(() => {
      expect(api.listOrders).toHaveBeenCalled();
    });
    const fromArgs = api.listOrders.mock.calls.map(([params]) => params.from).filter(Boolean);
    expect(fromArgs.length).toBeGreaterThan(0);
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const from of fromArgs) {
      const delta = Math.abs(Date.parse(from as string) - sevenDaysAgo);
      expect(delta).toBeLessThan(60_000);
    }

    api.listOrders.mockClear();
    await user.selectOptions(screen.getByLabelText('Período dos indicadores'), 'all');
    await waitFor(() => {
      expect(api.listOrders).toHaveBeenCalled();
    });
    for (const [params] of api.listOrders.mock.calls) {
      expect(params.from).toBeNull();
      expect(params.to).toBeNull();
    }
  });

  it('estado vazio: período sem pedidos mostra mensagem honesta', async () => {
    mockListOrders({ recentTotal: 0, recentItems: [], requestedTotal: 0, paidTotal: 0, refundedTotal: 0, paidItems: [], refundPendingItems: [] });
    render(<AdminOverview />);
    expect(await screen.findByText('Nenhum pedido criado neste período.')).toBeInTheDocument();
    expect(screen.getByText('R$ 0,00')).toBeInTheDocument();
  });

  it('estado de erro: falha na carga mostra alerta e não inventa números', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    api.indicators.mockRejectedValue(new Error('falha de rede'));
    render(<AdminOverview />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Acumulado geral (servidor)')).not.toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('estado de carregamento é anunciado antes dos dados chegarem', async () => {
    // Todas as consultas ficam pendentes até liberarmos — assim o estado de
    // carregamento é observável de forma determinística.
    const waiters: Array<() => void> = [];
    api.listOrders.mockImplementation(
      () => new Promise<AdminOrderList>((resolve) => { waiters.push(() => resolve(listResult([], 0))); }),
    );
    render(<AdminOverview />);
    expect(screen.getByText('Carregando indicadores do período…')).toBeInTheDocument();
    waiters.forEach((release) => release());
    expect(await screen.findByText('Nenhum pedido criado neste período.')).toBeInTheDocument();
  });

  it('lista recentes com selo de solicitação para pedidos requested', async () => {
    render(<AdminOverview />);
    const table = (await screen.findByText('Pedidos recentes')).closest('div')!;
    expect(table).toHaveTextContent('PS-TESTE1');
    expect(screen.getByText('solicitação')).toBeInTheDocument();
  });

  it('ranking "Mais vendidos" só aparece com unidades vendidas de verdade', async () => {
    api.listProducts.mockResolvedValue({
      products: [
        { ...(productsFixture.products[0] ?? ({} as AdminProduct)), id: 'p1', name: 'Conta Alpha', slug: 'alpha', sold_units: 12, available_units: 3, reserved_units: 0 },
      ],
    });
    render(<AdminOverview />);
    expect(await screen.findByText(/Mais vendidos \(total histórico\)/)).toBeInTheDocument();
    expect(screen.getByText('Conta Alpha')).toBeInTheDocument();
    expect(screen.getByText('12 unidade(s)')).toBeInTheDocument();
  });
});
