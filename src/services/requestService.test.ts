import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPurchaseRequest, isOrderId, isOrderReference } from './requestService';
import { invokeFunction } from './backend/http';

/**
 * Missão 11 — Grupo D (autenticação/segurança): contrato de saída do cliente
 * de solicitação de compra.
 *
 * A regra de ouro do checkout é que o NAVEGADOR não envia preço, total,
 * situação nem nada que o servidor deva decidir: apenas identidade dos itens
 * (`product_id` + `quantity`) e dados do comprador. O valor oficial é relido
 * no banco (`products.price_cents`). Este teste trava o payload enviado —
 * qualquer regressão que comece a transmitir preço do carrinho (manipulável
 * no localStorage) falha aqui, antes de qualquer teste de servidor.
 */

vi.mock('./backend/http', () => ({
  invokeFunction: vi.fn(),
  BackendError: class BackendError extends Error {
    status: number;
    code: string;
    details: Record<string, unknown>;
    constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
      super(message);
      this.status = status;
      this.code = code;
      this.details = details;
    }
  },
  describeBackendError: (error: unknown) => String(error),
}));

const invokeMock = vi.mocked(invokeFunction);

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({
    order: { order_id: '00000000-0000-4000-8000-000000000001' },
    client_token: 'tok',
    idempotent_replay: false,
  } as never);
});

describe('createPurchaseRequest — payload sem qualquer campo de preço', () => {
  it('envia somente product_id/quantity nos itens e nenhum campo de valor', async () => {
    await createPurchaseRequest({
      items: [
        { productId: 'aaaaaaaa-0000-4000-8000-000000000001', quantity: 2 },
        { productId: 'bbbbbbbb-0000-4000-8000-000000000002', quantity: 1 },
      ],
      buyerName: 'Cliente Seguro',
      buyerEmail: 'cliente@exemplo.test',
      idempotencyKey: 'chave-idempotente-segura-0001',
      clientToken: 'token-privado-do-cliente',
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [functionName, options] = invokeMock.mock.calls[0] as [
      string,
      { body: Record<string, unknown> },
    ];
    expect(functionName).toBe('order-request');

    const body = options.body;
    expect(Object.keys(body).sort()).toEqual([
      'buyer_email',
      'buyer_name',
      'client_token',
      'idempotency_key',
      'items',
    ]);

    const items = body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(['product_id', 'quantity']);
    }

    // Nenhum campo de preço/total/status em lugar nenhum do payload.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/price|preco|total|subtotal|status|payment/i);
  });

  it('não envia Authorization (a solicitação é pública e sem sessão)', async () => {
    await createPurchaseRequest({
      items: [{ productId: 'aaaaaaaa-0000-4000-8000-000000000001', quantity: 1 }],
      buyerName: 'Cliente Seguro',
      buyerEmail: 'cliente@exemplo.test',
      idempotencyKey: 'chave-idempotente-segura-0002',
      clientToken: 'token-privado-do-cliente',
    });

    const [, options] = invokeMock.mock.calls[0] as [string, { accessToken?: string | null }];
    expect(options.accessToken ?? null).toBeNull();
  });
});

describe('validação de identificadores de pedido (entrada)', () => {
  it('aceita apenas UUID no formato canônico', () => {
    expect(isOrderId('aaaaaaaa-0000-4000-8000-000000000001')).toBe(true);
    expect(isOrderId('AAAAAAAA-0000-4000-8000-000000000001')).toBe(true);
  });

  it('recusa entradas maliciosas ou malformadas', () => {
    expect(isOrderId('')).toBe(false);
    expect(isOrderId("1'; drop table orders; --")).toBe(false);
    expect(isOrderId('aaaa-0000-4000-8000-000000000001')).toBe(false);
    expect(isOrderId('../../admin')).toBe(false);
    expect(isOrderId('00000000000040008000000000000001')).toBe(false);
  });

  it('aceita referência PS- apenas com 6 caracteres alfanuméricos maiúsculos', () => {
    expect(isOrderReference('PS-ABC123')).toBe(true);
    expect(isOrderReference(' ps-abc123 ')).toBe(true); // normaliza caixa e espaço
    expect(isOrderReference('PS-ABC12')).toBe(false);
    expect(isOrderReference('PS-ABC1234')).toBe(false);
    expect(isOrderReference("PS-ABC123' or 1=1 --")).toBe(false);
    expect(isOrderReference('')).toBe(false);
    expect(isOrderReference('XX-ABC123')).toBe(false);
  });
});
