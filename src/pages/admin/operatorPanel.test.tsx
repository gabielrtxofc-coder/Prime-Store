import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { CatalogProvider } from '../../context/CatalogContext';
import { CartProvider } from '../../context/CartContext';
import { ToastProvider } from '../../context/ToastContext';

/**
 * Perfil OPERACIONAL no painel (missão de simplificação da autenticação).
 *
 * Comprova na interface:
 *  - operador entra só com e-mail + senha e cai direto no painel operacional
 *    (sem tela de TOTP), com apenas Estoque e Produtos;
 *  - nenhuma chamada administrativa (`adminApi`) é feita pelo operador;
 *  - a tela de estoque não oferece revelar credenciais nem mostra fingerprint;
 *  - a edição de produto envia só campos operacionais (nunca preço/custo);
 *  - conta que é admin + operador continua podendo pedir o painel completo
 *    (que segue exigindo TOTP);
 *  - recuperação de senha mostra a tela de nova senha.
 *
 * A autorização real é do banco (assert_operator / assert_admin) — ver
 * tests/db/31_perfil_operacional.test.ts e 32_perfil_operacional_http.test.ts.
 */

interface SessionState {
  userId: string;
  email: string | null;
  currentLevel: string;
  nextLevel: string;
  pendingTotp: boolean;
  factors: Array<{ id: string; friendlyName: string | null }>;
  pendingFactors: Array<{ id: string; friendlyName: string | null }>;
  isAdmin: boolean;
  mfaSatisfied: boolean;
  isOperator: boolean;
  adminCheckError: string | null;
  factorError: string | null;
  canEnrollMore: boolean;
}

const PRODUCT = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'spotify-premium',
  name: 'Spotify Premium',
  category_id: 'music',
  price_cents: 1990,
  is_active: true,
  is_featured: false,
  max_quantity_per_order: 1,
  access_validity_label: '30 dias',
  short_description: 'Resumo',
  description: 'Descrição',
  instructions: 'Instruções',
  conditions: ['Uso individual'],
  image_url: null,
  available_units: 3,
  updated_at: '2026-11-28T10:00:00.000Z',
};

const SUMMARY = {
  products: [
    {
      product_id: PRODUCT.id,
      product_name: PRODUCT.name,
      slug: PRODUCT.slug,
      is_active: true,
      archived_at: null,
      total_units: 3,
      available_units: 3,
      reserved_units: 0,
      sold_units: 0,
      disabled_units: 0,
      last_restocked_at: null,
      stock_health: 'ok',
    },
  ],
  totals: { total_units: 3, available_units: 3, reserved_units: 0, sold_units: 0, disabled_units: 0 },
};

const UNIT = {
  id: '22222222-2222-4222-8222-222222222222',
  product_id: PRODUCT.id,
  product_name: PRODUCT.name,
  status: 'available',
  notes: '',
  import_batch_id: null,
  sold_at: null,
  created_at: '2026-11-28T10:00:00.000Z',
  updated_at: '2026-11-28T10:00:00.000Z',
  reservation_expires_at: null,
  status_reason: null,
  status_reason_note: '',
};

const state = vi.hoisted(() => ({
  session: null as SessionState | null,
  recovery: false,
  updatePasswordMock: vi.fn(),
  adminCalls: [] as string[],
  ops: {
    listProducts: vi.fn(),
    updateProduct: vi.fn(),
    setProductActive: vi.fn(),
    stockSummary: vi.fn(),
    listStock: vi.fn(),
    addStock: vi.fn(),
    setStockStatus: vi.fn(),
    previewImport: vi.fn(),
    commitImport: vi.fn(),
    session: vi.fn(),
  },
}));

