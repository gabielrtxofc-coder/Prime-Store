import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { catalogService, type CatalogCategory } from '../services/catalogService';
import { getBackendConfig } from '../services/backend/config';
import type { Product } from '../types';

export type CatalogStatus = 'loading' | 'live' | 'error' | 'not_configured';

interface CatalogContextValue {
  products: Product[];
  categories: CatalogCategory[];
  status: CatalogStatus;
  error: string | null;
  /** Última sincronização bem-sucedida (ISO) — usada nas telas públicas. */
  lastSyncedAt: string | null;
  reload: () => void;
}

const CatalogContext = createContext<CatalogContextValue>({
  products: [],
  categories: [],
  status: 'loading',
  error: null,
  lastSyncedAt: null,
  reload: () => undefined,
});

/**
 * Carrega o catálogo real do backend.
 *
 * Não existe mais "modo demonstração" com produtos locais: sem backend
 * configurado a loja informa o problema em vez de exibir itens inventados.
 */
export function CatalogProvider({ children }: { children: ReactNode }) {
  useSyncExternalStore(
    (listener) => catalogService.subscribe(listener),
    () => catalogService.getSnapshot(),
    () => catalogService.getSnapshot(),
  );

  useEffect(() => {
    void catalogService.ensureLoaded();
  }, []);

  const state = catalogService.getState();
  const products = catalogService.getAll();
  const lastSyncedAt = state.lastSyncedAt;

  // Categorias e produtos são derivados do MESMO snapshot: nenhuma lista
  // estática participa da navegação.
  const categories = useMemo(() => catalogService.getCategories(), [products]);

  const reload = useCallback(() => {
    void catalogService.refresh();
  }, []);

  const backendEnabled = getBackendConfig().enabled;
  // `idle`/`loading` aparecem como carregamento; o resto é o veredito do backend.
  const status: CatalogStatus = !backendEnabled
    ? 'not_configured'
    : state.source === 'live'
      ? 'live'
      : state.source === 'error'
        ? 'error'
        : 'loading';

  const error =
    status === 'not_configured'
      ? 'A loja não está conectada ao catálogo neste ambiente.'
      : status === 'error'
        ? 'Não foi possível carregar o catálogo agora. Verifique sua conexão e tente novamente.'
        : null;

  const value = useMemo<CatalogContextValue>(
    () => ({ products, categories, status, error, lastSyncedAt, reload }),
    [products, categories, status, error, lastSyncedAt, reload],
  );

  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

export function useCatalog(): CatalogContextValue {
  return useContext(CatalogContext);
}
