import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { products as demoProducts } from '../data/products';
import { catalogService, type CatalogSource } from '../services/catalogService';
import { getBackendConfig } from '../services/backend/config';
import type { Product } from '../types';

interface CatalogContextValue {
  products: Product[];
  status: CatalogSource;
  error: string | null;
  reload: () => void;
}

const CatalogContext = createContext<CatalogContextValue>({
  products: demoProducts,
  status: 'demo',
  error: null,
  reload: () => undefined,
});

/**
 * Carrega o catálogo real uma única vez por sessão e re-renderiza as telas
 * quando o snapshot muda. Sem `VITE_BACKEND_ENABLED=true` o estado permanece
 * "demo" e os dados locais de demonstração são usados.
 */
export function CatalogProvider({ children }: { children: ReactNode }) {
  useSyncExternalStore(
    (listener) => catalogService.subscribe(listener),
    () => catalogService.getSnapshot(),
    () => catalogService.getSnapshot(),
  );

  useEffect(() => {
    if (!getBackendConfig().enabled) return;
    void catalogService.ensureLoaded();
  }, []);

  const state = catalogService.getState();
  const products = catalogService.getAll();

  const reload = useCallback(() => {
    void catalogService.refresh();
  }, []);

  const error =
    state.source === 'error'
      ? 'Não foi possível carregar o catálogo agora. Verifique a conexão e tente novamente.'
      : null;

  const value = useMemo<CatalogContextValue>(
    () => ({ products, status: state.source, error, reload }),
    [products, state.source, error, reload],
  );

  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

export function useCatalog(): CatalogContextValue {
  return useContext(CatalogContext);
}
