import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { catalogService } from '../services/catalogService';
import { getCartLines, getCartTotals, normalizeProductQuantity } from '../lib/cart';
import type { CartEntry, CartLine } from '../types';

const STORAGE_KEY = 'prime-store-demo-cart-v1';

interface CartContextValue {
  entries: CartEntry[];
  lines: CartLine[];
  count: number;
  subtotalCents: number;
  totalCents: number;
  addItem: (productId: string, quantity?: number) => boolean;
  setQuantity: (productId: string, quantity: number) => void;
  removeItem: (productId: string) => void;
  clearCart: () => void;
}

const CartContext = createContext<CartContextValue | null>(null);

function readStoredCart(): CartEntry[] {
  if (typeof window === 'undefined') return [];

  try {
    const rawValue = window.localStorage.getItem(STORAGE_KEY);
    if (!rawValue) return [];
    const parsed: unknown = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) return [];

    const entries = parsed.flatMap((item: unknown) => {
      if (!item || typeof item !== 'object') return [];
      const candidate = item as { productId?: unknown; quantity?: unknown };
      if (typeof candidate.productId !== 'string' || typeof candidate.quantity !== 'number') return [];
      return [{ productId: candidate.productId, quantity: candidate.quantity }];
    });

    // Only product IDs and quantities are persisted; resolve against the current catalog.
    return getCartLines(entries).map(({ productId, quantity }) => ({ productId, quantity }));
  } catch {
    return [];
  }
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<CartEntry[]>(readStoredCart);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // The cart continues to work in memory if browser storage is unavailable.
    }
  }, [entries]);

  const addItem = useCallback((productId: string, quantity = 1): boolean => {
    const product = catalogService.getById(productId);
    if (!product || !product.available) return false;

    const toAdd = product.allowQuantity ? normalizeProductQuantity(product, quantity) : 1;
    const maxQuantity = product.allowQuantity ? (product.maxQuantity ?? 10) : 1;

    setEntries((previous) => {
      const currentQuantity = previous
        .filter((entry) => entry.productId === productId)
        .reduce((sum, entry) => sum + normalizeProductQuantity(product, entry.quantity), 0);
      const nextQuantity = Math.min(maxQuantity, currentQuantity + toAdd);
      return [
        ...previous.filter((entry) => entry.productId !== productId),
        { productId, quantity: nextQuantity },
      ];
    });

    return true;
  }, []);

  const setQuantity = useCallback((productId: string, quantity: number) => {
    const product = catalogService.getById(productId);
    if (!product || !product.allowQuantity || !Number.isFinite(quantity)) return;
    const safeQuantity = normalizeProductQuantity(product, quantity);
    setEntries((previous) => {
      if (!previous.some((entry) => entry.productId === productId)) return previous;
      return [
        ...previous.filter((entry) => entry.productId !== productId),
        { productId, quantity: safeQuantity },
      ];
    });
  }, []);

  const removeItem = useCallback((productId: string) => {
    setEntries((previous) => previous.filter((entry) => entry.productId !== productId));
  }, []);

  const clearCart = useCallback(() => setEntries([]), []);

  const lines = useMemo(() => getCartLines(entries), [entries]);
  const totals = useMemo(() => getCartTotals(lines), [lines]);
  const count = useMemo(() => lines.reduce((sum, line) => sum + line.quantity, 0), [lines]);

  const value = useMemo<CartContextValue>(() => ({
    entries,
    lines,
    count,
    subtotalCents: totals.subtotalCents,
    totalCents: totals.totalCents,
    addItem,
    setQuantity,
    removeItem,
    clearCart,
  }), [entries, lines, count, totals.subtotalCents, totals.totalCents, addItem, setQuantity, removeItem, clearCart]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const context = useContext(CartContext);
  if (!context) throw new Error('useCart precisa ser usado dentro de CartProvider.');
  return context;
}
