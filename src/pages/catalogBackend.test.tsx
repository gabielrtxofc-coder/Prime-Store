import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { CatalogProvider } from '../context/CatalogContext';
import { CartProvider } from '../context/CartContext';
import { OrderProvider } from '../context/OrderContext';
import { ToastProvider } from '../context/ToastContext';
import { catalogService } from '../services/catalogService';

const backendProduct = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'produto-real-de-teste',
  name: 'Produto Real de Teste',
  shortDescription: 'Vem do backend',
  description: 'Descrição vinda da Edge Function de catálogo.',
  imageUrl: null,
  categoryId: 'creative',
  categoryLabel: 'Design e criatividade',
  modality: 'Produto digital',
  period: '30 dias',
  priceCents: 4990,
  accessValidityDays: 30,
  accessValidityLabel: '30 dias',
  instructions: 'Use as credenciais da entrega.',
  conditions: ['Condição do backend'],
  monogram: 'R',
  theme: 'violet',
  maxQuantity: 2,
  allowQuantity: true,
  featured: true,
  availableUnits: 3,
  available: true,
};

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <CatalogProvider>
        <CartProvider>
          <OrderProvider>
            <ToastProvider>
              <App />
            </ToastProvider>
          </OrderProvider>
        </CartProvider>
      </CatalogProvider>
    </MemoryRouter>,
  );
}

function enableBackend() {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://exemplo.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'chave-anon');
  vi.stubEnv('VITE_BACKEND_ENABLED', 'true');
}

beforeEach(() => {
  catalogService.reset();
});

afterEach(() => {
  catalogService.reset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('catálogo servido pelo backend', () => {
  it('substitui os dados locais pelos produtos reais da Edge Function', async () => {
    enableBackend();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(JSON.stringify({ products: [backendProduct], generated_at: '2026-10-31T10:00:00.000Z' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderAt('/produtos');

    expect(await screen.findByText('Produto Real de Teste')).toBeInTheDocument();
    expect(screen.getByText('DADOS REAIS')).toBeInTheDocument();
    // O catálogo local de demonstração não é mais exibido.
    expect(screen.queryByText(/Spotify/i)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/catalog$/);
  });

  it('identifica produto de demonstração e produto real com estoque real', async () => {
    enableBackend();
    const demoProduct = { ...backendProduct, id: '22222222-2222-4222-8222-222222222222', slug: 'demo-mensal', name: 'Assinatura de Demonstração', isDemo: true, availableUnits: 4 };
    const soldOut = { ...backendProduct, id: '33333333-3333-4333-8333-333333333333', slug: 'sem-estoque', name: 'Produto Sem Estoque', isDemo: false, available: false, availableUnits: 0 };
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ products: [demoProduct, backendProduct, soldOut], generated_at: '2026-10-31T10:00:00.000Z' }), { status: 200 }),
    ));

    renderAt('/produtos');

    expect(await screen.findByText('Assinatura de Demonstração')).toBeInTheDocument();
    // Produto de demonstração recebe o selo DEMO...
    expect(screen.getAllByText('DEMO').length).toBeGreaterThan(0);
    // ...o real mostra disponibilidade calculada no servidor...
    expect(screen.getByText('DISPONÍVEL')).toBeInTheDocument();
    expect(screen.getByText('3 unidade(s) disponível(is)')).toBeInTheDocument();
    // ...e o esgotado não pode ser comprado.
    expect(screen.getByText('ESGOTADO')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Esgotado/i })).toBeDisabled();
  });

  it('mantém o catálogo local quando o backend falha, exibindo aviso', async () => {
    enableBackend();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'internal_error' }), { status: 500 })));

    renderAt('/produtos');

    expect(await screen.findByText(/Não foi possível carregar o catálogo/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Spotify|Netflix|Canva/i).length).toBeGreaterThan(0);
  });

  it('não faz requisições no modo demonstração', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderAt('/produtos');

    expect(await screen.findByText(/MODO DEMONSTRAÇÃO/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
