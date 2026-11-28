import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminPage } from './AdminPage';

/**
 * Missão UX — navegação do painel.
 *
 * Verifica apenas a camada de apresentação da navegação: cada seção tem ícone
 * e descrição, a seção atual é anunciada (`aria-current="page"`) e o título da
 * área aberta aparece acima do conteúdo. A proteção de acesso continua
 * testada em `adminRoute.test.tsx`.
 */

vi.mock('../../services/backend/config', () => ({
  getBackendConfig: () => ({
    enabled: true,
    supabaseUrl: 'https://projeto.teste.supabase.co',
    anonKey: 'chave-anon-publica',
    functionsUrl: 'https://projeto.teste.supabase.co/functions/v1',
  }),
}));

vi.mock('../../services/adminAuth', () => ({
  // Recuperação de senha / perfil operacional (missão de autenticação operacional).
  isPasswordRecoveryPending: () => false,
  clearPasswordRecovery: () => undefined,
  updatePassword: async () => ({ ok: true as const, value: true as const }),
  MIN_PASSWORD_LENGTH: 8,
  isAdminDemoSession: () => false,
  canUseAdminDemo: () => false,
  setAdminDemoSession: () => undefined,
  getCurrentSession: async () => ({
    ok: true as const,
    value: { userId: 'admin-1', email: 'admin@primestore.test', isAdmin: true, mfaSatisfied: true },
  }),
  signOutAdmin: async () => undefined,
}));

const api = vi.hoisted(() => ({
  indicators: vi.fn(),
  listRefunds: vi.fn(),
  auditLog: vi.fn(),
  listOrders: vi.fn(),
  listProducts: vi.fn(),
  listStock: vi.fn(),
  stockSummary: vi.fn(),
}));

vi.mock('../../services/adminApi', () => ({ adminApi: api }));

beforeEach(() => {
  api.indicators.mockResolvedValue({
    orders_total: 0,
    orders_pending_payment: 0,
    orders_paid: 0,
    orders_expired: 0,
    orders_refund_pending: 0,
    orders_refunded: 0,
    orders_disputed: 0,
    orders_failed: 0,
    payments_charged_back: 0,
    revenue_total_cents: 0,
    revenue_30d_cents: 0,
    units_sold: 0,
    units_available: 0,
    units_reserved: 0,
    active_reservations: 0,
    open_refund_requests: 0,
    deliveries_active: 0,
    deliveries_revoked: 0,
    products_active: 0,
    products_inactive: 0,
    low_stock_products: [],
    generated_at: '2026-11-17T12:00:00.000Z',
  });
  api.listRefunds.mockResolvedValue({ refunds: [] });
  api.auditLog.mockResolvedValue({ entries: [] });
  api.listOrders.mockResolvedValue({ items: [], total: 0, limit: 10, offset: 0 });
  api.listProducts.mockResolvedValue({ products: [] });
  api.listStock.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
  api.stockSummary.mockResolvedValue({ products: [], totals: { total_units: 0, available_units: 0, reserved_units: 0, sold_units: 0, disabled_units: 0 } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AdminPage — navegação do painel (missão UX)', () => {
  it('identifica a seção atual e mostra o título/descrição da área aberta', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>,
    );

    const nav = await screen.findByRole('navigation', { name: 'Seções do painel' });
    expect(nav).toBeInTheDocument();
    const overviewTab = screen.getByRole('button', { name: 'Visão geral' });
    expect(overviewTab).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 2, name: 'Visão geral' })).toBeInTheDocument();
    expect(screen.getByText(/Situação comercial da loja, pedidos recentes/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Produtos' }));

    expect(screen.getByRole('button', { name: 'Produtos' })).toHaveAttribute('aria-current', 'page');
    expect(overviewTab).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('heading', { level: 2, name: 'Produtos' })).toBeInTheDocument();
    expect(screen.getByText(/Cadastre, edite, ative ou desative/)).toBeInTheDocument();

    // As quatro áreas existentes continuam acessíveis pela barra.
    await waitFor(() => expect(api.listProducts).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Estoque' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pedidos' })).toBeInTheDocument();
  });
});
