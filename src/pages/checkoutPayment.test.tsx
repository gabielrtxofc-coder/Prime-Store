import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckoutPage } from './CheckoutPage';
import { CartProvider } from '../context/CartContext';
import { ToastProvider } from '../context/ToastContext';
import { catalogService } from '../services/catalogService';
import { submitCheckout, type CheckoutOutcome } from '../services/checkoutService';
import { readPendingOrder } from '../services/orderService';
import { readRequestReceipt } from '../services/requestService';
import type { Product } from '../types';

/**
 * Checkout com cobrança PIX real: quando o servidor cria a cobrança, o
 * navegador grava o pedido pendente (sessão) + comprovante (local) e navega
 * para `/pagamento` — onde o QR Code e o copia-e-cola são exibidos.
 */

vi.mock('../services/checkoutService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/checkoutService')>();
  return { ...actual, submitCheckout: vi.fn() };
});

const submitCheckoutMock = vi.mocked(submitCheckout);

const product: Product = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'produto-pix',
  name: 'Produto PIX',
  shortDescription: 'Produto do fluxo de cobrança',
  description: 'Produto usado no teste do fluxo PIX.',
  imageUrl: null,
  categoryId: 'creative',
  categoryLabel: 'Design e criatividade',
  modality: 'Produto digital',
  period: '30 dias',
  priceCents: 4990,
  monogram: 'P',
  theme: 'violet',
  maxQuantity: 5,
  allowQuantity: true,
  featured: false,
  availableUnits: 5,
  available: true,
  conditions: [],
  delivery: [],
};

const paymentOutcome: CheckoutOutcome = {
  kind: 'payment',
  result: {
    order: {
      order_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      reference: 'PS-PAY01',
      status: 'pending_payment',
      payment_status: 'pending',
      delivery_status: 'not_ready',
      items_count: 1,
      quantity: 1,
      unit_price_cents: 4990,
      total_cents: 4990,
      reservation_expires_at: new Date(Date.now() + 1_800_000).toISOString(),
      created_at: '2026-11-13T12:00:00.000Z',
      idempotent_replay: false,
    },
    client_token: 'token-de-checkout-AAAAAAAAAAAAAAAAAAAA',
    payment: {
      status: 'pending',
      qr_code: '000201copia-e-cola-da-cobranca',
      qr_code_base64: 'data:image/png;base64,QUFBQQ==',
      ticket_url: null,
      expires_at: '2026-11-13T12:30:00.000Z',
    },
  },
};

function seedCart(): void {
  window.localStorage.setItem(
    'prime-store-cart-v2',
    JSON.stringify([{ productId: product.id, quantity: 1, priceCents: product.priceCents }]),
  );
}

function renderCheckout() {
  return render(
    <MemoryRouter initialEntries={['/checkout']}>
      <CartProvider>
        <ToastProvider>
          <Routes>
            <Route path="/checkout" element={<CheckoutPage />} />
            <Route path="/pagamento" element={<p>pagamento-aberto</p>} />
            <Route path="/pedido/:identifier" element={<p>pedido-aberto</p>} />
          </Routes>
        </ToastProvider>
      </CartProvider>
    </MemoryRouter>,
  );
}

async function fillForm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText('Nome completo'), 'Maria Souza');
  await user.type(screen.getByLabelText('E-mail'), 'maria@exemplo.com');
  await user.type(screen.getByLabelText('Confirme seu e-mail'), 'maria@exemplo.com');
  await user.click(screen.getByRole('checkbox'));
}

beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://exemplo.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'chave-anon');
  vi.stubEnv('VITE_BACKEND_ENABLED', 'true');
  window.localStorage.clear();
  window.sessionStorage.clear();
  catalogService.reset();
  catalogService.setSnapshot([product]);
  submitCheckoutMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  catalogService.reset();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('checkout com cobrança PIX', () => {
  it('leva para /pagamento gravando pedido pendente e comprovante', async () => {
    seedCart();
    submitCheckoutMock.mockResolvedValue(paymentOutcome);

    const user = userEvent.setup();
    renderCheckout();

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /Finalizar pedido/ }));

    expect(await screen.findByText('pagamento-aberto')).toBeInTheDocument();

    const pending = readPendingOrder();
    expect(pending?.orderId).toBe(paymentOutcome.kind === 'payment' ? paymentOutcome.result.order.order_id : '');
    expect(pending?.clientToken).toBe('token-de-checkout-AAAAAAAAAAAAAAAAAAAA');
    expect(pending?.reference).toBe('PS-PAY01');

    const receipt = readRequestReceipt('PS-PAY01');
    expect(receipt?.clientToken).toBe('token-de-checkout-AAAAAAAAAAAAAAAAAAAA');
    expect(receipt?.totalCents).toBe(4990);

    // Carrinho limpo e identidade da tentativa enviada ao servidor.
    expect(window.localStorage.getItem('prime-store-cart-v2')).toBe('[]');
    const call = submitCheckoutMock.mock.calls[0][0];
    expect(call.items).toEqual([{ productId: product.id, quantity: 1 }]);
    expect(call.buyerName).toBe('Maria Souza');
    expect(call.buyerEmail).toBe('maria@exemplo.com');
    expect(call.idempotencyKey.length).toBeGreaterThanOrEqual(16);
    expect(call.clientToken.length).toBeGreaterThanOrEqual(32);
  }, 20000);

  it('mantém a identidade da tentativa quando a falha é de rede (retry seguro)', async () => {
    seedCart();
    submitCheckoutMock
      .mockRejectedValueOnce(new Error('network_down'))
      .mockResolvedValueOnce(paymentOutcome);

    const user = userEvent.setup();
    renderCheckout();

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /Finalizar pedido/ }));
    expect(await screen.findAllByRole('alert')).not.toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /Finalizar pedido/ }));
    expect(await screen.findByText('pagamento-aberto')).toBeInTheDocument();

    const [first, second] = submitCheckoutMock.mock.calls;
    expect(first[0].idempotencyKey).toBe(second[0].idempotencyKey);
    expect(first[0].clientToken).toBe(second[0].clientToken);
  }, 20000);
});
