import type { Product } from '../types';
import { getBackendConfig } from './backend/config';
import { parseCatalogResponse } from './backend/catalogAdapter';
import { invokeFunction } from './backend/http';

export type CatalogSource = 'idle' | 'loading' | 'live' | 'error' | 'not_configured';

interface CatalogState {
  source: CatalogSource;
  lastError: string | null;
  lastSyncedAt: string | null;
}

export interface CatalogCategory {
  id: string;
  label: string;
  count: number;
}

/**
 * Repositório do catálogo.
 *
 * Missão 08: o catálogo é SEMPRE o do backend. Não existe mais array fictício
 * como reserva — se o backend não responder, a loja mostra erro (com ação de
 * recarregar) em vez de produtos inventados. O snapshot é guardado em memória
 * só para evitar uma requisição por componente; `refresh()` é a única porta de
 * entrada de dados.
 */
let currentProducts: Product[] = [];
let state: CatalogState = { source: 'idle', lastError: null, lastSyncedAt: null };
let snapshotVersion = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Idade máxima considerada "fresca" para um carregamento implícito. */
const STALE_AFTER_MS = 15_000;

function setState(next: Partial<CatalogState>): void {
  state = { ...state, ...next };
  snapshotVersion += 1;
  for (const listener of listeners) listener();
}

function isFresh(): boolean {
  if (state.source !== 'live' || !state.lastSyncedAt) return false;
  const syncedAt = Date.parse(state.lastSyncedAt);
  return Number.isFinite(syncedAt) && Date.now() - syncedAt < STALE_AFTER_MS;
}

export const catalogService = {
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

  /** Categorias presentes no catálogo atual, com a contagem de produtos. */
  getCategories(): CatalogCategory[] {
    const byId = new Map<string, CatalogCategory>();
    for (const product of currentProducts) {
      const id = product.categoryId || 'other';
      const label = product.categoryLabel?.trim() || id;
      const current = byId.get(id);
      if (current) current.count += 1;
      else byId.set(id, { id, label, count: 1 });
    }
    return Array.from(byId.values()).sort((first, second) => first.label.localeCompare(second.label, 'pt-BR'));
  },

  /**
   * Injeta um snapshot pronto.
   *
   * Usado APENAS por testes automatizados (nenhuma tela chama este método):
   * permite exercitar carrinho/checkout sem rede. Não é uma fonte de catálogo.
   */
  setSnapshot(products: Product[]): void {
    currentProducts = products;
    setState({ source: 'live', lastError: null, lastSyncedAt: new Date().toISOString() });
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
   * Busca o catálogo real.
   *
   * Nunca lança: a falha vira estado (`error` / `not_configured`) para a
   * interface exibir a mensagem certa. Em caso de erro, o snapshot anterior é
   * mantido apenas como cache de exibição — nunca como catálogo substituto de
   * um ambiente sem backend.
   */
  async refresh(): Promise<void> {
    const config = getBackendConfig();
    if (!config.enabled) {
      currentProducts = [];
      setState({ source: 'not_configured', lastError: 'backend_not_configured', lastSyncedAt: null });
      return;
    }
    if (inflight) return inflight;

    setState({ source: 'loading', lastError: null });
    inflight = (async () => {
      try {
        const payload = await invokeFunction<unknown>('catalog', { method: 'GET' });
        const parsed = parseCatalogResponse(payload);
        currentProducts = parsed.products;
        setState({
          source: 'live',
          lastError: null,
          lastSyncedAt: parsed.generatedAt ?? new Date().toISOString(),
        });
      } catch (error) {
        // Mantém o último snapshot conhecido apenas como cache de exibição: as
        // telas mostram o erro no lugar da lista, mas o carrinho não fica vazio
        // por causa de uma falha momentânea de rede. Nada é inventado.
        setState({
          source: 'error',
          lastError: error instanceof Error ? error.message : 'catalog_unavailable',
          lastSyncedAt: null,
        });
      } finally {
        inflight = null;
      }
    })();

    return inflight;
  },

  /**
   * Carrega apenas se necessário (primeira visita ou snapshot antigo).
   * Nunca repete uma tentativa que acabou de falhar: quem decide tentar de novo
   * é a interface, pelo botão "Tentar novamente".
   */
  async ensureLoaded(): Promise<void> {
    if (state.source === 'loading') return;
    if (isFresh()) return;
    if (state.source === 'error' && currentProducts.length === 0) return;
    await catalogService.refresh();
  },

  /** Limpa o snapshot (usado nos testes e ao trocar de ambiente). */
  reset(): void {
    currentProducts = [];
    state = { source: 'idle', lastError: null, lastSyncedAt: null };
    snapshotVersion += 1;
    inflight = null;
    for (const listener of listeners) listener();
  },
};

export type CatalogService = typeof catalogService;