vi.mock('../../services/adminAuth', () => ({
  isAdminDemoSession: () => false,
  canUseAdminDemo: () => false,
  setAdminDemoSession: () => undefined,
  getCurrentSession: async () => ({ ok: true as const, value: state.session }),
  signOutAdmin: async () => undefined,
  signInWithPassword: vi.fn(async () => ({ ok: false as const, message: 'x' })),
  requestPasswordReset: vi.fn(async () => ({ ok: true as const, value: true as const })),
  startTotpEnrollment: vi.fn(async () => ({
    ok: true as const,
    value: { factorId: 'factor-novo', qrCode: 'data:image/svg+xml;base64,PHN2Zy8+', secret: 'SEGREDO' },
  })),
  verifyTotp: vi.fn(),
  discardPendingEnrollment: vi.fn(),
  isPasswordRecoveryPending: () => state.recovery,
  clearPasswordRecovery: () => {
    state.recovery = false;
  },
  updatePassword: state.updatePasswordMock,
  MIN_PASSWORD_LENGTH: 8,
}));

vi.mock('../../services/adminApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/adminApi')>();
  // Qualquer chamada administrativa é registrada: o operador não deve fazer nenhuma.
  const adminApi = new Proxy(
    {},
    {
      get: (_target, property: string) => async () => {
        state.adminCalls.push(property);
        throw new Error(`chamada administrativa inesperada: ${property}`);
      },
    },
  );
  return { ...original, adminApi, opsApi: state.ops };
});

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

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    userId: '00000000-0000-4000-8000-000000000009',
    email: 'operador@prime-store.test',
    currentLevel: 'aal1',
    nextLevel: 'aal1',
    pendingTotp: false,
    factors: [],
    pendingFactors: [],
    isAdmin: false,
    mfaSatisfied: false,
    isOperator: true,
    adminCheckError: null,
    factorError: null,
    canEnrollMore: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://exemplo.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'chave-anon');
  vi.stubEnv('VITE_BACKEND_ENABLED', 'true');
  vi.stubEnv('VITE_ADMIN_DEMO', 'false');
  state.session = null;
  state.recovery = false;
  state.adminCalls = [];
  state.updatePasswordMock.mockReset();
  state.updatePasswordMock.mockResolvedValue({ ok: true, value: true });
  for (const mock of Object.values(state.ops)) mock.mockReset();
  state.ops.listProducts.mockResolvedValue({ products: [PRODUCT] });
  state.ops.stockSummary.mockResolvedValue(SUMMARY);
  state.ops.listStock.mockResolvedValue({ items: [UNIT], total: 1, limit: 100, offset: 0 });
  state.ops.updateProduct.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
    product: { ...PRODUCT, ...patch },
  }));
  state.ops.setStockStatus.mockResolvedValue({ id: UNIT.id, status: 'disabled', reason: 'invalid_credential', note: '' });
  state.ops.addStock.mockResolvedValue({ unit: { id: 'novo', status: 'available' } });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('painel operacional (e-mail + senha, sem TOTP)', () => {
  it('login mostra que e-mail e senha bastam para a operação diária', async () => {
    renderAt('/admin');
    expect(await screen.findByRole('heading', { name: 'Painel da loja' })).toBeInTheDocument();
    expect(screen.getByText(/Entre com e-mail e senha para a operação do dia a dia/)).toBeInTheDocument();
    expect(screen.queryByText(/verificação em duas etapas é obrigatória/)).not.toBeInTheDocument();
  });

  it('operador em AAL1 entra direto no painel operacional, sem tela de TOTP', async () => {
    state.session = session();
    renderAt('/admin');

    const nav = await screen.findByRole('navigation', { name: 'Seções do painel' });
    const tabs = within(nav).getAllByRole('button').map((button) => button.textContent);
    expect(tabs).toEqual(['Estoque', 'Produtos']);
    expect(screen.getByText('Operação diária')).toBeInTheDocument();
    expect(screen.getByText('Acesso operacional')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Confirme o código TOTP' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Cadastre o autenticador/)).not.toBeInTheDocument();
    // Abas administrativas não existem para o operador.
    for (const label of ['Visão geral', 'Pedidos', 'Segurança']) {
      expect(within(nav).queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
    await waitFor(() => expect(state.ops.stockSummary).toHaveBeenCalled());
    expect(state.adminCalls).toEqual([]);
    // Operador puro não vê o atalho para o acesso completo.
    expect(screen.queryByRole('button', { name: 'Acesso administrativo completo' })).not.toBeInTheDocument();
  });

  it('estoque operacional não oferece revelar credenciais nem mostra fingerprint', async () => {
    state.session = session();
    renderAt('/admin');
    await screen.findByRole('navigation', { name: 'Seções do painel' });
    await waitFor(() => expect(state.ops.listStock).toHaveBeenCalled());

    expect(screen.queryByText(/Exibir credenciais/)).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Fingerprint' })).not.toBeInTheDocument();
    expect(await screen.findByText('protegida')).toBeInTheDocument();
    for (const call of state.ops.listStock.mock.calls) {
      expect(call[0]).not.toHaveProperty('includeCredentials');
    }
    expect(state.adminCalls).toEqual([]);
  });

  it('operador cadastra uma unidade de estoque', async () => {
    const user = userEvent.setup();
    state.session = session();
    renderAt('/admin');
    await screen.findByRole('navigation', { name: 'Seções do painel' });
    await waitFor(() => expect(state.ops.listProducts).toHaveBeenCalled());

    await user.selectOptions(await screen.findByLabelText('Produto', { selector: '#stock-product' }), PRODUCT.id);
    await user.type(screen.getByLabelText('E-mail / login da conta'), 'conta@exemplo.com');
    await user.type(screen.getByLabelText('Senha da conta'), 'SenhaForte1');
    await user.click(screen.getByRole('button', { name: 'Cadastrar unidade' }));

    await waitFor(() =>
      expect(state.ops.addStock).toHaveBeenCalledWith(
        expect.objectContaining({ productId: PRODUCT.id, email: 'conta@exemplo.com', password: 'SenhaForte1' }),
      ),
    );
    expect(state.adminCalls).toEqual([]);
  });

  it('operador desativa uma unidade informando o motivo', async () => {
    const user = userEvent.setup();
    state.session = session();
    renderAt('/admin');
    const table = await screen.findByRole('table');
    await user.click(await within(table).findByRole('button', { name: 'Desativar' }));
    await user.selectOptions(await screen.findByLabelText('Motivo do ajuste (obrigatório)'), 'invalid_credential');
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Desativar' }));
    await waitFor(() =>
      expect(state.ops.setStockStatus).toHaveBeenCalledWith(UNIT.id, 'disabled', 'invalid_credential', ''),
    );
    expect(state.adminCalls).toEqual([]);
  });

  it('produtos: sem custo/margem e a edição envia somente campos operacionais', async () => {
    const user = userEvent.setup();
    state.session = session();
    renderAt('/admin');
    const nav = await screen.findByRole('navigation', { name: 'Seções do painel' });
    await user.click(within(nav).getByRole('button', { name: 'Produtos' }));

    expect(await screen.findByText(PRODUCT.name)).toBeInTheDocument();
    expect(screen.queryByText(/Custo/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Margem/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Novo produto/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Editar' }));
    expect(screen.queryByLabelText(/Preço/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Slug|Endereço/)).not.toBeInTheDocument();
    const name = screen.getByLabelText('Nome');
    await user.clear(name);
    await user.type(name, 'Spotify Premium Família');
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));

    await waitFor(() =>
      expect(state.ops.updateProduct).toHaveBeenCalledWith(PRODUCT.id, { name: 'Spotify Premium Família' }),
    );
    expect(await screen.findByText('Produto "Spotify Premium Família" atualizado.')).toBeInTheDocument();
    expect(state.adminCalls).toEqual([]);
  });

  it('erro do servidor (campo não autorizado) aparece de forma clara', async () => {
    const user = userEvent.setup();
    state.ops.updateProduct.mockRejectedValueOnce(
      Object.assign(new Error('O perfil operacional não pode alterar: price_cents.'), {
        name: 'BackendError',
        status: 403,
        code: 'field_not_allowed',
      }),
    );
    state.session = session();
    renderAt('/admin');
    const nav = await screen.findByRole('navigation', { name: 'Seções do painel' });
    await user.click(within(nav).getByRole('button', { name: 'Produtos' }));
    await user.click(await screen.findByRole('button', { name: 'Editar' }));
    await user.type(screen.getByLabelText('Resumo'), ' novo');
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('conta admin + operador em AAL1 usa o painel operacional e pode pedir o acesso completo (TOTP)', async () => {
    const user = userEvent.setup();
    state.session = session({
      isAdmin: true,
      factors: [{ id: 'factor-1', friendlyName: 'Celular' }],
      nextLevel: 'aal2',
      pendingTotp: true,
    });
    renderAt('/admin');

    await screen.findByText('Operação diária');
    await user.click(screen.getByRole('button', { name: 'Acesso administrativo completo' }));
    expect(await screen.findByRole('heading', { name: 'Confirme o código TOTP' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '← Voltar ao painel operacional' }));
    expect(await screen.findByText('Operação diária')).toBeInTheDocument();
    expect(state.adminCalls).toEqual([]);
  });

  it('administrador com MFA concluído continua no painel completo', async () => {
    state.session = session({ isAdmin: true, mfaSatisfied: true, currentLevel: 'aal2', isOperator: true });
    renderAt('/admin');
    const nav = await screen.findByRole('navigation', { name: 'Seções do painel' });
    expect(within(nav).getByRole('button', { name: 'Pedidos' })).toBeInTheDocument();
    expect(screen.queryByText('Operação diária')).not.toBeInTheDocument();
  });

  it('conta autenticada sem nenhum perfil recebe "Acesso negado"', async () => {
    state.session = session({ isOperator: false, isAdmin: false });
    renderAt('/admin');
    expect(await screen.findByRole('heading', { name: 'Acesso negado' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Seções do painel' })).not.toBeInTheDocument();
    expect(state.ops.stockSummary).not.toHaveBeenCalled();
  });
});

describe('recuperação de senha', () => {
  it('link de recuperação abre a tela de nova senha antes de qualquer painel', async () => {
    const user = userEvent.setup();
    state.recovery = true;
    state.session = session();
    renderAt('/admin');

    expect(await screen.findByRole('heading', { name: 'Definir nova senha' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Seções do painel' })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Nova senha'), 'NovaSenha123');
    await user.type(screen.getByLabelText('Repita a nova senha'), 'Diferente123');
    await user.click(screen.getByRole('button', { name: 'Salvar nova senha' }));
    expect(await screen.findByText('As senhas não conferem.')).toBeInTheDocument();
    expect(state.updatePasswordMock).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('Repita a nova senha'));
    await user.type(screen.getByLabelText('Repita a nova senha'), 'NovaSenha123');
    state.recovery = false;
    await user.click(screen.getByRole('button', { name: 'Salvar nova senha' }));
    await waitFor(() => expect(state.updatePasswordMock).toHaveBeenCalledWith('NovaSenha123'));
    expect(await screen.findByText('Operação diária')).toBeInTheDocument();
  });

  it('senha curta é recusada na própria tela', async () => {
    const user = userEvent.setup();
    state.recovery = true;
    state.session = session();
    renderAt('/admin');
    await screen.findByRole('heading', { name: 'Definir nova senha' });
    // minLength do input impediria o submit nativo; removemos para testar a validação JS.
    for (const input of [screen.getByLabelText('Nova senha'), screen.getByLabelText('Repita a nova senha')]) {
      input.removeAttribute('minLength');
      await user.type(input, 'curta');
    }
    await user.click(screen.getByRole('button', { name: 'Salvar nova senha' }));
    expect(await screen.findByText('A nova senha precisa ter pelo menos 8 caracteres.')).toBeInTheDocument();
    expect(state.updatePasswordMock).not.toHaveBeenCalled();
  });
});
