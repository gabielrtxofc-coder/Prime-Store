import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeliveryPage } from './DeliveryPage';

/**
 * Missão 09 — entrega digital multi-produto na interface.
 *
 * O backend devolve um grupo por produto (`items`). Estes testes garantem que a
 * tela mostra todos os produtos do pedido, com o nome, as instruções e a
 * validade de cada um, e que revelar/copiar uma unidade não expõe as demais.
 */

const multiItemPayload = {
  reference: 'PS-MULTI1',
  created_at: '2026-11-08T12:00:00.000Z',
  items_count: 2,
  items: [
    {
      product_id: 'p1',
      product_name: 'Curso de Piano',
      product_slug: 'curso-de-piano',
      instructions: 'Entre no portal e troque a senha.',
      access_validity_label: '12 meses',
      access_validity_days: 365,
      quantity: 2,
      units: [
        { email: 'piano1@exemplo.com', password: 'senha-piano-1', notes: '' },
        { email: 'piano2@exemplo.com', password: 'senha-piano-2', notes: '' },
      ],
    },
    {
      product_id: 'p2',
      product_name: 'Pacote de Violão',
      product_slug: 'pacote-de-violao',
      instructions: 'Aulas liberadas no aplicativo.',
      access_validity_label: '6 meses',
      access_validity_days: 180,
      quantity: 1,
      units: [{ email: 'violao@exemplo.com', password: 'senha-violao', notes: 'perfil 1' }],
    },
  ],
  product: {
    id: 'p1',
    name: 'Curso de Piano',
    slug: 'curso-de-piano',
    instructions: 'Entre no portal e troque a senha.',
    access_validity_label: '12 meses',
    access_validity_days: 365,
  },
  units: [
    { email: 'piano1@exemplo.com', password: 'senha-piano-1', notes: '' },
    { email: 'piano2@exemplo.com', password: 'senha-piano-2', notes: '' },
    { email: 'violao@exemplo.com', password: 'senha-violao', notes: 'perfil 1' },
  ],
};

const legacyPayload = {
  reference: 'PS-LEGADO',
  created_at: '2026-11-08T12:00:00.000Z',
  product: {
    id: 'p9',
    name: 'Produto Legado',
    slug: 'produto-legado',
    instructions: 'Instrução antiga.',
    access_validity_label: '30 dias',
    access_validity_days: 30,
  },
  units: [{ email: 'legado@exemplo.com', password: 'senha-legado', notes: '' }],
};

function stubBackend(payload: unknown, status = 200) {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://exemplo.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'chave-anon');
  vi.stubEnv('VITE_BACKEND_ENABLED', 'true');
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderDelivery(token = 'token-privado-multi') {
  return render(
    <MemoryRouter initialEntries={[`/entrega/${token}`]}>
      <Routes>
        <Route path="/entrega/:token" element={<DeliveryPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('entrega multi-produto', () => {
  it('mostra os dois produtos do pedido, com instruções e validade próprias', async () => {
    stubBackend(multiItemPayload);
    renderDelivery();

    expect(await screen.findByRole('heading', { name: 'Seus acessos' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Curso de Piano' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pacote de Violão' })).toBeInTheDocument();

    expect(screen.getByText('Entre no portal e troque a senha.')).toBeInTheDocument();
    expect(screen.getByText('Aulas liberadas no aplicativo.')).toBeInTheDocument();
    expect(screen.getByText(/12 meses/)).toBeInTheDocument();
    expect(screen.getByText(/6 meses/)).toBeInTheDocument();

    // Três unidades no total (2 do piano + 1 do violão), todas mascaradas.
    expect(screen.getAllByRole('button', { name: /Mostrar dados/i })).toHaveLength(3);
    expect(screen.queryByText('piano1@exemplo.com')).not.toBeInTheDocument();
    expect(screen.queryByText('violao@exemplo.com')).not.toBeInTheDocument();
  });

  it('revela e copia cada unidade individualmente', async () => {
    stubBackend(multiItemPayload);
    const user = userEvent.setup();
    renderDelivery();

    await screen.findByRole('heading', { name: 'Seus acessos' });
    const revealButtons = screen.getAllByRole('button', { name: /Mostrar dados/i });

    // Revela só a primeira unidade do primeiro produto.
    await user.click(revealButtons[0]);
    expect(screen.getByText('piano1@exemplo.com')).toBeInTheDocument();
    expect(screen.queryByText('piano2@exemplo.com')).not.toBeInTheDocument();
    expect(screen.queryByText('violao@exemplo.com')).not.toBeInTheDocument();

    // Oculta de volta.
    await user.click(screen.getAllByRole('button', { name: /Ocultar dados/i })[0]);
    await waitFor(() => {
      expect(screen.queryByText('piano1@exemplo.com')).not.toBeInTheDocument();
    });

    // Revela a unidade do segundo produto: continua independente.
    await user.click(screen.getAllByRole('button', { name: /Mostrar dados/i })[2]);
    expect(screen.getByText('violao@exemplo.com')).toBeInTheDocument();
    expect(screen.getByText('senha-violao')).toBeInTheDocument();
    expect(screen.queryByText('piano1@exemplo.com')).not.toBeInTheDocument();

    // Copiar usa o rótulo do próprio card.
    const copyButtons = screen.getAllByRole('button', { name: 'Copiar' });
    await user.click(copyButtons[0]);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copiado' })).toBeInTheDocument();
    });
  });

  it('continua aceitando o formato antigo de um produto só', async () => {
    stubBackend(legacyPayload);
    const user = userEvent.setup();
    renderDelivery('token-legado');

    expect(await screen.findByRole('heading', { name: 'Produto Legado' })).toBeInTheDocument();
    expect(screen.getByText(/1 produto/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Mostrar dados/i })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /Mostrar dados/i }));
    expect(screen.getByText('legado@exemplo.com')).toBeInTheDocument();
  });

  it('link revogado não mostra nenhum produto', async () => {
    stubBackend({ error: 'delivery_revoked', message: 'Este acesso foi revogado.' }, 410);
    renderDelivery('token-revogado');

    expect(await screen.findByRole('heading', { name: /Entrega indisponível/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mostrar dados/i })).not.toBeInTheDocument();
  });
});
