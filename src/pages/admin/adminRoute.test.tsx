import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { CatalogProvider } from '../../context/CatalogContext';
import { CartProvider } from '../../context/CartContext';
import { ToastProvider } from '../../context/ToastContext';

/**
 * Missão 03.2A — rota `/admin/*` restaurada como chunk sob demanda.
 *
 * Estes testes exercitam a cadeia real de proteção do painel — rota (App) →
 * AdminPage → gates (login → allowlist → MFA/AAL2) — com a camada de rede
 * (adminAuth/adminApi) simulada no limite do módulo. Nenhuma asserção
 * depende de timing do Suspense: a tela final é sempre aguardada com
 * `findBy*`.
 *
 * A proteção efetiva continua sendo a do backend/banco (`admin-api` +
 * `assert_admin()`); aqui verificamos que a interface NUNCA renderiza dados
 * administrativos sem uma sessão administrativa com MFA satisfeito.
 */

interface SessionState {
  userId: string;
  email: string | null;
  currentLevel: string;
  nextLevel: string;
  pendingTotp: boolean;
  factors: Array<{ id: string; friendlyName: string | null }>;
  isAdmin: boolean;
  mfaSatisfied: boolean;
}

const state = vi.hoisted(() => ({
  /** null = visitante sem sessão; valor = sessão simulada. */
  session: null as SessionState | null,
  verifyTotpMock: vi.fn(),
  indicatorsMock: vi.fn(),
}));

const UNAUTHORIZED_HINT = 'Acesso administrativo negado.';

vi.mock('../../services/adminAuth', () => ({
  isAdminDemoSession: () => false,
  canUseAdminDemo: () => false,
  setAdminDemoSession: () => undefined,
  getCurrentSession: async () => ({ ok: true as const, value: state.session }),
  signOutAdmin: async () => undefined,
  signInWithPassword: vi.fn(async () => ({ ok: false as const, message: UNAUTHORIZED_HINT })),
  requestPasswordReset: vi.fn(async () => ({ ok: true as const, value: true as const })),
  startTotpEnrollment: vi.fn(async () => ({
    ok: true as const,
    value: { factorId: 'factor-novo', qrCode: 'data:image/svg+xml;base64,PHN2Zy8+', secret: 'SEGREDO-DE-TESTE' },
  })),
  verifyTotp: state.verifyTotpMock,
}));

const INDICATORS = {
  orders_total: 7,
  orders_pending_payment: 2,
  orders_paid: 3,
  orders_expired: 0,
  orders_refund_pending: 0,
  orders_refunded: 1,
  orders_disputed: 0,
  orders_failed: 0,
  payments_charged_back: 0,
  revenue_total_cents: 149700,
  revenue_30d_cents: 49900,
  units_sold: 4,
  units_available: 20,
  units_reserved: 1,
  active_reservations: 1,
  open_refund_requests: 0,
  deliveries_active: 2,
  deliveries_revoked: 1,
  products_active: 2,
  products_inactive: 0,
  low_stock_products: [],
  generated_at: '2026-11-09T12:00:00.000Z',
};

