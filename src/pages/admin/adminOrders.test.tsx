import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminOrders } from './AdminOrders';
import type { AdminOrderDetail, AdminOrderList, AdminOrderRow } from '../../services/adminApi';

/**
 * Missão 03.2E — pedidos reais com pagamento separado do estado do pedido.
 *
 * Garante: filtros reais (incluindo `requested`/`not_required`), filtro de
 * período com datas reais, estados por extenso, PII fora do painel, ausência
 * de qualquer ação manual de aprovação/confirmação de pagamento e estado
 * vazio honesto.
 */

const api = vi.hoisted(() => ({
  listOrders: vi.fn(),
  getOrder: vi.fn(),
  revokeDelivery: vi.fn(),
  rotateDelivery: vi.fn(),
  resolveDispute: vi.fn(),
  resolveRefund: vi.fn(),
}));

vi.mock('../../services/adminApi', () => ({ adminApi: api }));

const REQUESTED_ORDER: AdminOrderRow = {
  id: 'order-req',
  reference: 'PS-SOLIC1',
  product_id: 'prod-1',
  product_name: 'Conta Solicitação',
  quantity: 2,
  unit_price_cents: 2990,
  total_cents: 5980,
  status: 'requested',
  payment_status: 'not_required',
  delivery_status: 'not_ready',
  created_at: '2026-11-08T10:00:00.000Z',
  paid_at: null,
  reservation_expires_at: '2026-11-08T10:30:00.000Z',
  delivery_id: null,
  delivery_link_status: null,
  open_refund_requests: 0,
  items_count: 1,
};

const PAID_ORDER: AdminOrderRow = {
  ...REQUESTED_ORDER,
  id: 'order-paid',
  reference: 'PS-PAGO01',
  product_name: 'Conta Paga',
  status: 'paid',
  payment_status: 'approved',
  delivery_status: 'ready',
  paid_at: '2026-11-08T09:00:00.000Z',
  delivery_id: 'delivery-1',
  delivery_link_status: 'active',
};

const LIST: AdminOrderList = { items: [REQUESTED_ORDER, PAID_ORDER], total: 2, limit: 100, offset: 0 };
const EMPTY_LIST: AdminOrderList = { items: [], total: 0, limit: 100, offset: 0 };

const DETAIL: AdminOrderDetail = {
  order: {
    ...REQUESTED_ORDER,
    // O backend entrega `buyer_name`/`buyer_email` no payload (todas as
    // colunas menos o hash) — o painel NÃO pode renderizá-los.
    ...({ buyer_name: 'Cliente Fulano', buyer_email: 'comprador@exemplo.com' } as Record<string, unknown>),
  },
  payments: [],
  delivery: null,
  delivery_units: [],
  events: [
    { id: 11, event_type: 'order_created', actor: 'customer', created_at: '2026-11-08T10:00:00.000Z', metadata: {} },
  ],
  refund_requests: [],
};

