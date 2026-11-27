import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { CatalogProvider } from '../../context/CatalogContext';
import { CartProvider } from '../../context/CartContext';
import { ToastProvider } from '../../context/ToastContext';
import type { AdminSession } from '../../services/adminAuth';

/**
 * Área de Segurança do painel administrativo (gestão de autenticadores TOTP).
 *
 * Garante na interface, através do AdminPage real:
 *  - a área de Segurança existe para administrador autenticado com AAL2;
 *  - autenticadores verificados e pendentes são distinguíveis;
 *  - cadastro do segundo autenticador exige confirmação do código;
 *  - remoção de fator passa por confirmação explícita (diálogo);
 *  - o único fator verificado não oferece remoção na interface;
 *  - cadastro incompleto pode ser descartado;
 *  - o modo demonstrativo NÃO expõe a área de Segurança.
 */

const state = vi.hoisted(() => ({
  session: null as AdminSession | null,
  demo: false,
  getCurrentSessionCalls: 0,
  enrollCalls: 0,
  enrollResult: {
    ok: true as const,
    value: { factorId: 'factor-novo', qrCode: 'data:image/svg+xml;base64,PHN2Zy8+', secret: 'SEGREDO-DE-TESTE' },
  },
  verifyCalls: [] as Array<[string, string]>,
  verifyResult: { ok: true as const, value: null as AdminSession | null },
  discardCalls: 0,
  discardResult: { ok: true as const, value: true as const },
  removeCalls: [] as string[],
  removeResult: { ok: true as const, value: null as AdminSession | null },
}));

vi.mock('../../services/adminAuth', () => ({
  isAdminDemoSession: () => state.demo,
  canUseAdminDemo: () => true,
  setAdminDemoSession: (value: boolean) => {
    state.demo = value;
  },
  getCurrentSession: async () => {
    state.getCurrentSessionCalls += 1;
    return { ok: true as const, value: state.session };
  },
  signOutAdmin: async () => undefined,
  signInWithPassword: vi.fn(async () => ({ ok: false as const, message: 'Acesso administrativo negado.' })),
  requestPasswordReset: vi.fn(async () => ({ ok: true as const, value: true as const })),
  startTotpEnrollment: vi.fn(async () => ({ ok: false as const, message: 'não usado nestes testes' })),
  enrollTotpFactor: async () => {
    state.enrollCalls += 1;
    return state.enrollResult;
  },
  verifyTotp: async (factorId: string, code: string) => {
    state.verifyCalls.push([factorId, code]);
    return state.verifyResult;
  },
  discardPendingEnrollment: async () => {
    state.discardCalls += 1;
    return state.discardResult;
  },
  removeTotpFactor: async (factorId: string) => {
    state.removeCalls.push(factorId);
    return state.removeResult;
  },
}));

const INDICATORS = {
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
  generated_at: '2026-11-27T12:00:00.000Z',
};

