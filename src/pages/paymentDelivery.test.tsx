import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentPage } from './PaymentPage';
import { DeliveryPage } from './DeliveryPage';
import { savePendingOrder } from '../services/orderService';

const ORDER_ID = '0f0e0d0c-0000-4000-8000-000000000001';

const pendingStatus = {
  order_id: ORDER_ID,
  reference: 'PS-ABC123',
  status: 'pending_payment',
  payment_status: 'pending',
  delivery_status: 'not_ready',
  quantity: 1,
  unit_price_cents: 4990,
  total_cents: 4990,
  created_at: '2026-10-31T00:00:00.000Z',
  paid_at: null,
  reservation_expires_at: new Date(Date.now() + 1_800_000).toISOString(),
  product: { id: 'p1', slug: 'produto', name: 'Produto Exemplo', instructions: 'Instruções', access_validity_label: '30 dias' },
  payment: {
    status: 'pending',
    status_detail: null,
    qr_code: '00020126580014BR.GOV.BCB.PIX-codigo-de-teste',
    qr_code_base64: 'iVBORw0KGgoAAAANSUhEUg==',
    ticket_url: 'https://www.mercadopago.com.br/sandbox/payments/1',
    expires_at: new Date(Date.now() + 1_800_000).toISOString(),
  },
  delivery: null,
  availability: { available_units: 3 },
};

const paidStatus = {
  ...pendingStatus,
  status: 'paid',
  payment_status: 'approved',
  delivery_status: 'ready',
  paid_at: '2026-10-31T00:05:00.000Z',
  delivery: {
    id: 'd1',
    status: 'active',
    created_at: '2026-10-31T00:05:00.000Z',
    url: 'http://localhost:5173/entrega/token-privado-123',
  },
};

function stubBackend(payload: unknown, status = 200) {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://exemplo.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'chave-anon');
  vi.stubEnv('VITE_BACKEND_ENABLED', 'true');
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  window.sessionStorage.clear();
  savePendingOrder({ orderId: ORDER_ID, clientToken: 'token-cliente', reference: 'PS-ABC123', createdAt: new Date().toISOString() });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe('tela de pagamento PIX', () => {
  it('mostra QR code, copia-e-cola e validade a partir do backend', async () => {
    stubBackend(pendingStatus);
    render(
      <MemoryRouter initialEntries={['/pagamento']}>
        <Routes><Route path="/pagamento" element={<PaymentPage />} /></Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/PS-ABC123/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByAltText(/QR code do PIX/i)).toBeInTheDocument());
    expect(screen.getByLabelText(/PIX copia-e-cola/i)).toHaveValue(pendingStatus.payment.qr_code);
    expect(screen.getByRole('timer')).toHaveTextContent(/Expira em/);
    expect(screen.getByText(/Aguardando o pagamento PIX/i)).toBeInTheDocument();
  });

  it('libera o link de entrega quando o pagamento é aprovado', async () => {
    stubBackend(paidStatus);
    render(
      <MemoryRouter initialEntries={['/pagamento']}>
        <Routes><Route path="/pagamento" element={<PaymentPage />} /></Routes>
      </MemoryRouter>,
    );

    const link = await screen.findByRole('link', { name: /Abrir entrega privada/i });
    expect(link).toHaveAttribute('href', '/entrega/token-privado-123');
  });

  it('explica quando o pedido pendente não existe nesta sessão', async () => {
    stubBackend(pendingStatus);
    window.sessionStorage.clear();
    render(
      <MemoryRouter initialEntries={['/pagamento']}>
        <Routes><Route path="/pagamento" element={<PaymentPage />} /></Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: /Nenhum pedido em andamento/i })).toBeInTheDocument();
  });
});

describe('página privada de entrega', () => {
  const deliveryPayload = {
    reference: 'PS-ABC123',
    created_at: '2026-10-31T00:05:00.000Z',
    product: {
      id: 'p1',
      name: 'Produto Exemplo',
      slug: 'produto',
      instructions: 'Troque a senha no primeiro acesso.',
      access_validity_label: '30 dias',
      access_validity_days: 30,
    },
    units: [{ email: 'conta@exemplo.com', password: 'senha-super-secreta', notes: 'perfil 1' }],
  };

  it('mascara as credenciais até o clique explícito', async () => {
    stubBackend(deliveryPayload);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/entrega/token-privado-123']}>
        <Routes><Route path="/entrega/:token" element={<DeliveryPage />} /></Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Produto Exemplo' })).toBeInTheDocument();
    expect(screen.queryByText('conta@exemplo.com')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Mostrar dados/i }));
    expect(screen.getByText('conta@exemplo.com')).toBeInTheDocument();
    expect(screen.getByText('senha-super-secreta')).toBeInTheDocument();
  });

  it('informa quando o link foi revogado', async () => {
    stubBackend({ error: 'delivery_unavailable', message: 'Esta entrega não está disponível.' }, 410);
    render(
      <MemoryRouter initialEntries={['/entrega/token-revogado']}>
        <Routes><Route path="/entrega/:token" element={<DeliveryPage />} /></Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: /Entrega indisponível/i })).toBeInTheDocument();
    expect(screen.getByText(/revogado/i)).toBeInTheDocument();
  });
});
