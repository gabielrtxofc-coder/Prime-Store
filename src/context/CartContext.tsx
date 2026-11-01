import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { catalogService } from '../services/catalogService';
import {
  getCartLines,
  getCartPriceChanges,
  getCartTotals,
  getUnavailableCartItems,
  maxOrderableQuantity,
  normalizeProductQuantity,
  type CartPriceChange,
  type UnavailableCartItem,
} from '../lib/cart';
import type { CartEntry, CartLine } from '../types';

/** Chave de armazenamento do carrinho (persiste entre reloads e navegação). */
const STORAGE_KEY = 'prime-store-cart-v2';
const LEGACY_STORAGE_KEY = 'prime-store-demo-cart-v1';

export interface AddItemResult {
  added: boolean;
  /** Quantidade efetivamente colocada no carrinho (pode ser limitada). */
  quantity: number;
  /** Motivo quando `added` é false. */
  reason?: 'unavailable' | 'limit_reached' | 'unknown_product';
}

interface CartContextValue {
  entries: CartEntry[];
  /** Linhas que serão solicitadas: só produtos disponíveis, com o preço atual. */
  lines: CartLine[];
  /** Itens do carrinho que não podem mais ser solicitados. */
  unavailableItems: UnavailableCartItem[];
  /** Produtos cujo preço mudou desde que foram adicionados. */
  priceChanges: CartPriceChange[];
  /** Quantidade total de itens solicitáveis. */
  count: number;
  subtotalCents: number;
  totalCents: number;
  addItem: (productId: string, quantity?: number) => AddItemResult;
  setQuantity: (productId: string, quantity: number) => void;
  removeItem: (productId: string) => void;
  clearCart: () => void;
}

const CartContext = createContext<CartContextValue | null>(null);

function readStoredCart(): CartEntry[] {
  if (typeof window === 'undefined') return [];

  const parse = (rawValue: string | null): CartEntry[] => {
    if (!rawValue) return [];
    try {
      const parsed: unknown = JSON.parse(rawValue);
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((item: unknown) => {
        if (!item || typeof item !== 'object') return [];
        const candidate = item as { productId?: unknown; quantity?: unknown; priceCents?: unknown };
        if (typeof candidate.productId !== 'string' || typeof candidate.quantity !== 'number') return [];
        return [
          {
            productId: candidate.productId,
            quantity: candidate.quantity,
            priceCents: typeof candidate.priceCents === 'number' ? candidate.priceCents : undefined,
          },
        ];
      });
    } catch {
      return [];
    }
  };

  try {
    const current = parse(window.localStorage.getItem(STORAGE_KEY));
    if (current.length > 0) return current;
    // Migração transparente do carrinho da versão anterior.
    return parse(window.localStorage.getItem(LEGACY_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<CartEntry[]>(readStoredCart);

  useEffect(() => {
    try {
      // Só identificador, quantidade e o preço de referência são gravados.
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // Sem armazenamento o carrinho continua funcionando em memória.
    }
  }, [entries]);

  const addItem = useCallback((productId: string, quantity = 1): AddItemResult => {
    const product = catalogService.getById(productId);
    if (!product) return { added: false, quantity: 0, reason: 'unknown_product' };
    if (!product.available) return { added: false, quantity: 0, reason: 'unavailable' };

    const limit = maxOrderableQuantity(product);
    const toAdd = product.allowQuantity ? Math.min(normalizeProductQuantity(product, quantity), limit) : 1;
    let effectiveQuantity = 0;

    setEntries((previous) => {
      const currentQuantity = previous
        .filter((entry) => entry.productId === productId)
        .reduce((sum, entry) => sum + (Number.isFinite(entry.quantity) ? entry.quantity : 0), 0);
      const nextQuantity = Math.min(limit, Math.max(0, currentQuantity) + toAdd);
      effectiveQuantity = nextQuantity;
      return [
        ...previous.filter((entry) => entry.productId !== productId),
        { productId, quantity: nextQuantity, priceCents: product.priceCents },
      ];
    });

    if (effectiveQuantity === 0) return { added: false, quantity: 0, reason: 'limit_reached' };
    return { added: true, quantity: effectiveQuantity };
  }, []);

  const setQuantity = useCallback((productId: string, quantity: number) => {
    const product = catalogService.getById(productId);
    if (!product || !product.allowQuantity || !Number.isFinite(quantity)) return;
    const safeQuantity = normalizeProductQuantity(product, quantity);
    setEntries((previous) => {
      if (!previous.some((entry) => entry.productId === productId)) return previous;
      const existing = previous.find((entry) => entry.productId === productId);
      return [
        ...previous.filter((entry) => entry.productId !== productId),
        { productId, quantity: safeQuantity, priceCents: existing?.priceCents ?? product.priceCents },
      ];
    });
  }, []);

  const removeItem = useCallback((productId: string) => {
    setEntries((previous) => previous.filter((entry) => entry.productId !== productId));
  }, []);

  const clearCart = useCallback(() => setEntries([]), []);

  // O carrinho é derivado do catálogo ATUAL: quando o catálogo é recarregado
  // (preço novo, produto esgotado), as linhas e os avisos são recalculados.
  const catalogVersion = useSyncExternalStore(
    (listener) => catalogService.subscribe(listener),
    () => catalogService.getSnapshot(),
    () => catalogService.getSnapshot(),
  );

  const lines = useMemo(() => getCartLines(entries), [entries, catalogVersion]);
  const unavailableItems = useMemo(() => getUnavailableCartItems(entries), [entries, catalogVersion]);
  const priceChanges = useMemo(() => getCartPriceChanges(entries), [entries, catalogVersion]);
  const totals = useMemo(() => getCartTotals(lines), [lines]);
  const count = useMemo(() => lines.reduce((sum, line) => sum + line.quantity, 0), [lines]);

  const value = useMemo<CartContextValue>(() => ({
    entries,
    lines,
    unavailableItems,
    priceChanges,
    count,
    subtotalCents: totals.subtotalCents,
    totalCents: totals.totalCents,
    addItem,
    setQuantity,
    removeItem,
    clearCart,
  }), [
    entries,
    lines,
    unavailableItems,
    priceChanges,
    count,
    totals.subtotalCents,
    totals.totalCents,
    addItem,
    setQuantity,
    removeItem,
    clearCart,
  ]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const context = useContext(CartContext);
  if (!context) throw new Error('useCart precisa ser usado dentro de CartProvider.');
  return context;
}
