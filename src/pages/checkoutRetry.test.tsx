import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { CatalogProvider } from '../context/CatalogContext';
import { CartProvider } from '../context/CartContext';
import { OrderProvider } from '../context/OrderContext';
import { ToastProvider } from '../context/ToastContext';
import { BackendError } from '../services/backend/http';
import { catalogService } from '../services/catalogService';
import { createOrder, type CreateOrderResult } from '../services/orderService';

/**
 * Missão 06 — retry do checkout depois de uma tentativa encerrada.
 *
 * O servidor responde `409 previous_attempt_closed` quando o pedido original já
 * morreu (falha na cobrança, reserva vencida ou cancelamento). O formulário
 * precisa renovar a identidade do checkout e tentar de novo; antes da correção
 * o retry reenviava a mesma chave e caía sempre no mesmo pedido encerrado.
 */

vi.mock('../services/orderService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/orderService')>();
  return { ...actual, createOrder: vi.fn() };
});

const product = {
  id: '22222222-2222-4222-8222-222222222222',
  slug: 'produto-do-retry',
  name: 'Produto do Retry',
  shortDescription: 'Produto usado no teste de retry',
  description: 'Descrição do produto usado no teste de retry.',
  imageUrl: null,
  categoryId: 'creative',
  categoryLabel: 'Design e criatividade',
  modality: 'Produto digital',
  period: '30 dias',
  priceCents: 2990,
  accessValidityDays: 30,
  accessValidityLabel: '30 dias',
  instructions: 'Instruções de acesso.',
  conditions: [],
  delivery: ['Entrega imediata após a confirmação do pagamento.'],
  monogram: 'R',
  theme: 'violet' as const,
  maxQuantity: 2,
  allowQuantity: true,
  featured: false,
  availableUnits: 2,
  available: true,
};

const successPayload: CreateOrderResult = {
  order: {
    order_id: '33333333-3333-4333-8333-333333333333',
    reference: 'PS-RETRY1',
    status: 'pending_payment',
    payment_status: 'pending',
    delivery_status: 'not_ready',
    quantity: 1,
    unit_price_cents: 2990,
    total_cents: 2990,
    reservation_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    idempotent_replay: false,
  },
  client_token: 'token-novo-do-checkout-AAAAAAAAAAAAAAAAAAAAAAA',
  payment: null,
  payment_mode: 'demo',
};

function renderCheckout() {
  return render(
    <MemoryRouter initialEntries={['/checkout']}>
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

async function fillCheckout() {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Nome completo'), 'Comprador de Teste');
  await user.type(screen.getByLabelText('E-mail'), 'comprador@teste.com');
  await user.type(screen.getByLabelText('Confirme seu e-mail'), 'comprador@teste.com');
  await user.click(screen.getByRole('checkbox'));
  return user;
}

beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://exemplo.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'chave-anon');
  vi.stubEnv('VITE_BACKEND_ENABLED', 'true');
  // Catálogo em memória com um produto: o carrinho lê o snapshot ao montar.
  catalogService.setSnapshot([{ ...product }]);
  window.localStorage.setItem(
    'prime-store-demo-cart-v1',
    JSON.stringify([{ productId: product.id, quantity: 1 }]),
  );
  // A tela de pagamento consulta o pedido; o teste não depende da rede.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"not_found"}', { status: 404 })));
  vi.mocked(createOrder).mockReset();
});

afterEach(() => {
  catalogService.reset();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('checkout com tentativa anterior encerrada', () => {
  it('renova a identidade do checkout e conclui na segunda tentativa', async () => {
    vi.mocked(createOrder)
      .mockRejectedValueOnce(new BackendError(409, 'previous_attempt_closed', 'encerrada'))
      .mockResolvedValueOnce(successPayload);

    renderCheckout();
    const user = await fillCheckout();
    await user.click(screen.getByRole('button', { name: /Reservar unidades/i }));

    await waitFor(() => expect(createOrder).toHaveBeenCalledTimes(2));

    const [first, second] = vi.mocked(createOrder).mock.calls;
    expect(first[0].idempotencyKey).toBeTruthy();
    expect(second[0].idempotencyKey).not.toBe(first[0].idempotencyKey);
    expect(second[0].clientToken).not.toBe(first[0].clientToken);
    // Mesmo produto/quantidade/e-mail: só a identidade da tentativa muda.
    expect(second[0].productId).toBe(first[0].productId);
    expect(second[0].payerEmail).toBe(first[0].payerEmail);

    await waitFor(() => {
      const pending = window.sessionStorage.getItem('prime-store.pending-order');
      expect(pending).toContain('PS-RETRY1');
    });
    // O carrinho só é limpo depois do pedido novo.
    expect(window.localStorage.getItem('prime-store-demo-cart-v1')).toBe('[]');
  });

  it('mantém a mesma identidade quando a falha é de rede (retry seguro)', async () => {
    vi.mocked(createOrder)
      .mockRejectedValueOnce(new BackendError(502, 'payment_provider_unavailable', 'indisponível'))
      .mockResolvedValueOnce(successPayload);

    renderCheckout();
    const user = await fillCheckout();
    const submit = screen.getByRole('button', { name: /Reservar unidades/i });
    await user.click(submit);

    await waitFor(() => expect(createOrder).toHaveBeenCalledTimes(1));
    // Pedido não criado: o carrinho continua intacto para o próximo clique.
    expect(window.localStorage.getItem('prime-store-demo-cart-v1')).not.toBe('[]');
    expect(window.sessionStorage.getItem('prime-store.pending-order')).toBeNull();

    await user.click(submit);
    await waitFor(() => expect(createOrder).toHaveBeenCalledTimes(2));

    const [first, second] = vi.mocked(createOrder).mock.calls;
    expect(second[0].idempotencyKey).toBe(first[0].idempotencyKey);
    expect(second[0].clientToken).toBe(first[0].clientToken);
  });
});
