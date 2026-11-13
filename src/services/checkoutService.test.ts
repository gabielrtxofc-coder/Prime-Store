import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendError } from './backend/http';
import { submitCheckout } from './checkoutService';
import { createOrder, type CreateOrderResult } from './orderService';
import { createPurchaseRequest, type PurchaseRequestResult } from './requestService';

/**
 * Estratégia do checkout final:
 *   - com provedor configurado → fluxo de cobrança (`kind: 'payment'`);
 *   - servidor responde `payment_mode: 'request'` → solicitação sem pagamento;
 *   - `503 payment_not_configured` (função legada sem flag) → fallback local
 *     para `order-request`;
 *   - qualquer outro erro é repassado — nunca mascarado.
 */

vi.mock('./orderService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./orderService')>();
  return { ...actual, createOrder: vi.fn() };
});

vi.mock('./requestService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./requestService')>();
  return { ...actual, createPurchaseRequest: vi.fn() };
});

const createOrderMock = vi.mocked(createOrder);
const createRequestMock = vi.mocked(createPurchaseRequest);

const input = {
  items: [{ productId: '11111111-1111-4111-8111-111111111111', quantity: 2 }],
  buyerName: 'Maria Souza',
  buyerEmail: 'maria@exemplo.com',
  idempotencyKey: 'chave-de-idempotencia-0001',
  clientToken: 'token-de-checkout-AAAAAAAAAAAAAAAAAAAA',
};

const paymentResult: CreateOrderResult = {
  order: {
    order_id: '22222222-2222-4222-8222-222222222222',
    reference: 'PS-PAG01',
    status: 'pending_payment',
    payment_status: 'pending',
    delivery_status: 'not_ready',
    items_count: 1,
    quantity: 2,
    unit_price_cents: 4990,
    total_cents: 9980,
    reservation_expires_at: new Date(Date.now() + 1_800_000).toISOString(),
    created_at: new Date().toISOString(),
    idempotent_replay: false,
  },
  client_token: input.clientToken,
  payment: {
    status: 'pending',
    qr_code: '000201BR-GOV-BCB-PIX-copia-e-cola',
    qr_code_base64: 'data:image/png;base64,AAAA',
    ticket_url: null,
    expires_at: new Date(Date.now() + 1_800_000).toISOString(),
  },
};

const requestResult: PurchaseRequestResult = {
  order: {
    order_id: '33333333-3333-4333-8333-333333333333',
    reference: 'PS-SOL01',
    status: 'requested',
    payment_status: 'not_required',
    delivery_status: 'not_ready',
    items_count: 1,
    quantity: 2,
    unit_price_cents: 4990,
    total_cents: 9980,
    buyer_name: 'Maria Souza',
    created_at: new Date().toISOString(),
    items: [],
  },
  client_token: input.clientToken,
  idempotent_replay: false,
};

beforeEach(() => {
  createOrderMock.mockReset();
  createRequestMock.mockReset();
});

describe('submitCheckout — estratégia cobrança com fallback', () => {
  it('devolve kind payment quando o servidor criou a cobrança', async () => {
    createOrderMock.mockResolvedValue(paymentResult);

    const outcome = await submitCheckout(input);

    expect(outcome.kind).toBe('payment');
    if (outcome.kind === 'payment') expect(outcome.result.payment?.qr_code).toContain('copia-e-cola');
    // O flag de fallback é sempre enviado: quem decide é o servidor.
    expect(createOrderMock.mock.calls[0][0].fallbackToRequest).toBe(true);
    expect(createOrderMock.mock.calls[0][0].items).toHaveLength(1);
    expect(createRequestMock).not.toHaveBeenCalled();
  });

  it('devolve kind request quando o servidor registra a solicitação sem pagamento', async () => {
    createOrderMock.mockResolvedValue({
      ...paymentResult,
      order: { ...paymentResult.order, status: 'requested', payment_status: 'not_required' },
      payment: null,
      payment_mode: 'request',
      idempotent_replay: false,
    });

    const outcome = await submitCheckout(input);

    expect(outcome.kind).toBe('request');
    if (outcome.kind === 'request') expect(outcome.result.order.status).toBe('requested');
    expect(createRequestMock).not.toHaveBeenCalled();
  });

  it('cai para order-request quando a função responde 503 payment_not_configured', async () => {
    createOrderMock.mockRejectedValue(
      new BackendError(503, 'payment_not_configured', 'Pagamento indisponível.'),
    );
    createRequestMock.mockResolvedValue(requestResult);

    const outcome = await submitCheckout(input);

    expect(outcome.kind).toBe('request');
    if (outcome.kind === 'request') expect(outcome.result.order.reference).toBe('PS-SOL01');
    expect(createRequestMock).toHaveBeenCalledTimes(1);
    // A solicitação de fallback reutiliza a MESMA identidade da tentativa.
    expect(createRequestMock.mock.calls[0][0].clientToken).toBe(input.clientToken);
    expect(createRequestMock.mock.calls[0][0].idempotencyKey).toBe(input.idempotencyKey);
  });

  it('repassa qualquer outro erro (conflito, estoque, rede) sem mascarar', async () => {
    const conflict = new BackendError(409, 'idempotency_conflict', 'conflito');
    createOrderMock.mockRejectedValue(conflict);

    await expect(submitCheckout(input)).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(createRequestMock).not.toHaveBeenCalled();
  });

  it('não faz fallback quando o erro não é de configuração de pagamento', async () => {
    createOrderMock.mockRejectedValue(
      new BackendError(409, 'insufficient_stock', 'Estoque insuficiente.'),
    );

    await expect(submitCheckout(input)).rejects.toMatchObject({ code: 'insufficient_stock' });
    expect(createRequestMock).not.toHaveBeenCalled();
  });
});
