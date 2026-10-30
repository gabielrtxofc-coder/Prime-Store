import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { DemoOrder } from '../types';

interface OrderContextValue {
  currentOrder: DemoOrder | null;
  setCurrentOrder: (order: DemoOrder | null) => void;
}

const OrderContext = createContext<OrderContextValue | null>(null);

export function OrderProvider({ children }: { children: ReactNode }) {
  const [currentOrder, setCurrentOrder] = useState<DemoOrder | null>(null);
  const value = useMemo(() => ({ currentOrder, setCurrentOrder }), [currentOrder]);
  return <OrderContext.Provider value={value}>{children}</OrderContext.Provider>;
}

export function useDemoOrder(): OrderContextValue {
  const context = useContext(OrderContext);
  if (!context) throw new Error('useDemoOrder precisa ser usado dentro de OrderProvider.');
  return context;
}