vi.mock('../../services/adminApi', () => ({
  adminApi: {
    indicators: vi.fn(async () => INDICATORS),
    listRefunds: vi.fn(async () => ({ refunds: [] })),
    auditLog: vi.fn(async () => ({ entries: [] })),
    listProducts: vi.fn(async () => ({ products: [] })),
    getProduct: vi.fn(async () => ({ product: null, price_history: [] })),
    createProduct: vi.fn(),
    updateProduct: vi.fn(),
    setProductActive: vi.fn(),
    stockSummary: vi.fn(async () => ({ products: [], totals: { total_units: 0, available_units: 0, reserved_units: 0, sold_units: 0, disabled_units: 0 } })),
    listStock: vi.fn(async () => ({ items: [], total: 0, limit: 100, offset: 0 })),
    addStock: vi.fn(),
    updateStock: vi.fn(),
    setStockStatus: vi.fn(),
    previewImport: vi.fn(),
    commitImport: vi.fn(),
    listOrders: vi.fn(async () => ({ items: [], total: 0, limit: 100, offset: 0 })),
    getOrder: vi.fn(),
    listRefundsAll: vi.fn(),
    resolveRefund: vi.fn(),
    resolveDispute: vi.fn(),
    revokeDelivery: vi.fn(),
    rotateDelivery: vi.fn(),
    expireReservations: vi.fn(),
  },
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <CatalogProvider>
        <CartProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </CartProvider>
      </CatalogProvider>
    </MemoryRouter>,
  );
}

function adminSession(overrides: Partial<AdminSession> = {}): AdminSession {
  return {
    userId: '00000000-0000-4000-8000-000000000001',
    email: 'dono@prime-store.test',
    currentLevel: 'aal2',
    nextLevel: 'aal2',
    pendingTotp: false,
    factors: [{ id: 'f-principal', friendlyName: 'Celular pessoal' }],
    pendingFactors: [],
    isAdmin: true,
    mfaSatisfied: true,
    adminCheckError: null,
    factorError: null,
    canEnrollMore: true,
    ...overrides,
  };
}

async function openSecurityTab(user: ReturnType<typeof userEvent.setup>) {
  const tabs = await screen.findByRole('navigation', { name: 'Seções do painel' });
  await user.click(within(tabs).getByRole('button', { name: 'Segurança' }));
  await screen.findByRole('heading', { name: 'Autenticadores do painel' });
}

beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://exemplo.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'chave-anon');
  vi.stubEnv('VITE_BACKEND_ENABLED', 'true');
  vi.stubEnv('VITE_ADMIN_DEMO', 'false');
  state.session = adminSession();
  state.demo = false;
  state.getCurrentSessionCalls = 0;
  state.enrollCalls = 0;
  state.verifyCalls = [];
  state.verifyResult = { ok: true, value: null };
  state.discardCalls = 0;
  state.removeCalls = [];
  state.removeResult = { ok: true, value: null };
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('área de Segurança do painel', () => {
  it('existe para administrador real, lista autenticadores e não oferece remoção do único fator', async () => {
    const user = userEvent.setup();
    renderAt('/admin');

    await openSecurityTab(user);

    expect(screen.getByText('Celular pessoal')).toBeInTheDocument();
    expect(screen.getByText('Ativo (verificado)')).toBeInTheDocument();
    // Único fator verificado: remoção indisponível na interface.
    expect(screen.queryByRole('button', { name: 'Remover' })).not.toBeInTheDocument();
    // Segundo autenticador pode ser cadastrado.
    expect(screen.getByRole('button', { name: /Adicionar segundo autenticador/i })).toBeInTheDocument();
  });

  it('cadastra o segundo autenticador e exige a confirmação do código antes de concluir', async () => {
    const user = userEvent.setup();
    renderAt('/admin');

    await openSecurityTab(user);
    await user.click(screen.getByRole('button', { name: /Adicionar segundo autenticador/i }));

    expect(state.enrollCalls).toBe(1);
    const qr = await screen.findByAltText('QR code para cadastrar o novo autenticador TOTP');
    expect(qr).toBeInTheDocument();
    expect(screen.getByText('SEGREDO-DE-TESTE')).toBeInTheDocument();

    const callsBefore = state.getCurrentSessionCalls;
    await user.type(screen.getByLabelText('Código de 6 dígitos'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirmar autenticador' }));

    await vi.waitFor(() => expect(state.verifyCalls).toEqual([['factor-novo', '123456']]));
    expect(await screen.findByText(/Novo autenticador adicionado e verificado/i)).toBeInTheDocument();
    // A sessão é reconsultada após a alteração de fatores.
    expect(state.getCurrentSessionCalls).toBeGreaterThan(callsBefore);
  });

  it('remove um fator antigo somente após confirmação explícita no diálogo', async () => {
    state.session = adminSession({
      factors: [
        { id: 'f-principal', friendlyName: 'Celular pessoal' },
        { id: 'f-reserva', friendlyName: 'Celular reserva' },
      ],
      canEnrollMore: false,
    });
    const user = userEvent.setup();
    renderAt('/admin');

    await openSecurityTab(user);

    const removeButtons = screen.getAllByRole('button', { name: 'Remover' });
    expect(removeButtons).toHaveLength(2);

    await user.click(removeButtons[0]);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Remover autenticador');
    expect(dialog).toHaveTextContent('Celular pessoal');

    await user.click(within(dialog).getByRole('button', { name: 'Remover' }));

    await vi.waitFor(() => expect(state.removeCalls).toEqual(['f-principal']));
    expect(await screen.findByText('Autenticador removido com sucesso.')).toBeInTheDocument();
  });

  it('descarta um cadastro incompleto (fator pendente) com confirmação', async () => {
    state.session = adminSession({
      pendingFactors: [{ id: 'f-incompleto', friendlyName: 'Reserva incompleto' }],
      canEnrollMore: false,
    });
    const user = userEvent.setup();
    renderAt('/admin');

    await openSecurityTab(user);

    expect(screen.getByText('Reserva incompleto')).toBeInTheDocument();
    expect(screen.getByText('Pendente (incompleto)')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Descartar' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Descartar cadastro incompleto');

    await user.click(within(dialog).getByRole('button', { name: 'Descartar' }));
    await vi.waitFor(() => expect(state.discardCalls).toBe(1));
  });

  it('modo demonstração NÃO expõe a área de Segurança', async () => {
    state.demo = true;
    state.session = adminSession({
      email: 'demonstracao@prime-store.test',
      factors: [],
      canEnrollMore: false,
    });
    renderAt('/admin');

    const tabs = await screen.findByRole('navigation', { name: 'Seções do painel' });
    expect(within(tabs).getByRole('button', { name: 'Visão geral' })).toBeInTheDocument();
    expect(within(tabs).getByRole('button', { name: 'Produtos' })).toBeInTheDocument();
    expect(within(tabs).getByRole('button', { name: 'Estoque' })).toBeInTheDocument();
    expect(within(tabs).getByRole('button', { name: 'Pedidos' })).toBeInTheDocument();
    expect(within(tabs).queryByRole('button', { name: 'Segurança' })).not.toBeInTheDocument();
  });
});
