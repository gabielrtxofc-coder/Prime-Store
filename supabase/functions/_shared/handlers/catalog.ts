import type { Deps } from '../deps.ts';
import { errorResponse, json, methodGuard, preflight } from '../http.ts';
import { mapCatalogProduct, type CatalogRow } from '../mappers.ts';

/** GET/POST /catalog — catálogo público (somente produtos ativos). */
export async function handleCatalog(request: Request, deps: Deps): Promise<Response> {
  if (request.method === 'OPTIONS') return preflight();

  try {
    methodGuard(request, ['GET', 'POST']);

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
