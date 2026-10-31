import { catalogService } from '../services/catalogService';
import type { CartEntry, CartLine, Product } from '../types';

export interface CartTotals {
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
}

/**
 * Normaliza a quantidade para as regras do produto.
 *
 * Quando o catálogo vem do backend (`availableUnits` presente), o limite também
 * considera a disponibilidade real — o carrinho nunca pede mais do que existe.
 * A palavra final continua sendo do servidor: esta checagem é só de interface.
 */
export function normalizeProductQuantity(product: Product, quantity: number): number {
  const integerQuantity = typeof quantity === 'number' && Number.isFinite(quantity)
    ? Math.floor(quantity)
    : 1;
  const maxQuantity = product.allowQuantity ? (product.maxQuantity ?? 10) : 1;
  const availability = typeof product.availableUnits === 'number' && product.availableUnits > 0
    ? product.availableUnits
    : maxQuantity;
  return Math.max(1, Math.min(integerQuantity, maxQuantity, availability));
}

/** Resolve and consolidate cart entries against the current catalog. */
export function getCartLines(entries: CartEntry[], catalog: Product[] = catalogService.getAll()): CartLine[] {
  if (!Array.isArray(entries)) return [];

  const catalogById = new Map(catalog.map((product) => [product.id, product]));
  const quantitiesById = new Map<string, number>();

  for (const entry of entries) {
    if (!entry || typeof entry.productId !== 'string') continue;
    const product = catalogById.get(entry.productId);
    if (!product || !product.available) continue;

    const entryQuantity = normalizeProductQuantity(product, entry.quantity);
    const accumulatedQuantity = (quantitiesById.get(product.id) ?? 0) + entryQuantity;
    quantitiesById.set(product.id, normalizeProductQuantity(product, accumulatedQuantity));
  }

  return Array.from(quantitiesById, ([productId, quantity]) => {
    const product = catalogById.get(productId)!;
    const unitPriceCents = product.priceCents;
    return {
      productId,
      quantity,
      product,
      unitPriceCents,
      subtotalCents: unitPriceCents * quantity,
    };
  });
}

export function getCartTotals(lines: CartLine[]): CartTotals {
  const subtotalCents = lines.reduce((sum, line) => sum + line.subtotalCents, 0);
  // The demo intentionally has no active discount, tax, or checkout fee.
  const discountCents = 0;
  return {
    subtotalCents,
    discountCents,
    totalCents: subtotalCents - discountCents,
  };
}
