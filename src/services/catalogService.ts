import { products as localProducts } from '../data/products';
import type { Product } from '../types';
import { getBackendConfig } from './backend/config';
import { parseCatalogResponse } from './backend/catalogAdapter';
import { invokeFunction } from './backend/http';

export type CatalogSource = 'demo' | 'loading' | 'live' | 'error';

interface CatalogState {
  source: CatalogSource;
  lastError: string | null;
  lastSyncedAt: string | null;
}

let currentProducts: Product[] = localProducts;
let state: CatalogState = { source: 'demo', lastError: null, lastSyncedAt: null };
let snapshotVersion = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setState(next: Partial<CatalogState>): void {
  state = { ...state, ...next };
  snapshotVersion += 1;
  for (const listener of listeners) listener();
}

/**
 * Repositório do catálogo.
 *
 * A leitura é síncrona (compatível com as telas existentes) e devolve o último
 * snapshot conhecido: dados locais de demonstração até o backend responder, e
 * em seguida o catálogo real. `refresh()` é quem busca o backend.
 */
export const catalogService = {
  /** Substitui o snapshot em memória (usado quando o backend responde). */
  setSnapshot(next: Product[]): void {
    currentProducts = next;
    setState({ source: 'live', lastError: null, lastSyncedAt: new Date().toISOString() });
  },

  getAll(): Product[] {
    return currentProducts;
  },

  getBySlug(slug: string): Product | undefined {
    return currentProducts.find((product) => product.slug === slug);
  },

  getById(id: string): Product | undefined {
    return currentProducts.find((product) => product.id === id);
  },

  getPriceCents(productId: string): number | undefined {
    return catalogService.getById(productId)?.priceCents;
  },

  getState(): CatalogState {
    return state;
  },

  /** Versão do snapshot para `useSyncExternalStore`. */
  getSnapshot(): number {
    return snapshotVersion;
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /**
   * Busca o catálogo real. Nunca lança: em caso de falha mantém o snapshot
   * anterior e registra o estado de erro para a interface exibir um aviso.
   */
  async refresh(): Promise<void> {
    if (!getBackendConfig().enabled) {
      setState({ source: 'demo', lastError: null });
      return;
    }
    if (inflight) return inflight;

    setState({ source: 'loading', lastError: null });
    inflight = (async () => {
      try {
        const payload = await invokeFunction<unknown>('catalog', { method: 'GET' });
        const parsed = parseCatalogResponse(payload);
        currentProducts = parsed.products;
        setState({ source: 'live', lastError: null, lastSyncedAt: parsed.generatedAt ?? new Date().toISOString() });
      } catch (error) {
        setState({
          source: 'error',
          lastError: error instanceof Error ? error.message : 'catalog_unavailable',
        });
      } finally {
        inflight = null;
      }
    })();

    return inflight;
  },

  /** Carrega apenas uma vez por sessão (evita refetch a cada navegação). */
  async ensureLoaded(): Promise<void> {
    if (state.source === 'live' || state.source === 'loading') return;
    if (state.source === 'error') return;
    await catalogService.refresh();
  },

  /** Volta aos dados locais (usado ao sair do ambiente com backend). */
  reset(): void {
    currentProducts = localProducts;
    state = { source: 'demo', lastError: null, lastSyncedAt: null };
    snapshotVersion += 1;
    inflight = null;
    for (const listener of listeners) listener();
  },
};

export type CatalogService = typeof catalogService;
