import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentPage } from './PaymentPage';
import { savePendingOrder } from '../services/orderService';

/**
 * Fase D — pagamento demonstrativo no frontend.
 *
 * O que estes testes garantem:
 *  - o botão de simulação só aparece quando o SERVIDOR diz que o modo está
 *    ativo E o pedido é de um produto de demonstração;
 *  - o clique chama a Edge Function `demo-payment` (não altera estado local);
 *  - a tela deixa explícito que nenhuma cobrança real aconteceu;
 *  - sem o modo ativo, nada de simulação aparece.
 */

const ORDER_ID = '0f0e0d0c-0000-4000-8000-0000000000aa';

const pendingDemoStatus = {
  order_id: ORDER_ID,
  reference: 'PS-DEMO99',
  status: 'pending_payment',
  payment_status: 'pending',
  delivery_status: 'not_ready',
  quantity: 1,
  unit_price_cents: 2990,
  total_cents: 2990,
  created_at: '2026-10-31T00:00:00.000Z',
  paid_at: null,
  reservation_expires_at: new Date(Date.now() + 1_800_000).toISOString(),
  product: {
    id: 'p1',
    slug: 'produto-exemplo',
    name: 'Produto de exemplo',
    instructions: 'Use as credenciais entregues.',
    access_validity_label: '30 dias',
    is_demo: true,
  },
  payment: null,
  delivery: null,
  availability: { available_units: 3 },
};

const paidStatus = {
  ...pendingDemoStatus,
  status: 'paid',
  payment_status: 'approved',
  delivery_status: 'ready',
  paid_at: '2026-10-31T00:01:00.000Z',
  delivery: {
    id: 'd1',
    status: 'active',
    created_at: '2026-10-31T00:01:00.000Z',
    url: 'http://localhost:5173/entrega/token-demo-123',
  },
};

interface Route {
  match: string;
  body: unknown;
  status?: number;
}

function stubFunctions(routes: Route[]) {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://exemplo.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'chave-anon');
  vi.stubEnv('VITE_BACKEND_ENABLED', 'true');

  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const route = routes.find((item) => url.includes(item.match));
    const status = route?.status ?? 200;
    return new Response(JSON.stringify(route?.body ?? { error: 'not_found' }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

function renderPayment() {
  return render(
    <MemoryRouter initialEntries={['/pagamento']}>
      <Routes><Route path="/pagamento" element={<PaymentPage />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  savePendingOrder({
    orderId: ORDER_ID,
    clientToken: 'token-cliente-demo-0123456789abcdef',
    reference: 'PS-DEMO99',
    createdAt: new Date().toISOString(),
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe('pagamento demonstrativo no sandbox', () => {
  it('mostra o painel de simulação e deixa claro que não houve cobrança', async () => {
    stubFunctions([
      { match: 'demo-payment', body: { demo_enabled: true, mode: 'demo' } },
      { match: 'order-status', body: pendingDemoStatus },
    ]);

    renderPayment();

    expect(await screen.findByRole('button', { name: /Simular aprovação do pagamento/i })).toBeInTheDocument();
    expect(screen.getByText(/nenhuma cobrança real foi realizada/i)).toBeInTheDocument();
    expect(screen.getAllByText(/MODO DE DEMONSTRAÇÃO/i).length).toBeGreaterThan(0);
    // Nada de QR code ou copia-e-cola falsos.
    expect(screen.queryByAltText(/QR code do PIX/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/PIX copia-e-cola/i)).not.toBeInTheDocument();
  });

  it('envia a simulação ao backend e exibe a entrega liberada', async () => {
    const { fetchMock } = stubFunctions([
      {
        match: 'demo-payment',
        body: {
          demo_enabled: true,
          mode: 'demo',
          demo: true,
          result: 'approved',
          order_status: 'paid',
          payment_status: 'approved',
          delivery_status: 'ready',
        },
      },
      { match: 'order-status', body: pendingDemoStatus },
    ]);
    const user = userEvent.setup();

    renderPayment();
    const button = await screen.findByRole('button', { name: /Simular aprovação do pagamento/i });

    // Depois do clique, a próxima consulta já devolve o pedido pago.
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('demo-payment')) {
        return new Response(JSON.stringify({ demo: true, result: 'approved', order_status: 'paid' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(paidStatus), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await user.click(button);

    const link = await screen.findByRole('link', { name: /Abrir entrega privada/i });
    expect(link).toHaveAttribute('href', '/entrega/token-demo-123');

    const call = fetchMock.mock.calls.map(([input]) => String(input)).find((url) => url.includes('demo-payment'));
    expect(call).toBeDefined();
  });

  it('não oferece simulação quando o servidor informa que o modo está desligado', async () => {
    stubFunctions([
      { match: 'demo-payment', body: { demo_enabled: false, mode: 'disabled' } },
      { match: 'order-status', body: pendingDemoStatus },
    ]);

    renderPayment();

    await waitFor(() => expect(screen.getByText(/PS-DEMO99/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Simular aprovação/i })).not.toBeInTheDocument();
    expect(screen.getByText(/pagamento ainda não está configurado/i)).toBeInTheDocument();
  });

  it('explica o erro do backend sem expor detalhes técnicos', async () => {
    stubFunctions([
      { match: 'demo-payment', body: { demo_enabled: true, mode: 'demo' } },
      { match: 'order-status', body: pendingDemoStatus },
    ]);
    const user = userEvent.setup();

    renderPayment();
    const button = await screen.findByRole('button', { name: /Simular aprovação do pagamento/i });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('demo-payment')) {
        return new Response(JSON.stringify({ error: 'demo_reservation_expired', message: 'expired' }), {
          status: 410,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(pendingDemoStatus), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await user.click(button);

    expect(await screen.findByText(/reserva deste pedido expirou/i)).toBeInTheDocument();
  });
});
