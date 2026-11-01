import { catalogService } from '../services/catalogService';
import type { CartEntry, CartLine, Product } from '../types';

export interface CartTotals {
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
}

/** Item do carrinho que não pode mais ser solicitado. */
export interface UnavailableCartItem {
  productId: string;
  name: string;
  quantity: number;
  /** `unavailable`: existe no catálogo mas sem unidades; `removed`: saiu do catálogo. */
  reason: 'unavailable' | 'removed';
}

/** Produto cujo preço mudou desde que entrou no carrinho. */
export interface CartPriceChange {
  productId: string;
  name: string;
  previousCents: number;
  currentCents: number;
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

/** Limite de unidade que a interface pode oferecer para o produto. */
export function maxOrderableQuantity(product: Product): number {
  const maxQuantity = product.allowQuantity ? (product.maxQuantity ?? 10) : 1;
  const availability = typeof product.availableUnits === 'number' ? product.availableUnits : maxQuantity;
  return Math.max(1, Math.min(maxQuantity, availability));
}

/**
 * Resolve e consolida as entradas do carrinho contra o catálogo atual.
 *
 * Somente produtos disponíveis entram nas linhas cobráveis. O preço exibido é
 * SEMPRE o preço do catálogo (o mesmo que o backend usa no cálculo oficial), e
 * não o valor gravado no navegador no momento em que o item foi adicionado.
 */
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

/**
 * Itens que não podem mais ser solicitados: produto esgotado, inativo ou fora
 * do catálogo depois de ter sido adicionado ao carrinho.
 */
export function getUnavailableCartItems(
  entries: CartEntry[],
  catalog: Product[] = catalogService.getAll(),
): UnavailableCartItem[] {
  if (!Array.isArray(entries)) return [];
  const catalogById = new Map(catalog.map((product) => [product.id, product]));
  const result: UnavailableCartItem[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry.productId !== 'string') continue;
    const product = catalogById.get(entry.productId);
    const quantity = typeof entry.quantity === 'number' && entry.quantity > 0 ? Math.floor(entry.quantity) : 1;

    if (!product) {
      result.push({ productId: entry.productId, name: 'Produto removido do catálogo', quantity, reason: 'removed' });
      continue;
    }
    if (!product.available) {
      result.push({ productId: product.id, name: product.name, quantity, reason: 'unavailable' });
    }
  }

  return result;
}

/**
 * Compara o preço visto quando o item entrou no carrinho com o preço atual do
 * catálogo. Divergência é avisada na interface; o valor usado no registro é
 * sempre o do backend.
 */
export function getCartPriceChanges(
  entries: CartEntry[],
  catalog: Product[] = catalogService.getAll(),
): CartPriceChange[] {
  if (!Array.isArray(entries)) return [];
  const catalogById = new Map(catalog.map((product) => [product.id, product]));
  const changes: CartPriceChange[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry.priceCents !== 'number') continue;
    const product = catalogById.get(entry.productId);
    if (!product) continue;
    if (product.priceCents !== entry.priceCents) {
      changes.push({
        productId: product.id,
        name: product.name,
        previousCents: entry.priceCents,
        currentCents: product.priceCents,
      });
    }
  }

  return changes;
}

export function getCartTotals(lines: CartLine[]): CartTotals {
  const subtotalCents = lines.reduce((sum, line) => sum + line.subtotalCents, 0);
  // Sem desconto, taxa ou frete: o total é a soma dos itens.
  const discountCents = 0;
  return {
    subtotalCents,
    discountCents,
    totalCents: subtotalCents - discountCents,
  };
}
