import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { CatalogProvider } from '../context/CatalogContext';
import { CartProvider } from '../context/CartContext';
import { ToastProvider } from '../context/ToastContext';
import { catalogService } from '../services/catalogService';

/**
 * Missão 08 — o catálogo é sempre o do backend.
 *
 * O que estes testes garantem:
 *  - os produtos exibidos vêm da Edge Function `catalog`;
 *  - não existe array local de produtos como substituto;
 *  - falha de rede vira estado de erro com ação de recarregar;
 *  - sem backend configurado, a loja informa o problema (sem requisição).
 */

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
          <ToastProvider>
            <App />
          </ToastProvider>
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
  window.localStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('catálogo servido pelo backend', () => {
  it('exibe os produtos reais e consulta somente a Edge Function de catálogo', async () => {
    enableBackend();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(JSON.stringify({ products: [backendProduct], generated_at: '2026-10-31T10:00:00.000Z' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderAt('/produtos');

    expect(await screen.findByText('Produto Real de Teste')).toBeInTheDocument();
    expect(screen.getByText('CATÁLOGO ONLINE')).toBeInTheDocument();
    expect(screen.getAllByText(/R\$\s*49,90/).length).toBeGreaterThan(0);
    expect(screen.getByText('3 unidade(s) disponível(is)')).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/catalog$/);
  });

  it('distingue disponível de indisponível e não permite pedir o esgotado', async () => {
    enableBackend();
    const soldOut = {
      ...backendProduct,
      id: '33333333-3333-4333-8333-333333333333',
      slug: 'sem-estoque',
      name: 'Produto Sem Estoque',
      available: false,
      availableUnits: 0,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ products: [backendProduct, soldOut], generated_at: '2026-10-31T10:00:00.000Z' }), {
          status: 200,
        }),
      ),
    );

    renderAt('/produtos');

    expect(await screen.findByText('Produto Real de Teste')).toBeInTheDocument();
    expect(screen.getByText('DISPONÍVEL')).toBeInTheDocument();
    expect(screen.getByText('INDISPONÍVEL')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Produto Sem Estoque indisponível/i })).toBeDisabled();
    // O selo de demonstração do protótipo não existe mais.
    expect(screen.queryByText('DEMO')).not.toBeInTheDocument();
  });

  it('mostra erro (sem dados fictícios) quando o backend falha e permite tentar de novo', async () => {
    enableBackend();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ error: 'internal_error' }), { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    renderAt('/produtos');

    expect(await screen.findByText(/Não foi possível carregar o catálogo/i)).toBeInTheDocument();
    expect(screen.queryByText(/Spotify|Netflix|Canva/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Produto Real de Teste' })).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('informa quando o backend não está configurado e não faz requisições', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderAt('/produtos');

    expect(await screen.findByText(/não está conectada ao catálogo/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mostra produto com os dados do backend na página de detalhe', async () => {
    enableBackend();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ products: [backendProduct], generated_at: '2026-10-31T10:00:00.000Z' }), { status: 200 }),
      ),
    );

    renderAt('/produto/produto-real-de-teste');

    expect(await screen.findByRole('heading', { name: 'Produto Real de Teste' })).toBeInTheDocument();
    expect(screen.getByText(/R\$\s*49,90/)).toBeInTheDocument();
    expect(screen.getByText('3 unidade(s) disponível(is) agora')).toBeInTheDocument();
    expect(screen.getByText(/Condição do backend/)).toBeInTheDocument();
    expect(screen.getByText(/Use as credenciais da entrega/)).toBeInTheDocument();
  });
});