beforeEach(() => {
  api.listOrders.mockResolvedValue(LIST);
  api.getOrder.mockResolvedValue(DETAIL);
  api.revokeDelivery.mockResolvedValue({ ok: true });
  api.rotateDelivery.mockResolvedValue({ delivery_url: 'https://exemplo.com/entrega/novo' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AdminOrders (missão 03.2E)', () => {
  it('lista pedidos reais com selos de solicitação/sem cobrança', async () => {
    render(<AdminOrders />);
    expect(await screen.findByText('PS-SOLIC1')).toBeInTheDocument();
    expect(screen.getByText('solicitação')).toBeInTheDocument();
    expect(screen.getByText('sem cobrança')).toBeInTheDocument();
    expect(screen.getByText('PS-PAGO01')).toBeInTheDocument();
  });

  it('filtros incluem os estados reais requested e not_required', async () => {
    render(<AdminOrders />);
    await screen.findByText('PS-SOLIC1');

    const statusSelect = screen.getByLabelText('Status do pedido');
    const statusValues = [...statusSelect.querySelectorAll('option')].map((option) => option.value);
    expect(statusValues).toContain('requested');
    expect(statusValues).toContain('pending_payment');
    expect(statusValues).toContain('paid');

    const paymentSelect = screen.getByLabelText('Status do pagamento');
    const paymentValues = [...paymentSelect.querySelectorAll('option')].map((option) => option.value);
    expect(paymentValues).toContain('not_required');
    expect(paymentValues).toContain('approved');
  });

  it('filtro de período envia datas reais ao backend (30d por padrão)', async () => {
    render(<AdminOrders />);
    await screen.findByText('PS-SOLIC1');

    const firstCall = api.listOrders.mock.calls[0][0];
    expect(firstCall.from).toBeTruthy();
    expect(firstCall.to).toBeNull();
    const delta = Date.now() - Date.parse(firstCall.from);
    expect(delta).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    expect(delta).toBeLessThan(31 * 24 * 60 * 60 * 1000);

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Período dos indicadores'), 'all');
    await waitFor(() => {
      const calls = api.listOrders.mock.calls;
      const lastCall = calls[calls.length - 1][0];
      expect(lastCall.from).toBeNull();
      expect(lastCall.to).toBeNull();
    });
  });

  it('busca é encaminhada ao backend', async () => {
    const user = userEvent.setup();
    render(<AdminOrders />);
    await screen.findByText('PS-SOLIC1');
    api.listOrders.mockClear();
    await user.type(screen.getByLabelText('Buscar pedidos'), 'PS-S');
    await waitFor(() => {
      expect(api.listOrders).toHaveBeenCalledWith(expect.objectContaining({ search: 'PS-S' }));
    });
  });

  it('detalhe separa Pedido de Pagamento e rotula requested/not_required', async () => {
    const user = userEvent.setup();
    render(<AdminOrders />);
    await screen.findByText('PS-SOLIC1');

    await user.click(screen.getAllByRole('button', { name: 'Detalhes' })[0]);
    expect(await screen.findByRole('region', { name: 'Estado do pedido' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Estado do pagamento' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Itens do pedido' })).toBeInTheDocument();

    // not_required rotulado como ausência de pagamento — nunca como confirmado
    expect(screen.getAllByText(/not_required — sem pagamento \(solicitação\)/).length).toBeGreaterThan(0);

    // Banner de solicitação sem pagamento, sem ação de aprovação
    expect(screen.getByText(/Solicitação sem pagamento\./)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /aprovar|confirmar pagamento|marcar como pago|marcar pago|marcar como entregue/i }),
    ).not.toBeInTheDocument();
  });

  it('detalhe NUNCA renderiza dados pessoais do comprador (buyer_*)', async () => {
    const user = userEvent.setup();
    render(<AdminOrders />);
    await screen.findByText('PS-SOLIC1');
    await user.click(screen.getAllByRole('button', { name: 'Detalhes' })[0]);
    await screen.findByRole('region', { name: 'Estado do pedido' });

    expect(screen.queryByText('Cliente Fulano')).not.toBeInTheDocument();
    expect(screen.queryByText('comprador@exemplo.com')).not.toBeInTheDocument();
  });

  it('detalhe mostra paid_at real e não oferece confirmação manual', async () => {
    api.getOrder.mockResolvedValue({
      ...DETAIL,
      order: { ...PAID_ORDER, paid_at: '2026-11-08T09:00:00.000Z' },
      payments: [{ provider: 'mercado_pago', status: 'approved', amount_cents: 5980, created_at: '2026-11-08T09:00:00.000Z' }],
    });
    const user = userEvent.setup();
    render(<AdminOrders />);
    await screen.findByText('PS-PAGO01');

    await user.click(screen.getAllByRole('button', { name: 'Detalhes' })[1]);
    expect(await screen.findByRole('region', { name: 'Registros de pagamento' })).toBeInTheDocument();
    expect(screen.getByText('mercado_pago')).toBeInTheDocument();
    expect(screen.getAllByText(/approved — aprovado/).length).toBeGreaterThan(0);
    expect(
      screen.queryByRole('button', { name: /aprovar|confirmar|marcar/i }),
    ).not.toBeInTheDocument();
  });

  it('estado vazio é honesto quando a busca não encontra nada', async () => {
    api.listOrders.mockResolvedValue(EMPTY_LIST);
    render(<AdminOrders />);
    expect(await screen.findByText('Nenhum pedido encontrado.')).toBeInTheDocument();
    expect(screen.getByText(/0 pedido\(s\) no total/)).toBeInTheDocument();
  });

  it('erro de carregamento mostra alerta e não inventa pedidos', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    api.listOrders.mockRejectedValue(new Error('falha ao listar'));
    render(<AdminOrders />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('PS-SOLIC1')).not.toBeInTheDocument();
    consoleError.mockRestore();
  });
});
