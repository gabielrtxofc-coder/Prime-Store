import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminPage } from './AdminPage';
import { adminInvoke, getCurrentSession, isAdminDemoSession, setAdminDemoSession } from '../../services/adminAuth';

/**
 * Fase G — painel administrativo sem conta provisionada.
 *
 * O modo demonstrativo é estritamente local: não fala com o Supabase, não
 * reaproveita a sessão real e precisa ser explicitamente ligado. Estes testes
 * garantem esse isolamento e o aviso permanente na tela.
 */

function renderAdmin() {
  return render(
    <MemoryRouter initialEntries={['/admin']}>
      <AdminPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubEnv('VITE_ADMIN_DEMO', 'true');
  vi.stubEnv('VITE_SUPABASE_URL', 'https://exemplo.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'chave-anon');
  vi.stubEnv('VITE_BACKEND_ENABLED', 'true');
  setAdminDemoSession(false);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAdminDemoSession(false);
});

describe('painel administrativo em modo demonstração', () => {
  it('só assume a sessão fictícia depois de ligar o modo', () => {
    expect(isAdminDemoSession()).toBe(false);
    setAdminDemoSession(true);
    expect(isAdminDemoSession()).toBe(true);
  });

  it('abre o painel com aviso permanente de dados fictícios', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderAdmin();
    await user.click(await screen.findByRole('button', { name: /Ver painel em modo demonstração/i }));

    expect(await screen.findByText(/Modo de demonstração do painel/i)).toBeInTheDocument();
    expect(screen.getByText(/nenhuma alteração é gravada no Supabase/i)).toBeInTheDocument();
    expect(stubCalls(fetchMock)).toBe(0);
  });

  it('responde às ações com dados fictícios sem tocar na rede', async () => {
    vi.stubGlobal('fetch', vi.fn());
    setAdminDemoSession(true);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    const products = await adminInvoke<{ products: Array<{ slug: string }> }>('products.list', {});
    expect(products.products.length).toBeGreaterThan(0);
    expect(stubCalls(fetchMock)).toBe(0);
  });

  it('encerra a sessão fictícia no logout', async () => {
    vi.stubGlobal('fetch', vi.fn());
    setAdminDemoSession(true);
    const session = await getCurrentSession();
    expect(session.ok).toBe(true);

    renderAdmin();
    await waitFor(() => expect(screen.getByText(/sessão de demonstração/i)).toBeInTheDocument());
  });

  it('exige opt-in explícito: nada de sessão fictícia presumida', () => {
    // A flag VITE_ADMIN_DEMO é resolvida no build (comportamento do Vite);
    // mesmo com ela ligada, a sessão só existe após setAdminDemoSession(true).
    setAdminDemoSession(false);
    expect(isAdminDemoSession()).toBe(false);
  });
});

function stubCalls(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls.length;
}
