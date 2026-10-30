import { getCartLines, getCartTotals } from '../lib/cart';
import type { CartEntry, DemoOrder, PaymentMethod } from '../types';

export interface CreateDemoOrderInput {
  buyerName: string;
  buyerEmail: string;
  paymentMethod: PaymentMethod;
  cart: CartEntry[];
}

let orderSequence = 0;

/**
 * Creates an in-memory demo record only. This adapter does not contact a server,
 * reserve stock, create an invoice, or confirm/charge a payment.
 */
export async function createDemoOrder(input: CreateDemoOrderInput): Promise<DemoOrder> {
  // Small local delay makes the checkout processing state visible during testing.
  await new Promise<void>((resolve) => setTimeout(resolve, 450));

  const lines = getCartLines(input.cart);
  if (lines.length === 0) throw new Error('O carrinho está vazio.');

  const totals = getCartTotals(lines);
  orderSequence += 1;

  return {
    id: `DEMO-${Date.now().toString(36).toUpperCase()}-${String(orderSequence).padStart(2, '0')}`,
    buyerName: input.buyerName.trim(),
    buyerEmail: input.buyerEmail.trim(),
    paymentMethod: input.paymentMethod,
    lines: lines.map(({ product, quantity, unitPriceCents, subtotalCents }) => ({
      productId: product.id,
      name: product.name,
      modality: product.modality,
      period: product.period,
      quantity,
      unitPriceCents,
      subtotalCents,
    })),
    subtotalCents: totals.subtotalCents,
    totalCents: totals.totalCents,
    createdAt: new Date().toISOString(),
    status: 'demo-only',
  };
}
