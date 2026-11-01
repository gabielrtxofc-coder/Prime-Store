import type { Deps } from '../deps.ts';
import { errorResponse, json, methodGuard, preflight } from '../http.ts';
import { mapCatalogProduct, type CatalogRow } from '../mappers.ts';

/**
 * Libera reservas vencidas antes de anunciar disponibilidade.
 *
 * Correção da auditoria da missão 06. A expiração é "preguiçosa": só acontece
 * quando alguém chama `expire_overdue_reservations` (criação de pedido e
 * consulta de status). Só que o botão de compra da loja fica desabilitado
 * quando `available_units` é 0 — então, depois de um checkout abandonado, o
 * cliente não conseguia nem iniciar o pedido que liberaria a unidade, e o
 * produto ficava "esgotado" no catálogo indefinidamente (unidade presa em
 * `reserved`). Expirar aqui fecha esse ciclo sem depender de tráfego na rota de
 * checkout.
 */
async function releaseExpiredReservations(deps: Deps): Promise<void> {
  try {
    await deps.rpc('expire_overdue_reservations', { p_product_id: null });
  } catch (error) {
    // O catálogo é leitura pública: uma falha de limpeza não pode derrubar a
    // vitrine. A próxima requisição tenta de novo.
    deps.log('catalog.expire_failed', {
      reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    });
  }
}

/** GET/POST /catalog — catálogo público (somente produtos ativos). */
export async function handleCatalog(request: Request, deps: Deps): Promise<Response> {
  if (request.method === 'OPTIONS') return preflight();

  try {
    methodGuard(request, ['GET', 'POST']);

    await releaseExpiredReservations(deps);

    const url = new URL(request.url);
    let search = url.searchParams.get('q');
    let category = url.searchParams.get('category');

    if (request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { q?: unknown; category?: unknown };
      if (typeof body.q === 'string') search = body.q.slice(0, 120);
      if (typeof body.category === 'string') category = body.category.slice(0, 40);
    }

    const data = await deps.rpc<{ products: CatalogRow[]; generated_at: string }>('get_catalog', {
      p_search: search?.trim() || null,
      p_category: category?.trim() || null,
    });

    return json({
      products: (data.products ?? []).map(mapCatalogProduct),
      generated_at: data.generated_at ?? deps.now().toISOString(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