vi.mock('../../services/adminApi', () => ({
  adminApi: {
    indicators: state.indicatorsMock,
    listRefunds: vi.fn(async () => ({ refunds: [] })),
    auditLog: vi.fn(async () => ({ entries: [] })),
    listProducts: vi.fn(async () => ({ products: [] })),
    getProduct: vi.fn(async () => ({ product: null, price_history: [] })),
    createProduct: vi.fn(),
    updateProduct: vi.fn(),
    setProductActive: vi.fn(),
    stockSummary: vi.fn(async () => ({ total: 0, available: 0, reserved: 0, sold: 0, disabled: 0 })),
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

function adminSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    userId: '00000000-0000-4000-8000-000000000001',
    email: 'dono@prime-store.test',
    currentLevel: 'aal2',
    nextLevel: 'aal2',
    pendingTotp: false,
    factors: [{ id: 'factor-1', friendlyName: 'Authenticator' }],
    isAdmin: true,
    mfaSatisfied: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://exemplo.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'chave-anon');
  vi.stubEnv('VITE_BACKEND_ENABLED', 'true');
  vi.stubEnv('VITE_ADMIN_DEMO', 'false');
  state.session = null;
  state.verifyTotpMock.mockReset();
  state.indicatorsMock.mockReset();
  state.indicatorsMock.mockResolvedValue(INDICATORS);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('rota /admin (missão 03.2A)', () => {
  it('visitante não autenticado vê o login e NUNCA dados administrativos', async () => {
    state.session = null;
    renderAt('/admin');

    expect(await screen.findByRole('heading', { name: 'Painel administrativo' })).toBeInTheDocument();
    expect(screen.getByLabelText('E-mail')).toBeInTheDocument();
    expect(screen.getByLabelText('Senha')).toBeInTheDocument();
    // Nenhum vestígio do painel autenticado:
    expect(screen.queryByRole('navigation', { name: 'Seções do painel' })).not.toBeInTheDocument();
    expect(screen.queryByText('Receita aprovada')).not.toBeInTheDocument();
    expect(screen.queryByText('Visão geral')).not.toBeInTheDocument();
    // O chrome público da loja não envolve o painel:
    expect(screen.queryByRole('navigation', { name: 'Navegação principal' })).not.toBeInTheDocument();
    expect(document.title).toBe('Prime Store — Administração');
    expect(console.error).not.toHaveBeenCalled();
  });

  it('acesso direto a um caminho profundo desconhecido renderiza o painel, nunca a 404 pública', async () => {
    state.session = null;
    renderAt('/admin/qualquer/caminho');

    expect(await screen.findByRole('heading', { name: 'Painel administrativo' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Não encontramos esta página' })).not.toBeInTheDocument();
  });

  it('usuário autenticado sem allowlist recebe "Acesso negado" e nenhum dado do painel', async () => {
    state.session = adminSession({ isAdmin: false, mfaSatisfied: false, currentLevel: 'aal1', nextLevel: 'aal1', factors: [] });
    renderAt('/admin');

    expect(await screen.findByRole('heading', { name: 'Acesso negado' })).toBeInTheDocument();
    expect(screen.getByText('dono@prime-store.test')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Seções do painel' })).not.toBeInTheDocument();
    expect(screen.queryByText('Receita aprovada')).not.toBeInTheDocument();
    expect(state.indicatorsMock).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('administrador sem MFA e sem fator cadastrado fica no cadastro de TOTP, sem o painel', async () => {
    state.session = adminSession({ mfaSatisfied: false, currentLevel: 'aal1', nextLevel: 'aal2', factors: [], pendingTotp: true });
    renderAt('/admin');

    expect(await screen.findByText('VERIFICAÇÃO EM DUAS ETAPAS')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Confirme o código TOTP' })).toBeInTheDocument();
    expect(await screen.findByText('SEGREDO-DE-TESTE')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Seções do painel' })).not.toBeInTheDocument();
    expect(state.indicatorsMock).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('administrador sem MFA concluído verifica o código e só então acessa o painel', async () => {
    const incomplete = adminSession({ mfaSatisfied: false, currentLevel: 'aal1', nextLevel: 'aal2' });
    const complete = adminSession();
    state.session = incomplete;
    state.verifyTotpMock.mockImplementation(async () => {
      state.session = complete;
      return { ok: true as const, value: complete };
    });

    const user = userEvent.setup();
    renderAt('/admin');

    // Gate de TOTP com fator existente: o painel não aparece antes da verificação.
    expect(await screen.findByRole('heading', { name: 'Confirme o código TOTP' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Seções do painel' })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Código de 6 dígitos'), '123456');
    await user.click(screen.getByRole('button', { name: 'Validar código' }));

    expect(state.verifyTotpMock).toHaveBeenCalledWith('factor-1', '123456');
    // Após a verificação, o painel é renderizado.
    expect(await screen.findByRole('navigation', { name: 'Seções do painel' })).toBeInTheDocument();
    expect(await screen.findByText('Receita aprovada')).toBeInTheDocument();
    expect(state.indicatorsMock).toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('administrador autorizado com MFA concluído acessa o painel completo e suas abas', async () => {
    state.session = adminSession();
    const user = userEvent.setup();
    renderAt('/admin');

    const tabs = await screen.findByRole('navigation', { name: 'Seções do painel' });
    expect(within(tabs).getByRole('button', { name: 'Visão geral' })).toBeInTheDocument();
    expect(within(tabs).getByRole('button', { name: 'Produtos' })).toBeInTheDocument();
    expect(within(tabs).getByRole('button', { name: 'Estoque' })).toBeInTheDocument();
    expect(within(tabs).getByRole('button', { name: 'Pedidos' })).toBeInTheDocument();

    expect(await screen.findByText('Receita aprovada')).toBeInTheDocument();
    expect(screen.getByText('Painel Prime Store')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Navegação principal' })).not.toBeInTheDocument();

    // Navegação interna por abas continua funcionando após a restauração da rota.
    await user.click(within(tabs).getByRole('button', { name: 'Produtos' }));
    expect(await screen.findByRole('button', { name: /Novo produto/i })).toBeInTheDocument();
    await user.click(within(tabs).getByRole('button', { name: 'Pedidos' }));
    expect(await screen.findByText(/0 pedido\(s\) no total/i)).toBeInTheDocument();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('a presença da rota não vaza dados: chamada administrativa só acontece com MFA satisfeito', async () => {
    // Sem sessão e com sessão sem MFA, o painel nunca dispara chamadas administrativas.
    for (const locked of [
      null,
      adminSession({ mfaSatisfied: false, currentLevel: 'aal1', nextLevel: 'aal2' }),
    ]) {
      state.indicatorsMock.mockClear();
      state.session = locked;
      const { unmount } = renderAt('/admin');
      await screen.findByRole('heading', {
        name: locked === null ? 'Painel administrativo' : 'Confirme o código TOTP',
      });
      expect(state.indicatorsMock).not.toHaveBeenCalled();
      unmount();
    }
  });
});
