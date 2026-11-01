/**
 * CORS restrito a origens autorizadas.
 *
 * Antes: todas as Edge Functions respondiam com
 * `Access-Control-Allow-Origin: *`, ou seja, qualquer site podia chamar a loja
 * em nome do visitante (o `apikey` anon é público). Nada aqui autentica o
 * chamador — por isso a política precisa ser explícita.
 *
 * Regras:
 *  - só devolve `Access-Control-Allow-Origin` para a origem **exata** da lista;
 *  - a lista vem de `ALLOWED_ORIGINS` (separada por vírgula) + origem de
 *    `STORE_URL`; sem lista, nenhuma origem cruzada é liberada (fecha por padrão);
 *  - responde `Vary: Origin` para que caches não sirvam a resposta de uma
 *    origem para outra;
 *  - requisições sem `Origin` (servidor a servidor, como o webhook do provedor
 *    de pagamento) não recebem cabeçalho de CORS — nada muda para elas.
 */

import type { AppConfig } from './config.ts';

const ALLOW_HEADERS = 'authorization, x-client-info, apikey, content-type';
const ALLOW_METHODS = 'GET, POST, OPTIONS';
const MAX_AGE = '86400';

/** Normaliza para `scheme://host[:port]` minúsculo; `null` quando inválida. */
export function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  // O navegador envia literalmente "null" para origens opacas (file:// etc.).
  if (!trimmed || trimmed === 'null') return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

/** Lista efetiva de origens aceitas (sem duplicatas, normalizada). */
export function allowedOrigins(config: AppConfig): string[] {
  const values = [...(config.allowedOrigins ?? []), config.storeUrl]
    .map(normalizeOrigin)
    .filter((value): value is string => value !== null);
  return [...new Set(values)];
}

/** Origem da requisição, ou `null` se não estiver autorizada. */
export function resolveAllowedOrigin(request: Request, config: AppConfig): string | null {
  const origin = normalizeOrigin(request.headers.get('origin'));
  if (!origin) return null;
  return allowedOrigins(config).includes(origin) ? origin : null;
}

/** Cabeçalhos de CORS para esta requisição (sem `Allow-Origin` quando negada). */
export function corsHeaders(request: Request, config: AppConfig): Record<string, string> {
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Allow-Methods': ALLOW_METHODS,
    'Access-Control-Max-Age': MAX_AGE,
  };
  const origin = resolveAllowedOrigin(request, config);
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

/**
 * Aplica a política de CORS na resposta final de qualquer função.
 *
 * É chamado no `index.ts` de cada Edge Function para que a decisão dependa da
 * requisição (origem) e não de uma constante global.
 */
export function withCors(request: Request, response: Response, config: AppConfig): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders(request, config))) {
    headers.set(name, value);
  }
  if (!resolveAllowedOrigin(request, config)) {
    headers.delete('Access-Control-Allow-Origin');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
