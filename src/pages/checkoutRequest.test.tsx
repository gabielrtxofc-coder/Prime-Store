import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckoutPage } from './CheckoutPage';
import { CartProvider } from '../context/CartContext';
import { ToastProvider } from '../context/ToastContext';
import { BackendError } from '../services/backend/http';
import { catalogService } from '../services/catalogService';
import { submitCheckout } from '../services/checkoutService';
import type { Product } from '../types';

/**
 * Limites e identidade do checkout final (cobrança PIX com fallback para
 * solicitação sem pagamento — `submitCheckout`).
 *
 *  1. Carrinho legado com mais de 10 produtos distintos é bloqueado ANTES do
 *     envio, com aviso claro — antes o cliente só descobria o limite com um
 *     422 genérico do servidor.
 *  2. `409 idempotency_conflict` renova a identidade da tentativa: sem isso o
 *     reenvio usava a mesma chave e caía sempre no mesmo conflito.
 */

vi.mock('../services/checkoutService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/checkoutService')>();
  return { ...actual, submitCheckout: vi.fn() };
});

const submitCheckoutMock = vi.mocked(submitCheckout);

function makeProduct(index: number): Product {
  return {
    id: `11111111-1111-4111-8111-${String(100000000000 + index).padStart(12, '0')}`,
    slug: `produto-checkout-${index}`,
    name: `Produto Checkout ${index}`,
    shortDescription: `Produto de teste ${index}`,
    description: `Descrição do produto de teste ${index}.`,
    imageUrl: null,
    categoryId: 'creative',
    categoryLabel: 'Design e criatividade',
    modality: 'Produto digital',
    period: '30 dias',
    priceCents: 1000 + index,
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
}

function seedCart(products: Product[]): void {
  window.localStorage.setItem(
    'prime-store-cart-v2',
    JSON.stringify(products.map((product) => ({ productId: product.id, quantity: 1, priceCents: product.priceCents }))),
  );
}

function renderCheckout() {
  return render(
    <MemoryRouter initialEntries={['/checkout']}>
      <CartProvider>
        <ToastProvider>
          <Routes>
            <Route path="/checkout" element={<CheckoutPage />} />
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
  catalogService.reset();
  submitCheckoutMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  catalogService.reset();
  window.localStorage.clear();
});

describe('checkout de solicitação — limites e identidade', () => {
  it('bloqueia o envio quando o carrinho tem mais de 10 produtos distintos', async () => {
    const products = Array.from({ length: 11 }, (_, index) => makeProduct(index));
    catalogService.setSnapshot(products);
    seedCart(products);

    const user = userEvent.setup();
    renderCheckout();

    expect(
      await screen.findByText(/Máximo de 10 produtos diferentes por solicitação/),
    ).toBeInTheDocument();

    const submit = screen.getByRole('button', { name: /Finalizar pedido/ });
    expect(submit).toBeDisabled();

    await fillForm(user);
    expect(submit).toBeDisabled();
    expect(submitCheckoutMock).not.toHaveBeenCalled();
  }, 20000);

  it('renova a identidade da tentativa depois de idempotency_conflict e conclui na segunda', async () => {
    const product = makeProduct(0);
    catalogService.setSnapshot([product]);
    seedCart([product]);

    submitCheckoutMock
      .mockRejectedValueOnce(
        new BackendError(409, 'idempotency_conflict', 'Esta tentativa já foi usada com outros dados. Inicie um novo checkout.'),
      )
      .mockResolvedValueOnce({
        kind: 'request',
        result: {
          order: {
            order_id: '22222222-2222-4222-8222-222222222222',
            reference: 'PS-M11AA',
            status: 'requested',
            payment_status: 'not_required',
            delivery_status: 'not_ready',
            items_count: 1,
            quantity: 1,
            unit_price_cents: product.priceCents,
            total_cents: product.priceCents,
            buyer_name: 'Maria Souza',
            created_at: new Date().toISOString(),
            items: [],
          },
          client_token: 'token-da-nova-tentativa-AAAAAAAAAAAAAAAAAAAA',
          idempotent_replay: false,
        },
      });

    const user = userEvent.setup();
    renderCheckout();

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /Finalizar pedido/ }));

    // A mensagem aparece no alerta do formulário E no toast — os dois são
    // caminhos legítimos de exibição.
    const conflictMessages = await screen.findAllByText(/já foi usada com outros dados/);
    expect(conflictMessages.length).toBeGreaterThanOrEqual(1);
    expect(submitCheckoutMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /Finalizar pedido/ }));

    expect(await screen.findByText('pedido-aberto')).toBeInTheDocument();
    expect(submitCheckoutMock).toHaveBeenCalledTimes(2);

    const [firstAttempt, secondAttempt] = submitCheckoutMock.mock.calls;
    expect(firstAttempt[0].idempotencyKey).not.toBe(secondAttempt[0].idempotencyKey);
    expect(firstAttempt[0].clientToken).not.toBe(secondAttempt[0].clientToken);
    await waitFor(() => expect(window.localStorage.getItem('prime-store-cart-v2')).toBe('[]'));
  }, 20000);
});
